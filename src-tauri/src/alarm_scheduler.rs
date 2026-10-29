use crate::system_actions::{lock_screen, run_program, schedule_shutdown};
use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, Local, LocalResult, TimeZone, Timelike,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as FileMutex, MutexGuard};
use std::thread;
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

const CLOCK_RECHECK_INTERVAL: Duration = Duration::from_secs(30);
const MAX_ALARM_TASKS: usize = 200;
const MAX_TRIGGER_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_TASK_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const MAX_BACKGROUND_AUDIO: usize = 5;
const MAX_BACKGROUND_AUDIO_DURATION: Duration = Duration::from_secs(7 * 60);

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlarmConfig {
    #[serde(default)]
    pub(crate) total_seconds: Option<i64>,
    #[serde(default)]
    pub(crate) remaining_seconds: Option<i64>,
    #[serde(default)]
    pub(crate) deadline_at: Option<i64>,
    #[serde(default)]
    pub(crate) time: Option<String>,
    #[serde(default)]
    pub(crate) repeat_days: Vec<u32>,
    #[serde(default = "default_true")]
    pub(crate) repeat_enabled: bool,
    #[serde(default)]
    pub(crate) interval_ms: Option<i64>,
    #[serde(default)]
    pub(crate) next_trigger_at: Option<i64>,
    #[serde(default)]
    pub(crate) interval_value: Option<i64>,
    #[serde(default)]
    pub(crate) interval_unit: Option<String>,
    #[serde(default)]
    pub(crate) audio_path: Option<String>,
    #[serde(default)]
    pub(crate) audio_name: Option<String>,
    #[serde(default)]
    pub(crate) file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlarmTask {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) task_type: String,
    pub(crate) action: String,
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) paused: bool,
    pub(crate) config: AlarmConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TriggeredAlarm {
    #[serde(flatten)]
    task: AlarmTask,
    trigger_id: String,
    triggered_at: i64,
}

impl TriggeredAlarm {
    fn new(task: AlarmTask) -> Self {
        Self {
            task,
            trigger_id: uuid::Uuid::new_v4().to_string(),
            triggered_at: Local::now().timestamp_millis(),
        }
    }
}

#[derive(Default)]
pub(crate) struct AlarmScheduler {
    handles: Mutex<HashMap<String, JoinHandle<()>>>,
    task_sync_lock: Mutex<()>,
    quick_handles: std::sync::Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    missed_triggers: Mutex<HashMap<String, TriggeredAlarm>>,
    journal_lock: Arc<FileMutex<()>>,
    overflowed_trigger: AtomicBool,
    main_recovery_count: AtomicUsize,
    background_audio: FileMutex<HashMap<String, Arc<AtomicBool>>>,
}

pub(crate) struct MainRestoreAudioGuard<'a>(&'a AlarmScheduler);

impl Drop for MainRestoreAudioGuard<'_> {
    fn drop(&mut self) {
        self.0.main_recovery_count.fetch_sub(1, Ordering::AcqRel);
    }
}

impl AlarmScheduler {
    /// A restored WebView will replay saved triggers and own their audio. Close
    /// native audio before it appears, including the window-construction gap.
    pub(crate) fn begin_main_restore(&self) -> MainRestoreAudioGuard<'_> {
        self.main_recovery_count.fetch_add(1, Ordering::AcqRel);
        let _ = self.stop_background_audio(None);
        MainRestoreAudioGuard(self)
    }

    fn stop_background_audio(&self, task_id: Option<&str>) -> Result<bool, String> {
        let mut playing = self
            .background_audio
            .lock()
            .map_err(|_| "后台提醒音状态不可用".to_string())?;
        if let Some(task_id) = task_id {
            if let Some(cancel) = playing.remove(task_id) {
                cancel.store(true, Ordering::Release);
                return Ok(true);
            }
            return Ok(false);
        }
        let stopped = !playing.is_empty();
        for (_, cancel) in playing.drain() {
            cancel.store(true, Ordering::Release);
        }
        Ok(stopped)
    }

    #[cfg(windows)]
    fn start_background_audio(&self, app: &AppHandle, task: &AlarmTask) -> Result<(), String> {
        let path = managed_audio_path(app, task)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let task_id = task.id.clone();
        {
            let mut playing = self
                .background_audio
                .lock()
                .map_err(|_| "后台提醒音状态不可用".to_string())?;
            if self.main_recovery_count.load(Ordering::Acquire) != 0 || has_audio_frontend(app) {
                return Ok(());
            }
            if playing.len() >= MAX_BACKGROUND_AUDIO && !playing.contains_key(&task_id) {
                return Err("同时播放的后台提醒音已达到上限".to_string());
            }
            if let Some(previous) = playing.insert(task_id.clone(), cancel.clone()) {
                previous.store(true, Ordering::Release);
            }
        }
        let worker_app = app.clone();
        let worker_cancel = cancel.clone();
        let worker_id = task_id.clone();
        let started = thread::Builder::new()
            .name("dtkit-alarm-audio".into())
            .spawn(move || {
                if let Err(error) = play_background_file(&path, &worker_cancel) {
                    eprintln!("[AlarmScheduler] 后台提醒音未能播放，系统通知仍有效：{error}");
                }
                let scheduler = worker_app.state::<AlarmScheduler>();
                if let Ok(mut playing) = scheduler.background_audio.lock() {
                    if playing
                        .get(&worker_id)
                        .is_some_and(|current| Arc::ptr_eq(current, &worker_cancel))
                    {
                        playing.remove(&worker_id);
                    }
                };
            });
        if let Err(error) = started {
            if let Ok(mut playing) = self.background_audio.lock() {
                if playing
                    .get(&task_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &cancel))
                {
                    playing.remove(&task_id);
                }
            }
            return Err(format!("启动后台提醒音失败: {error}"));
        }
        Ok(())
    }

    pub(crate) async fn restore_saved_tasks(&self, app: &AppHandle) -> Result<(), String> {
        // The main WebView may sync its local tasks while this cold-start read is
        // running. Whichever operation gets this lock last owns the schedule.
        let _sync_guard = self.task_sync_lock.lock().await;
        let saved_app = app.clone();
        let journal_lock = self.journal_lock.clone();
        let snapshot = tauri::async_runtime::spawn_blocking(move || {
            let _guard = journal_lock.lock().map_err(|_| "闹钟任务快照状态不可用")?;
            read_task_snapshot(&task_snapshot_path(&saved_app)?)
        })
        .await
        .map_err(|error| format!("恢复闹钟任务异常结束: {error}"))??;
        let Some(snapshot) = snapshot else {
            return Ok(());
        };
        let completed = self.read_triggers(app).await?;
        let tasks = tasks_to_schedule(snapshot.tasks, &completed, Some(snapshot.saved_at));
        self.replace_tasks(app.clone(), tasks).await;
        Ok(())
    }

    pub(crate) fn migration_guard(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.journal_lock
            .lock()
            .map_err(|_| "闹钟触发日志状态不可用".to_string())
    }

    pub(crate) async fn has_pending_work(&self) -> bool {
        self.handles
            .lock()
            .await
            .values()
            .any(|handle| !handle.inner().is_finished())
            || self
                .quick_handles
                .lock()
                .await
                .values()
                .any(|handle| !handle.inner().is_finished())
            || !self.missed_triggers.lock().await.is_empty()
            || self.overflowed_trigger.load(Ordering::Acquire)
    }

    async fn replace_tasks(&self, app: AppHandle, tasks: Vec<AlarmTask>) {
        let mut handles = self.handles.lock().await;
        for (_, handle) in handles.drain() {
            handle.abort();
        }

        for task in tasks
            .into_iter()
            .filter(|task| task.enabled && !task.paused)
        {
            let task_id = task.id.clone();
            let app_handle = app.clone();
            let handle = tauri::async_runtime::spawn(async move {
                run_task(app_handle.clone(), task).await;
                check_standalone_after_alarm(app_handle);
            });
            handles.insert(task_id, handle);
        }
    }

    async fn schedule_one(&self, app: AppHandle, task: AlarmTask) {
        let task_id = task.id.clone();
        let handles = self.quick_handles.clone();
        let mut handles_guard = handles.lock().await;
        if let Some(previous) = handles_guard.remove(&task_id) {
            previous.abort();
        }
        let completion_id = task_id.clone();
        let completion_handles = handles.clone();
        handles_guard.insert(
            task_id,
            tauri::async_runtime::spawn(async move {
                run_task(app.clone(), task).await;
                completion_handles.lock().await.remove(&completion_id);
                check_standalone_after_alarm(app);
            }),
        );
    }
}

#[cfg(windows)]
fn has_audio_frontend(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some()
        || app.webview_windows().into_iter().any(|(label, window)| {
            label.starts_with(crate::infrastructure::quick_host::QUICK_HOST_LABEL_PREFIX)
                && window.url().is_ok_and(|url| {
                    url.query_pairs()
                        .any(|(key, value)| key == "toolId" && value == "alarm-clock")
                })
        })
}

fn check_standalone_after_alarm(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Let the completed task's JoinHandle settle before the idle check.
        tokio::time::sleep(Duration::from_millis(25)).await;
        crate::infrastructure::launch::finish_tool_only_if_idle(app).await;
    });
}

impl AlarmScheduler {
    async fn record_trigger(&self, app: &AppHandle, trigger: TriggeredAlarm) -> bool {
        let mut pending = self.missed_triggers.lock().await;
        if !pending.contains_key(&trigger.task.id) && pending.len() >= MAX_ALARM_TASKS {
            self.overflowed_trigger.store(true, Ordering::Release);
            eprintln!("[AlarmScheduler] 未保存的触发记录已满，本次动作暂缓执行");
            return false;
        }
        pending.insert(trigger.task.id.clone(), trigger);
        let mut records = pending.clone();
        let app = app.clone();
        let journal_lock = self.journal_lock.clone();
        let persisted = tauri::async_runtime::spawn_blocking(move || {
            let _guard = journal_lock.lock().map_err(|_| "闹钟触发日志状态不可用")?;
            let path = trigger_log_path(&app)?;
            persist_and_clear_pending(&path, &mut records)
        })
        .await;
        match persisted {
            Ok(Ok(())) => pending.clear(),
            Ok(Err(error)) => {
                eprintln!("[AlarmScheduler] 保存触发日志失败，保留原生后台待处理: {error}")
            }
            Err(error) => {
                eprintln!("[AlarmScheduler] 保存触发日志任务异常，保留原生后台待处理: {error}")
            }
        }
        // A failed disk commit retains an exact in-memory record. The action may
        // execute once, but idle shutdown remains blocked until that record commits.
        true
    }

    async fn read_triggers(&self, app: &AppHandle) -> Result<Vec<TriggeredAlarm>, String> {
        let pending = self.missed_triggers.lock().await;
        let records = pending.clone();
        let app = app.clone();
        let journal_lock = self.journal_lock.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = journal_lock.lock().map_err(|_| "闹钟触发日志状态不可用")?;
            let path = trigger_log_path(&app)?;
            let mut journal = read_trigger_log(&path)?;
            // The file and unsaved buffer are each bounded at 200. Returning the
            // union here lets scheduling suppress every completed action, even if
            // a full disk log temporarily prevented saving a newer task.
            for (task_id, trigger) in records {
                journal.insert(task_id, trigger);
            }
            Ok(sorted_trigger_records(journal))
        })
        .await
        .map_err(|error| format!("读取闹钟触发日志任务失败: {error}"))?
    }

    async fn acknowledge_triggers(
        &self,
        app: &AppHandle,
        trigger_ids: Vec<String>,
    ) -> Result<(), String> {
        if trigger_ids.len() > MAX_ALARM_TASKS
            || trigger_ids
                .iter()
                .any(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err("触发记录确认标识无效".to_string());
        }
        let identities = trigger_ids.into_iter().collect::<HashSet<_>>();
        let mut pending = self.missed_triggers.lock().await;
        let records = pending.clone();
        let saved_ids = identities.clone();
        let app = app.clone();
        let journal_lock = self.journal_lock.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = journal_lock.lock().map_err(|_| "闹钟触发日志状态不可用")?;
            acknowledge_trigger_log(&trigger_log_path(&app)?, &records, &saved_ids)
        })
        .await
        .map_err(|error| format!("确认闹钟触发日志任务失败: {error}"))??;
        pending.retain(|_, trigger| !identities.contains(&trigger.trigger_id));
        // Remaining pending records were committed by the same atomic write.
        pending.clear();
        self.overflowed_trigger.store(false, Ordering::Release);
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriggerLog {
    version: u32,
    items: Vec<TriggeredAlarm>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskSnapshot {
    version: u32,
    saved_at: i64,
    tasks: Vec<AlarmTask>,
}

fn task_snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .state::<crate::infrastructure::storage::StorageManager>()
        .layout()?
        .kits
        .join("Alarms")
        .join("alarm-tasks.json"))
}

fn validate_task_list(tasks: &[AlarmTask]) -> Result<(), String> {
    if tasks.len() > MAX_ALARM_TASKS {
        return Err(format!("闹钟任务最多允许 {MAX_ALARM_TASKS} 个"));
    }
    let mut task_ids = HashSet::with_capacity(tasks.len());
    for task in tasks {
        if task.id.is_empty() || !task_ids.insert(task.id.as_str()) {
            return Err("闹钟任务 ID 不能为空或重复".to_string());
        }
        validate_task(task)?;
        if [&task.config.audio_path, &task.config.file_path]
            .into_iter()
            .flatten()
            .any(|path| path.len() > 32768 || path.starts_with("data:"))
        {
            return Err("闹钟任务中的文件路径无效".to_string());
        }
    }
    Ok(())
}

fn read_task_snapshot(path: &Path) -> Result<Option<TaskSnapshot>, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取闹钟任务快照失败: {error}")),
    };
    let mut bytes = Vec::new();
    (&mut file)
        .take((MAX_TASK_SNAPSHOT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取闹钟任务快照失败: {error}"))?;
    if bytes.len() > MAX_TASK_SNAPSHOT_BYTES {
        return Err("闹钟任务快照超过大小上限".to_string());
    }
    let snapshot: TaskSnapshot =
        serde_json::from_slice(&bytes).map_err(|error| format!("闹钟任务快照格式无效: {error}"))?;
    if snapshot.version != 1
        || snapshot.saved_at <= 0
        || timestamp_to_local(snapshot.saved_at).is_none()
    {
        return Err("闹钟任务快照版本或保存时间无效".to_string());
    }
    validate_task_list(&snapshot.tasks)?;
    Ok(Some(snapshot))
}

fn write_task_snapshot(path: &Path, tasks: &[AlarmTask]) -> Result<(), String> {
    validate_task_list(tasks)?;
    let snapshot = TaskSnapshot {
        version: 1,
        saved_at: Local::now().timestamp_millis(),
        tasks: tasks.to_vec(),
    };
    let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_TASK_SNAPSHOT_BYTES {
        return Err("闹钟任务快照超过大小上限".to_string());
    }
    let directory = path
        .parent()
        .ok_or_else(|| "闹钟任务快照路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建闹钟任务目录失败: {error}"))?;
    let temporary = directory.join(format!(".alarm-tasks-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("创建闹钟任务快照失败: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("写入闹钟任务快照失败: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步闹钟任务快照失败: {error}"))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| format!("提交闹钟任务快照失败: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn trigger_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .state::<crate::infrastructure::storage::StorageManager>()
        .layout()?
        .kits
        .join("Alarms")
        .join("missed-triggers.json"))
}

fn read_trigger_log(path: &Path) -> Result<HashMap<String, TriggeredAlarm>, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(format!("读取闹钟触发日志失败: {error}")),
    };
    let mut bytes = Vec::new();
    (&mut file)
        .take((MAX_TRIGGER_LOG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_TRIGGER_LOG_BYTES {
        return Err("闹钟触发日志超过大小上限".to_string());
    }
    let journal: TriggerLog =
        serde_json::from_slice(&bytes).map_err(|error| format!("闹钟触发日志格式无效: {error}"))?;
    if journal.version != 1 || journal.items.len() > MAX_ALARM_TASKS {
        return Err("闹钟触发日志版本或数量无效".to_string());
    }
    let mut records = HashMap::new();
    for trigger in journal.items {
        if trigger.task.id.is_empty()
            || trigger.task.id.len() > 128
            || uuid::Uuid::parse_str(&trigger.trigger_id).is_err()
            || trigger.triggered_at <= 0
        {
            return Err("闹钟触发日志包含无效身份".to_string());
        }
        if records.insert(trigger.task.id.clone(), trigger).is_some() {
            return Err("闹钟触发日志包含重复任务".to_string());
        }
    }
    Ok(records)
}

fn merge_trigger_records(
    journal: &mut HashMap<String, TriggeredAlarm>,
    pending: &HashMap<String, TriggeredAlarm>,
) -> Result<(), String> {
    for (task_id, trigger) in pending {
        journal.insert(task_id.clone(), trigger.clone());
    }
    if journal.len() > MAX_ALARM_TASKS {
        return Err("闹钟触发日志已达到 200 条，请先查看待处理提醒".to_string());
    }
    Ok(())
}

fn sorted_trigger_records(journal: HashMap<String, TriggeredAlarm>) -> Vec<TriggeredAlarm> {
    let mut records = journal.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| {
        left.triggered_at
            .cmp(&right.triggered_at)
            .then_with(|| left.trigger_id.cmp(&right.trigger_id))
    });
    records
}

fn write_trigger_log(path: &Path, journal: HashMap<String, TriggeredAlarm>) -> Result<(), String> {
    if journal.len() > MAX_ALARM_TASKS {
        return Err("闹钟触发日志超过数量上限".to_string());
    }
    let items = sorted_trigger_records(journal);
    // Only task metadata and paths are serialized. Audio file contents are never read.
    if items.iter().any(|trigger| {
        [
            &trigger.task.config.audio_path,
            &trigger.task.config.file_path,
        ]
        .into_iter()
        .flatten()
        .any(|path| path.len() > 32768 || path.starts_with("data:"))
    }) {
        return Err("闹钟触发日志中的文件路径无效".to_string());
    }
    let bytes =
        serde_json::to_vec(&TriggerLog { version: 1, items }).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_TRIGGER_LOG_BYTES {
        return Err("闹钟触发日志超过大小上限".to_string());
    }
    let directory = path
        .parent()
        .ok_or_else(|| "闹钟触发日志路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建闹钟触发日志目录失败: {error}"))?;
    let temporary = directory.join(format!(".missed-triggers-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| format!("提交闹钟触发日志失败: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn persist_pending_triggers(
    path: &Path,
    pending: &HashMap<String, TriggeredAlarm>,
) -> Result<(), String> {
    let mut journal = read_trigger_log(path)?;
    merge_trigger_records(&mut journal, pending)?;
    write_trigger_log(path, journal)
}

fn persist_and_clear_pending(
    path: &Path,
    pending: &mut HashMap<String, TriggeredAlarm>,
) -> Result<(), String> {
    persist_pending_triggers(path, pending)?;
    pending.clear();
    Ok(())
}

fn acknowledge_trigger_log(
    path: &Path,
    pending: &HashMap<String, TriggeredAlarm>,
    trigger_ids: &HashSet<String>,
) -> Result<(), String> {
    let mut journal = read_trigger_log(path)?;
    // Remove acknowledged old identities before merging a newer trigger for the
    // same task, so an old acknowledgement cannot erase that new trigger.
    journal.retain(|_, trigger| !trigger_ids.contains(&trigger.trigger_id));
    for (task_id, trigger) in pending {
        if !trigger_ids.contains(&trigger.trigger_id) {
            journal.insert(task_id.clone(), trigger.clone());
        }
    }
    write_trigger_log(path, journal)
}

fn same_completed_once(task: &AlarmTask, trigger: &TriggeredAlarm) -> bool {
    if task.id != trigger.task.id
        || task.task_type != trigger.task.task_type
        || task.action != trigger.task.action
    {
        return false;
    }
    match task.task_type.as_str() {
        "countdown" => task.config.deadline_at == trigger.task.config.deadline_at,
        "fixed" => {
            !task.config.repeat_enabled
                && !trigger.task.config.repeat_enabled
                && task.config.time == trigger.task.config.time
        }
        "hourly" => !task.config.repeat_enabled && !trigger.task.config.repeat_enabled,
        _ => false,
    }
}

fn tasks_to_schedule(
    tasks: Vec<AlarmTask>,
    completed: &[TriggeredAlarm],
    saved_at: Option<i64>,
) -> Vec<AlarmTask> {
    let now = Local::now();
    tasks
        .into_iter()
        .filter(|task| {
            if completed
                .iter()
                .any(|trigger| same_completed_once(task, trigger))
            {
                return false;
            }
            // A saved one-shot action whose original deadline passed while the
            // app was closed must not run late during a background logon.
            if let Some(saved_at) = saved_at {
                match task.task_type.as_str() {
                    "countdown" if task.enabled && !task.paused => {
                        return task
                            .config
                            .deadline_at
                            .is_some_and(|deadline| deadline > now.timestamp_millis());
                    }
                    "fixed" | "hourly"
                        if task.enabled && !task.paused && !task.config.repeat_enabled =>
                    {
                        let Some(saved_at) = timestamp_to_local(saved_at) else {
                            return false;
                        };
                        return next_trigger_at(task, saved_at)
                            .is_some_and(|original| original > now);
                    }
                    _ => {}
                }
            }
            true
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn sync_alarm_tasks(
    app: AppHandle,
    scheduler: tauri::State<'_, AlarmScheduler>,
    tasks: Vec<AlarmTask>,
) -> Result<(), String> {
    let _native_work = crate::infrastructure::launch::keep_native_work(&app);
    validate_task_list(&tasks)?;
    let _sync_guard = scheduler.task_sync_lock.lock().await;
    let completed = scheduler.read_triggers(&app).await?;
    let saved_app = app.clone();
    let saved_tasks = tasks.clone();
    let journal_lock = scheduler.journal_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = journal_lock.lock().map_err(|_| "闹钟任务快照状态不可用")?;
        write_task_snapshot(&task_snapshot_path(&saved_app)?, &saved_tasks)
    })
    .await
    .map_err(|error| format!("保存闹钟任务异常结束: {error}"))??;
    let tasks = tasks_to_schedule(tasks, &completed, None);
    scheduler.replace_tasks(app, tasks).await;
    Ok(())
}

fn validate_task(task: &AlarmTask) -> Result<(), String> {
    if task.id.len() > 128 || task.name.trim().is_empty() || task.name.chars().count() > 80 {
        return Err("闹钟任务名称或 ID 无效".to_string());
    }
    if !matches!(
        task.action.as_str(),
        "notify" | "sound" | "run" | "shutdown" | "lock"
    ) {
        return Err(format!("不支持的闹钟动作：{}", task.action));
    }
    if task.config.repeat_days.len() > 7 || task.config.repeat_days.iter().any(|day| *day > 6) {
        return Err("重复日期无效".to_string());
    }

    match task.task_type.as_str() {
        "countdown"
            if task.config.deadline_at.is_some()
                || task.config.remaining_seconds.is_some()
                || task.config.total_seconds.is_some() =>
        {
            Ok(())
        }
        "interval" if task.config.interval_ms.is_some_and(|value| value >= 60_000) => Ok(()),
        "fixed"
            if task
                .config
                .time
                .as_deref()
                .and_then(parse_clock_time)
                .is_some()
                && (!task.config.repeat_enabled || !task.config.repeat_days.is_empty()) =>
        {
            Ok(())
        }
        "hourly" if !task.config.repeat_enabled || !task.config.repeat_days.is_empty() => Ok(()),
        _ => Err(format!("闹钟任务配置无效：{}", task.name)),
    }
}

#[tauri::command]
pub(crate) async fn take_missed_alarm_triggers(
    app: AppHandle,
    scheduler: tauri::State<'_, AlarmScheduler>,
) -> Result<Vec<TriggeredAlarm>, String> {
    let _native_work = crate::infrastructure::launch::keep_native_work(&app);
    Ok(scheduler
        .read_triggers(&app)
        .await?
        .into_iter()
        .take(MAX_ALARM_TASKS)
        .collect())
}

#[tauri::command]
pub(crate) async fn ack_missed_alarm_triggers(
    app: AppHandle,
    scheduler: tauri::State<'_, AlarmScheduler>,
    trigger_ids: Vec<String>,
) -> Result<(), String> {
    let _native_work = crate::infrastructure::launch::keep_native_work(&app);
    scheduler.acknowledge_triggers(&app, trigger_ids).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickCountdownResult {
    id: String,
    name: String,
    seconds: u64,
    deadline_at: i64,
}

#[tauri::command]
pub(crate) async fn create_quick_countdown(
    app: AppHandle,
    scheduler: tauri::State<'_, AlarmScheduler>,
    seconds: u64,
    name: Option<String>,
) -> Result<QuickCountdownResult, String> {
    let _native_work = crate::infrastructure::launch::keep_native_work(&app);
    if !(1..=86_400).contains(&seconds) {
        return Err("倒计时必须在 1 秒到 24 小时之间".to_string());
    }
    let name = name
        .unwrap_or_else(|| format!("{} 秒倒计时", seconds))
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    if name.is_empty() {
        return Err("倒计时名称不能为空".to_string());
    }
    let deadline_at = Local::now()
        .timestamp_millis()
        .saturating_add((seconds as i64).saturating_mul(1_000));
    let id = format!("quick-countdown-{}", uuid::Uuid::new_v4());
    let task = AlarmTask {
        id: id.clone(),
        name: name.clone(),
        task_type: "countdown".into(),
        action: "notify".into(),
        enabled: true,
        paused: false,
        config: AlarmConfig {
            total_seconds: Some(seconds as i64),
            remaining_seconds: Some(seconds as i64),
            deadline_at: Some(deadline_at),
            time: None,
            repeat_days: Vec::new(),
            repeat_enabled: false,
            interval_ms: None,
            next_trigger_at: None,
            interval_value: None,
            interval_unit: None,
            audio_path: None,
            audio_name: None,
            file_path: None,
        },
    };
    scheduler.schedule_one(app, task).await;
    Ok(QuickCountdownResult {
        id,
        name,
        seconds,
        deadline_at,
    })
}

async fn run_task(app: AppHandle, task: AlarmTask) {
    loop {
        let Some(next_trigger) = next_trigger_at(&task, Local::now()) else {
            return;
        };

        wait_until(next_trigger).await;
        let triggered = TriggeredAlarm::new(task.clone());
        if app
            .state::<AlarmScheduler>()
            .record_trigger(&app, triggered.clone())
            .await
        {
            trigger(&app, &triggered);
        }

        if task.task_type == "countdown"
            || (!task.config.repeat_enabled
                && matches!(task.task_type.as_str(), "fixed" | "hourly"))
        {
            return;
        }
    }
}

async fn wait_until(target: DateTime<Local>) {
    loop {
        let remaining_ms = target.timestamp_millis() - Local::now().timestamp_millis();
        if remaining_ms <= 0 {
            return;
        }

        let remaining = Duration::from_millis(remaining_ms as u64);
        tokio::time::sleep(remaining.min(CLOCK_RECHECK_INTERVAL)).await;
    }
}

#[cfg(windows)]
fn managed_audio_path(app: &AppHandle, task: &AlarmTask) -> Result<PathBuf, String> {
    let audio_root = app
        .state::<crate::infrastructure::storage::StorageManager>()
        .layout()?
        .kits
        .join("Alarm");
    let requested = task
        .config
        .audio_path
        .as_deref()
        .ok_or_else(|| "任务缺少提醒音文件".to_string())?;
    validate_managed_audio_path(&audio_root, requested)
}

#[cfg(windows)]
fn validate_managed_audio_path(audio_root: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = Path::new(requested);
    if !requested.is_absolute() {
        return Err("提醒音文件路径无效".into());
    }
    let root =
        fs::canonicalize(audio_root).map_err(|error| format!("提醒音目录不可用: {error}"))?;
    let path = fs::canonicalize(requested).map_err(|error| format!("提醒音文件不可用: {error}"))?;
    if path.parent() != Some(root.as_path()) || !path.is_file() {
        return Err("提醒音文件不在 DtKit 托管目录中".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("wav" | "mp3" | "m4a" | "ogg")) {
        return Err("提醒音格式不受支持".into());
    }
    Ok(path)
}

#[cfg(windows)]
fn play_background_file(path: &Path, cancel: &AtomicBool) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Foundation::{TypedEventHandler, Uri};
    use windows::Media::Core::MediaSource;
    use windows::Media::Playback::{
        MediaPlayer, MediaPlayerAudioCategory, MediaPlayerFailedEventArgs,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    struct WinrtSession;
    impl Drop for WinrtSession {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        .map_err(|error| format!("初始化 Windows 音频接口失败: {error}"))?;
    let _session = WinrtSession;
    if cancel.load(Ordering::Acquire) {
        return Ok(());
    }
    let file_url =
        tauri::Url::from_file_path(path).map_err(|_| "提醒音文件不能转换为本地地址".to_string())?;
    let uri = Uri::CreateUri(&HSTRING::from(file_url.as_str()))
        .map_err(|error| format!("解析提醒音地址失败: {error}"))?;
    let source =
        MediaSource::CreateFromUri(&uri).map_err(|error| format!("打开提醒音文件失败: {error}"))?;
    let player =
        MediaPlayer::new().map_err(|error| format!("创建 Windows 音频播放器失败: {error}"))?;
    let failed = Arc::new(AtomicBool::new(false));
    let failed_callback = failed.clone();
    let handler =
        TypedEventHandler::<MediaPlayer, MediaPlayerFailedEventArgs>::new(move |_, error| {
            eprintln!(
                "[AlarmScheduler] Windows 无法解码提醒音: {:?}",
                error.as_ref().map(MediaPlayerFailedEventArgs::ErrorMessage)
            );
            failed_callback.store(true, Ordering::Release);
            Ok(())
        });
    let result = (|| {
        let token = player
            .MediaFailed(&handler)
            .map_err(|error| format!("监听音频失败事件失败: {error}"))?;
        let playback = (|| {
            player
                .SetAudioCategory(MediaPlayerAudioCategory::Alerts)
                .map_err(|error| format!("设置音频类别失败: {error}"))?;
            player
                .SetVolume(0.7)
                .map_err(|error| format!("设置音量失败: {error}"))?;
            player
                .SetIsLoopingEnabled(true)
                .map_err(|error| format!("设置提醒音循环失败: {error}"))?;
            player
                .SetSource(&source)
                .map_err(|error| format!("加载提醒音失败: {error}"))?;
            if cancel.load(Ordering::Acquire) {
                return Ok(());
            }
            player
                .Play()
                .map_err(|error| format!("播放提醒音失败: {error}"))?;
            let started = std::time::Instant::now();
            while !cancel.load(Ordering::Acquire)
                && !failed.load(Ordering::Acquire)
                && started.elapsed() < MAX_BACKGROUND_AUDIO_DURATION
            {
                thread::sleep(Duration::from_millis(200));
            }
            if failed.load(Ordering::Acquire) {
                return Err("Windows 音频播放器无法解码此文件，已保留系统通知".into());
            }
            Ok(())
        })();
        let _ = player.RemoveMediaFailed(token);
        playback
    })();
    let _ = player.Close();
    let _ = source.Close();
    result
}

fn trigger(app: &AppHandle, triggered: &TriggeredAlarm) {
    let task = &triggered.task;
    let _ = app
        .notification()
        .builder()
        .title("⏰ DtKit 定时提醒")
        .body(task.name.clone())
        .show();

    let action_result = match task.action.as_str() {
        "run" => task
            .config
            .file_path
            .clone()
            .ok_or_else(|| "任务缺少程序路径".to_string())
            .and_then(run_program),
        "shutdown" => schedule_shutdown(),
        "lock" => lock_screen(),
        _ => Ok(()),
    };

    if let Err(error) = action_result {
        eprintln!("[AlarmScheduler] 执行动作失败（{}）：{}", task.name, error);
    }

    #[cfg(windows)]
    if task.action == "sound" && !has_audio_frontend(app) {
        if let Err(error) = app
            .state::<AlarmScheduler>()
            .start_background_audio(app, task)
        {
            eprintln!("[AlarmScheduler] 后台提醒音未能启动，系统通知仍有效：{error}");
        }
    }

    let _ = app.emit("alarm-triggered", triggered);
}

#[tauri::command]
pub(crate) fn stop_background_alarm_audio(
    window: WebviewWindow,
    task_id: Option<String>,
) -> Result<bool, String> {
    if window.label() != "main"
        && !window
            .label()
            .starts_with(crate::infrastructure::quick_host::QUICK_HOST_LABEL_PREFIX)
    {
        return Err("当前窗口不能控制后台提醒音".into());
    }
    if task_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 128)
    {
        return Err("提醒任务标识无效".into());
    }
    window
        .state::<AlarmScheduler>()
        .stop_background_audio(task_id.as_deref())
}

fn next_trigger_at(task: &AlarmTask, after: DateTime<Local>) -> Option<DateTime<Local>> {
    if !task.enabled || task.paused {
        return None;
    }

    match task.task_type.as_str() {
        "countdown" => timestamp_to_local(task.config.deadline_at?),
        "interval" => {
            if let Some(timestamp) = task.config.next_trigger_at {
                if timestamp > after.timestamp_millis() {
                    return timestamp_to_local(timestamp);
                }
            }
            let interval_ms = task.config.interval_ms?.max(1);
            timestamp_to_local(after.timestamp_millis().saturating_add(interval_ms))
        }
        "fixed" => next_fixed_time(task, after),
        "hourly" => next_hourly_time(task, after),
        _ => None,
    }
}

fn timestamp_to_local(timestamp_ms: i64) -> Option<DateTime<Local>> {
    DateTime::from_timestamp_millis(timestamp_ms).map(|value| value.with_timezone(&Local))
}

fn next_fixed_time(task: &AlarmTask, after: DateTime<Local>) -> Option<DateTime<Local>> {
    let (hour, minute) = parse_clock_time(task.config.time.as_deref()?)?;

    for day_offset in 0..=7 {
        let date = after.date_naive() + ChronoDuration::days(day_offset);
        let Some(candidate) = resolve_local_datetime(date, hour, minute) else {
            continue;
        };
        if candidate > after
            && (!task.config.repeat_enabled
                || day_is_enabled(
                    &task.config.repeat_days,
                    candidate.weekday().num_days_from_sunday(),
                ))
        {
            return Some(candidate);
        }
    }
    None
}

fn next_hourly_time(task: &AlarmTask, after: DateTime<Local>) -> Option<DateTime<Local>> {
    let start = after + ChronoDuration::hours(1);
    for hour_offset in 0..=(24 * 7) {
        let probe = start + ChronoDuration::hours(hour_offset);
        let Some(candidate) = resolve_local_datetime(probe.date_naive(), probe.hour(), 0) else {
            continue;
        };
        if candidate > after
            && (!task.config.repeat_enabled
                || day_is_enabled(
                    &task.config.repeat_days,
                    candidate.weekday().num_days_from_sunday(),
                ))
        {
            return Some(candidate);
        }
    }
    None
}

fn resolve_local_datetime(
    date: chrono::NaiveDate,
    hour: u32,
    minute: u32,
) -> Option<DateTime<Local>> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(value) => Some(value),
        LocalResult::Ambiguous(earlier, _) => Some(earlier),
        LocalResult::None => None,
    }
}

fn parse_clock_time(value: &str) -> Option<(u32, u32)> {
    let (hour, minute) = value.split_once(':')?;
    let hour = hour.parse().ok()?;
    let minute = minute.parse().ok()?;
    (hour < 24 && minute < 60).then_some((hour, minute))
}

fn day_is_enabled(repeat_days: &[u32], day: u32) -> bool {
    repeat_days.contains(&day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(task_type: &str) -> AlarmTask {
        AlarmTask {
            id: "test".into(),
            name: "测试提醒".into(),
            task_type: task_type.into(),
            action: "notify".into(),
            enabled: true,
            paused: false,
            config: AlarmConfig {
                total_seconds: None,
                remaining_seconds: None,
                deadline_at: None,
                time: None,
                repeat_days: vec![],
                repeat_enabled: true,
                interval_ms: None,
                next_trigger_at: None,
                interval_value: None,
                interval_unit: None,
                audio_path: None,
                audio_name: None,
                file_path: None,
            },
        }
    }

    #[test]
    fn native_audio_stop_and_main_recovery_cancel_existing_playback() {
        let scheduler = AlarmScheduler::default();
        let first = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        {
            let mut playing = scheduler.background_audio.lock().unwrap();
            playing.insert("first".into(), first.clone());
            playing.insert("second".into(), second.clone());
        }
        assert!(scheduler.stop_background_audio(Some("first")).unwrap());
        assert!(first.load(Ordering::Acquire));
        assert!(!second.load(Ordering::Acquire));
        assert!(!scheduler.stop_background_audio(Some("first")).unwrap());
        let guard = scheduler.begin_main_restore();
        assert!(second.load(Ordering::Acquire));
        assert_eq!(scheduler.main_recovery_count.load(Ordering::Acquire), 1);
        drop(guard);
        assert_eq!(scheduler.main_recovery_count.load(Ordering::Acquire), 0);
        assert!(!scheduler.stop_background_audio(None).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn native_audio_accepts_only_managed_audio_files() {
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let fixture = parent.join(format!("dtkit-audio-path-test-{}", uuid::Uuid::new_v4()));
        let managed = fixture.join("Kits").join("Alarm");
        fs::create_dir_all(&managed).unwrap();
        let inside = managed.join("提示音.M4A");
        fs::write(&inside, b"fixture").unwrap();
        let outside = fixture.join("outside.mp3");
        fs::write(&outside, b"fixture").unwrap();
        let unsupported = managed.join("program.exe");
        fs::write(&unsupported, b"fixture").unwrap();
        assert_eq!(
            validate_managed_audio_path(&managed, inside.to_str().unwrap()).unwrap(),
            inside.canonicalize().unwrap()
        );
        assert!(validate_managed_audio_path(&managed, outside.to_str().unwrap()).is_err());
        assert!(validate_managed_audio_path(&managed, unsupported.to_str().unwrap()).is_err());
        assert!(validate_managed_audio_path(&managed, "relative.wav").is_err());
        assert_eq!(
            fixture.canonicalize().unwrap().parent(),
            Some(parent.as_path())
        );
        fs::remove_dir_all(fixture).unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires an interactive Windows audio endpoint; run manually with a silent WAV"]
    fn windows_media_player_opens_and_stops_a_silent_wav() {
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let fixture = parent.join(format!("dtkit-silent-audio-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&fixture).unwrap();
        let path = fixture.join("silent.wav");
        let samples = vec![0u8; 1600]; // 100 ms, 8 kHz mono PCM16.
        let mut wav = Vec::with_capacity(44 + samples.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        wav.extend_from_slice(&samples);
        fs::write(&path, wav).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let worker_path = path.clone();
        let worker = thread::spawn(move || play_background_file(&worker_path, &worker_cancel));
        thread::sleep(Duration::from_millis(900));
        cancel.store(true, Ordering::Release);
        let result = worker.join().unwrap();
        assert_eq!(
            fixture.canonicalize().unwrap().parent(),
            Some(parent.as_path())
        );
        fs::remove_dir_all(fixture).unwrap();
        result.unwrap();
    }

    #[test]
    fn countdown_uses_absolute_deadline() {
        let now = Local::now();
        let deadline = now.timestamp_millis() + 90_000;
        let mut alarm = task("countdown");
        alarm.config.deadline_at = Some(deadline);

        assert_eq!(
            next_trigger_at(&alarm, now).unwrap().timestamp_millis(),
            deadline
        );
    }

    #[test]
    fn paused_and_disabled_tasks_are_not_scheduled() {
        let now = Local::now();
        let mut alarm = task("countdown");
        alarm.config.deadline_at = Some(now.timestamp_millis() + 1_000);
        alarm.paused = true;
        assert!(next_trigger_at(&alarm, now).is_none());

        alarm.paused = false;
        alarm.enabled = false;
        assert!(next_trigger_at(&alarm, now).is_none());
    }

    #[test]
    fn fixed_alarm_honors_repeat_days() {
        let now = Local::now();
        let tomorrow = now + ChronoDuration::days(1);
        let mut alarm = task("fixed");
        alarm.config.time = Some("23:59".into());
        alarm.config.repeat_days = vec![tomorrow.weekday().num_days_from_sunday()];

        let next = next_trigger_at(&alarm, now).unwrap();
        assert_eq!(next.weekday(), tomorrow.weekday());
        assert_eq!((next.hour(), next.minute()), (23, 59));
    }

    #[test]
    fn one_time_fixed_alarm_ignores_repeat_days() {
        let now = Local::now();
        let mut alarm = task("fixed");
        alarm.config.time = Some("23:59".into());
        alarm.config.repeat_enabled = false;

        assert!(next_trigger_at(&alarm, now).is_some());
    }

    fn journal_path() -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("dtkit-alarm-journal-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory.join("missed-triggers.json")
    }

    #[test]
    fn saved_tasks_round_trip_with_unicode_and_replace_atomically() {
        let path = journal_path().with_file_name("alarm-tasks.json");
        let mut alarm = task("countdown");
        alarm.id = "中文提醒".into();
        alarm.config.deadline_at = Some(Local::now().timestamp_millis() + 90_000);
        write_task_snapshot(&path, &[alarm.clone()]).unwrap();
        let saved = read_task_snapshot(&path).unwrap().unwrap();
        assert_eq!(saved.version, 1);
        assert_eq!(saved.tasks.len(), 1);
        assert_eq!(saved.tasks[0].id, alarm.id);
        write_task_snapshot(&path, &[]).unwrap();
        assert!(read_task_snapshot(&path).unwrap().unwrap().tasks.is_empty());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn task_snapshot_rejects_corrupt_oversized_and_duplicate_data() {
        let path = journal_path().with_file_name("alarm-tasks.json");
        fs::write(&path, b"{not json").unwrap();
        assert!(read_task_snapshot(&path).is_err());
        fs::write(&path, vec![b' '; MAX_TASK_SNAPSHOT_BYTES + 1]).unwrap();
        assert!(read_task_snapshot(&path).unwrap_err().contains("上限"));
        let mut alarm = task("countdown");
        alarm.config.deadline_at = Some(Local::now().timestamp_millis() + 90_000);
        let duplicate = TaskSnapshot {
            version: 1,
            saved_at: Local::now().timestamp_millis(),
            tasks: vec![alarm.clone(), alarm],
        };
        fs::write(&path, serde_json::to_vec(&duplicate).unwrap()).unwrap();
        assert!(read_task_snapshot(&path).unwrap_err().contains("重复"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn windowless_recovery_skips_expired_one_shots_and_completed_actions() {
        let now = Local::now();
        let mut expired = task("countdown");
        expired.config.deadline_at = Some(now.timestamp_millis() - 60_000);
        assert!(
            tasks_to_schedule(vec![expired], &[], Some(now.timestamp_millis() - 120_000))
                .is_empty()
        );

        let mut hourly = task("hourly");
        hourly.id = "hourly".into();
        hourly.config.repeat_enabled = false;
        assert!(
            tasks_to_schedule(vec![hourly], &[], Some(now.timestamp_millis() - 7_200_000))
                .is_empty()
        );

        let mut future = task("countdown");
        future.config.deadline_at = Some(now.timestamp_millis() + 90_000);
        let triggered = TriggeredAlarm::new(future.clone());
        assert!(tasks_to_schedule(
            vec![future.clone()],
            &[triggered.clone()],
            Some(now.timestamp_millis())
        )
        .is_empty());
        assert!(tasks_to_schedule(vec![future.clone()], &[triggered], None).is_empty());
        assert_eq!(
            tasks_to_schedule(vec![future], &[], Some(now.timestamp_millis())).len(),
            1
        );
    }

    #[test]
    fn durable_completions_survive_restart_and_block_stale_once_tasks() {
        let path = journal_path();
        let mut alarm = task("countdown");
        alarm.config.deadline_at = Some(Local::now().timestamp_millis());
        alarm.action = "run".into();
        alarm.config.file_path = Some("C:/Programs/Test Program.exe".into());
        let trigger = TriggeredAlarm::new(alarm.clone());
        let mut pending = HashMap::from([(alarm.id.clone(), trigger.clone())]);
        persist_and_clear_pending(&path, &mut pending).unwrap();
        assert!(pending.is_empty());
        let reopened = read_trigger_log(&path).unwrap();
        let recovered = reopened.get(&alarm.id).unwrap();
        assert_eq!(recovered.trigger_id, trigger.trigger_id);
        assert_eq!(recovered.task.config.file_path, alarm.config.file_path);
        assert!(same_completed_once(&alarm, recovered));
        alarm.config.deadline_at = alarm.config.deadline_at.map(|value| value + 1);
        assert!(!same_completed_once(&alarm, recovered));
        acknowledge_trigger_log(&path, &HashMap::new(), &HashSet::from([trigger.trigger_id]))
            .unwrap();
        assert!(read_trigger_log(&path).unwrap().is_empty());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn an_old_acknowledgement_cannot_erase_a_new_trigger_for_the_same_task() {
        let path = journal_path();
        let alarm = task("interval");
        let old = TriggeredAlarm::new(alarm.clone());
        let new = TriggeredAlarm::new(alarm.clone());
        persist_pending_triggers(&path, &HashMap::from([(alarm.id.clone(), old.clone())])).unwrap();
        let pending = HashMap::from([(alarm.id.clone(), new.clone())]);
        acknowledge_trigger_log(&path, &pending, &HashSet::from([old.trigger_id])).unwrap();
        assert_eq!(
            read_trigger_log(&path).unwrap()[&alarm.id].trigger_id,
            new.trigger_id
        );
        acknowledge_trigger_log(
            &path,
            &HashMap::new(),
            &HashSet::from([uuid::Uuid::new_v4().to_string()]),
        )
        .unwrap();
        assert_eq!(
            read_trigger_log(&path).unwrap()[&alarm.id].trigger_id,
            new.trigger_id
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn failed_disk_writes_preserve_unsaved_records_and_prevent_idle_shutdown() {
        let path = journal_path();
        let scheduler = AlarmScheduler::default();
        let trigger = TriggeredAlarm::new(task("interval"));
        {
            let mut pending = scheduler.missed_triggers.lock().await;
            pending.insert(trigger.task.id.clone(), trigger.clone());
            let blocked = path.parent().unwrap().join("blocked");
            fs::write(&blocked, b"not a directory").unwrap();
            assert!(
                persist_and_clear_pending(&blocked.join("missed-triggers.json"), &mut pending)
                    .is_err()
            );
            assert_eq!(pending[&trigger.task.id].trigger_id, trigger.trigger_id);
        }
        assert!(scheduler.has_pending_work().await);
        {
            let mut pending = scheduler.missed_triggers.lock().await;
            persist_and_clear_pending(&path, &mut pending).unwrap();
        }
        assert!(!scheduler.has_pending_work().await);
        assert_eq!(
            read_trigger_log(&path).unwrap()[&trigger.task.id].trigger_id,
            trigger.trigger_id
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn trigger_logs_coalesce_repeats_and_reject_growth_without_replacing_the_previous_log() {
        let path = journal_path();
        let first = TriggeredAlarm::new(task("interval"));
        let latest = TriggeredAlarm::new(task("interval"));
        persist_pending_triggers(&path, &HashMap::from([(first.task.id.clone(), first)])).unwrap();
        persist_pending_triggers(
            &path,
            &HashMap::from([(latest.task.id.clone(), latest.clone())]),
        )
        .unwrap();
        let log = read_trigger_log(&path).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[&latest.task.id].trigger_id, latest.trigger_id);
        let before = fs::read(&path).unwrap();
        let too_many = (0..=MAX_ALARM_TASKS)
            .map(|index| {
                let mut alarm = task("interval");
                alarm.id = format!("task-{index}");
                (alarm.id.clone(), TriggeredAlarm::new(alarm))
            })
            .collect::<HashMap<_, _>>();
        assert!(persist_pending_triggers(&path, &too_many).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn unsafe_high_frequency_intervals_are_rejected() {
        let mut alarm = task("interval");
        alarm.config.interval_ms = Some(999);

        assert!(validate_task(&alarm).is_err());
    }

    #[tokio::test]
    async fn finished_alarm_handles_do_not_keep_tool_only_mode_awake() {
        let scheduler = AlarmScheduler::default();
        assert!(!scheduler.has_pending_work().await);
        let mut handle = tauri::async_runtime::spawn(async {});
        (&mut handle).await.unwrap();
        scheduler
            .handles
            .lock()
            .await
            .insert("finished".into(), handle);
        assert!(!scheduler.has_pending_work().await);
        let pending = tauri::async_runtime::spawn(std::future::pending());
        scheduler
            .quick_handles
            .lock()
            .await
            .insert("pending".into(), pending);
        assert!(scheduler.has_pending_work().await);
        scheduler
            .quick_handles
            .lock()
            .await
            .remove("pending")
            .unwrap()
            .abort();
        assert!(!scheduler.has_pending_work().await);
    }

    #[test]
    fn triggered_alarm_payload_keeps_the_event_identity_for_replay() {
        let trigger = TriggeredAlarm::new(task("countdown"));
        let first = serde_json::to_value(&trigger).unwrap();
        let replay = serde_json::to_value(trigger.clone()).unwrap();
        assert_eq!(first, replay);
        assert!(first["triggerId"]
            .as_str()
            .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok()));
        assert!(first["triggeredAt"].as_i64().is_some());
        assert!(first["id"].as_str().is_some());
    }

    #[test]
    fn elapsed_interval_is_rescheduled_without_busy_polling() {
        let now = Local::now();
        let mut alarm = task("interval");
        alarm.config.interval_ms = Some(60_000);
        alarm.config.next_trigger_at = Some(now.timestamp_millis() - 1);

        let next = next_trigger_at(&alarm, now).unwrap();
        assert_eq!(next.timestamp_millis(), now.timestamp_millis() + 60_000);
    }
}
