use crate::system_actions::{lock_screen, run_program, schedule_shutdown};
use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, Local, LocalResult, TimeZone, Timelike,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

const CLOCK_RECHECK_INTERVAL: Duration = Duration::from_secs(30);
const MAX_ALARM_TASKS: usize = 200;

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

#[derive(Default)]
pub(crate) struct AlarmScheduler {
    handles: Mutex<HashMap<String, JoinHandle<()>>>,
    quick_handles: std::sync::Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    missed_triggers: Mutex<HashMap<String, AlarmTask>>,
}

impl AlarmScheduler {
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
            let handle = tauri::async_runtime::spawn(run_task(app_handle, task));
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
                run_task(app, task).await;
                completion_handles.lock().await.remove(&completion_id);
            }),
        );
    }
}

impl AlarmScheduler {
    async fn record_missed_trigger(&self, task: AlarmTask) {
        self.missed_triggers
            .lock()
            .await
            .insert(task.id.clone(), task);
    }

    async fn take_missed_triggers(&self) -> Vec<AlarmTask> {
        std::mem::take(&mut *self.missed_triggers.lock().await)
            .into_values()
            .collect()
    }
}

#[tauri::command]
pub(crate) async fn sync_alarm_tasks(
    app: AppHandle,
    scheduler: tauri::State<'_, AlarmScheduler>,
    tasks: Vec<AlarmTask>,
) -> Result<(), String> {
    if tasks.len() > MAX_ALARM_TASKS {
        return Err(format!("闹钟任务最多允许 {MAX_ALARM_TASKS} 个"));
    }
    let mut task_ids = HashSet::with_capacity(tasks.len());
    if tasks
        .iter()
        .any(|task| task.id.is_empty() || !task_ids.insert(task.id.as_str()))
    {
        return Err("闹钟任务 ID 不能为空或重复".to_string());
    }
    for task in &tasks {
        validate_task(task)?;
    }
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
    scheduler: tauri::State<'_, AlarmScheduler>,
) -> Result<Vec<AlarmTask>, String> {
    Ok(scheduler.take_missed_triggers().await)
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
        trigger(&app, &task);
        if app.get_webview_window("main").is_none() {
            app.state::<AlarmScheduler>()
                .record_missed_trigger(task.clone())
                .await;
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

fn trigger(app: &AppHandle, task: &AlarmTask) {
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

    let _ = app.emit("alarm-triggered", task);
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

    #[tokio::test]
    async fn missed_triggers_are_coalesced_by_task() {
        let scheduler = AlarmScheduler::default();
        let alarm = task("interval");

        scheduler.record_missed_trigger(alarm.clone()).await;
        scheduler.record_missed_trigger(alarm).await;

        assert_eq!(scheduler.take_missed_triggers().await.len(), 1);
    }

    #[test]
    fn unsafe_high_frequency_intervals_are_rejected() {
        let mut alarm = task("interval");
        alarm.config.interval_ms = Some(999);

        assert!(validate_task(&alarm).is_err());
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
