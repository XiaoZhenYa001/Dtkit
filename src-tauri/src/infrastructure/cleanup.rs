use super::resources::ResourceGovernor;
use super::storage::{StorageManager, StorageUsage};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

const CLEANUP_POLICY_FILE: &str = "cleanup-policy.json";
const AUTO_CLEANUP_INTERVAL_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupPolicy {
    pub(crate) automatic_enabled: bool,
    pub(crate) last_automatic_run_at: Option<i64>,
}

impl Default for CleanupPolicy {
    fn default() -> Self {
        Self {
            automatic_enabled: false,
            last_automatic_run_at: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupTarget {
    Cache,
    Logs,
    Recovery,
}

impl CleanupTarget {
    fn directory<'a>(&self, layout: &'a super::storage::StorageLayout) -> &'a Path {
        match self {
            Self::Cache => &layout.cache,
            Self::Logs => &layout.logs,
            Self::Recovery => &layout.recovery,
        }
    }

    fn recovery_name(&self) -> &'static str {
        match self {
            Self::Cache => "cache",
            Self::Logs => "logs",
            Self::Recovery => "recovery",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupRequest {
    pub(crate) targets: Vec<CleanupTarget>,
    #[serde(default)]
    pub(crate) permanent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupResult {
    pub(crate) permanent: bool,
    pub(crate) files_processed: u64,
    pub(crate) bytes_processed: u64,
    pub(crate) recovery_batch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupStatus {
    pub(crate) policy: CleanupPolicy,
    pub(crate) usage: StorageUsage,
    pub(crate) latest_recovery_batch_id: Option<String>,
    pub(crate) running: bool,
    pub(crate) cache_retention_days: u32,
    pub(crate) log_retention_days: u32,
}

pub(crate) struct CleanupManager {
    policy: RwLock<CleanupPolicy>,
    running: AtomicBool,
}

impl Default for CleanupManager {
    fn default() -> Self {
        Self {
            policy: RwLock::new(CleanupPolicy::default()),
            running: AtomicBool::new(false),
        }
    }
}

struct RunningGuard<'a>(&'a AtomicBool);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl CleanupManager {
    pub(crate) fn restore(&self, app: &AppHandle) -> Result<(), String> {
        let path = app
            .state::<StorageManager>()
            .config_file(CLEANUP_POLICY_FILE)?;
        if !path.is_file() {
            return Ok(());
        }
        let serialized =
            fs::read_to_string(path).map_err(|error| format!("读取清理策略失败: {error}"))?;
        let policy = serde_json::from_str(&serialized)
            .map_err(|error| format!("清理策略格式无效: {error}"))?;
        *self
            .policy
            .write()
            .map_err(|_| "清理策略状态不可用".to_string())? = policy;
        Ok(())
    }

    pub(crate) fn policy(&self) -> CleanupPolicy {
        self.policy
            .read()
            .map(|policy| policy.clone())
            .unwrap_or_default()
    }

    pub(crate) fn set_automatic_enabled(
        &self,
        app: &AppHandle,
        enabled: bool,
    ) -> Result<CleanupPolicy, String> {
        let previous = self.policy();
        let mut next = previous.clone();
        next.automatic_enabled = enabled;
        *self
            .policy
            .write()
            .map_err(|_| "清理策略状态不可用".to_string())? = next.clone();
        if let Err(error) = self.persist_policy(app, &next) {
            if let Ok(mut policy) = self.policy.write() {
                *policy = previous;
            }
            return Err(error);
        }
        Ok(next)
    }

    pub(crate) fn status(&self, app: &AppHandle) -> Result<CleanupStatus, String> {
        let storage = app.state::<StorageManager>();
        let layout = storage.layout()?;
        let resource_policy = app.state::<ResourceGovernor>().policy();
        Ok(CleanupStatus {
            policy: self.policy(),
            usage: storage.usage()?,
            latest_recovery_batch_id: latest_recovery_batch(&layout.recovery)?,
            running: self.running.load(Ordering::Acquire),
            cache_retention_days: resource_policy.cache_retention_days,
            log_retention_days: resource_policy.log_retention_days,
        })
    }

    pub(crate) fn run_manual(
        &self,
        app: &AppHandle,
        request: CleanupRequest,
    ) -> Result<CleanupResult, String> {
        let _guard = self.start_run()?;
        if request.targets.is_empty() {
            return Err("请至少选择一个清理目标".to_string());
        }
        if !request.permanent && request.targets.contains(&CleanupTarget::Recovery) {
            return Err("恢复区只能通过彻底删除清空".to_string());
        }
        let layout = app.state::<StorageManager>().layout()?;
        if !layout.writable {
            return Err("数据目录不可写，无法执行清理".to_string());
        }
        run_cleanup(&layout, &request.targets, request.permanent)
    }

    pub(crate) fn restore_latest(&self, app: &AppHandle) -> Result<CleanupResult, String> {
        let _guard = self.start_run()?;
        let layout = app.state::<StorageManager>().layout()?;
        let batch_id = latest_recovery_batch(&layout.recovery)?
            .ok_or_else(|| "没有可恢复的清理批次".to_string())?;
        restore_batch(&layout, &batch_id)
    }

    pub(crate) fn should_run_automatic(&self, now: i64) -> bool {
        let policy = self.policy();
        policy.automatic_enabled
            && policy
                .last_automatic_run_at
                .is_none_or(|last| now.saturating_sub(last) >= AUTO_CLEANUP_INTERVAL_SECONDS)
    }

    pub(crate) fn run_automatic_if_due(
        &self,
        app: &AppHandle,
    ) -> Result<Option<CleanupResult>, String> {
        let now = Utc::now().timestamp();
        if !self.should_run_automatic(now) {
            return Ok(None);
        }
        let _guard = self.start_run()?;
        let layout = app.state::<StorageManager>().layout()?;
        if !layout.writable {
            return Err("数据目录不可写，无法执行自动清理".to_string());
        }
        let resource_policy = app.state::<ResourceGovernor>().policy();
        let result = run_aged_cleanup(
            &layout,
            resource_policy.cache_retention_days,
            resource_policy.log_retention_days,
        )?;

        let previous = self.policy();
        let mut next = previous.clone();
        next.last_automatic_run_at = Some(now);
        *self
            .policy
            .write()
            .map_err(|_| "清理策略状态不可用".to_string())? = next.clone();
        if let Err(error) = self.persist_policy(app, &next) {
            if let Ok(mut policy) = self.policy.write() {
                *policy = previous;
            }
            return Err(error);
        }
        Ok(Some(result))
    }

    fn start_run(&self) -> Result<RunningGuard<'_>, String> {
        self.running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "已有清理任务正在运行".to_string())?;
        Ok(RunningGuard(&self.running))
    }

    fn persist_policy(&self, app: &AppHandle, policy: &CleanupPolicy) -> Result<(), String> {
        let path = app
            .state::<StorageManager>()
            .config_file(CLEANUP_POLICY_FILE)?;
        let serialized = serde_json::to_vec_pretty(policy)
            .map_err(|error| format!("序列化清理策略失败: {error}"))?;
        fs::write(path, serialized).map_err(|error| format!("保存清理策略失败: {error}"))
    }
}

fn run_cleanup(
    layout: &super::storage::StorageLayout,
    targets: &[CleanupTarget],
    permanent: bool,
) -> Result<CleanupResult, String> {
    let batch_id = (!permanent).then(new_batch_id);
    let batch_root = batch_id.as_ref().map(|id| layout.recovery.join(id));
    let mut files_processed = 0_u64;
    let mut bytes_processed = 0_u64;

    for target in targets {
        let source = target.directory(layout);
        ensure_real_directory_within(source, &layout.root)?;
        if permanent {
            let stats = delete_directory_contents(source)?;
            files_processed = files_processed.saturating_add(stats.0);
            bytes_processed = bytes_processed.saturating_add(stats.1);
        } else {
            let destination = batch_root
                .as_ref()
                .expect("safe cleanup has a recovery batch")
                .join(target.recovery_name());
            let stats = move_directory_contents(source, &destination)?;
            files_processed = files_processed.saturating_add(stats.0);
            bytes_processed = bytes_processed.saturating_add(stats.1);
        }
    }

    if let Some(root) = &batch_root {
        if files_processed == 0 {
            let _ = fs::remove_dir_all(root);
        }
    }
    Ok(CleanupResult {
        permanent,
        files_processed,
        bytes_processed,
        recovery_batch_id: (files_processed > 0).then_some(batch_id).flatten(),
    })
}

fn run_aged_cleanup(
    layout: &super::storage::StorageLayout,
    cache_days: u32,
    log_days: u32,
) -> Result<CleanupResult, String> {
    let batch_id = new_batch_id();
    let batch_root = layout.recovery.join(&batch_id);
    let mut files_processed = 0_u64;
    let mut bytes_processed = 0_u64;
    for (source, name, days) in [
        (&layout.cache, "cache", cache_days),
        (&layout.logs, "logs", log_days),
    ] {
        ensure_real_directory_within(source, &layout.root)?;
        let cutoff = SystemTime::now()
            .checked_sub(Duration::from_secs(u64::from(days) * 24 * 60 * 60))
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let stats = move_aged_files(source, &batch_root.join(name), cutoff)?;
        files_processed = files_processed.saturating_add(stats.0);
        bytes_processed = bytes_processed.saturating_add(stats.1);
    }
    if files_processed == 0 {
        let _ = fs::remove_dir_all(&batch_root);
    }
    Ok(CleanupResult {
        permanent: false,
        files_processed,
        bytes_processed,
        recovery_batch_id: (files_processed > 0).then_some(batch_id),
    })
}

fn move_directory_contents(source: &Path, destination: &Path) -> Result<(u64, u64), String> {
    let mut totals = (0_u64, 0_u64);
    for entry in read_entries(source)? {
        let path = entry.path();
        let metadata = path
            .symlink_metadata()
            .map_err(|error| format!("读取文件信息失败: {error}"))?;
        if is_link_like(&metadata) {
            continue;
        }
        let stats = path_stats(&path)?;
        fs::create_dir_all(destination).map_err(|error| format!("创建恢复目录失败: {error}"))?;
        let target = unique_destination(&destination.join(entry.file_name()));
        fs::rename(&path, &target)
            .map_err(|error| format!("移动到恢复区失败（{}）: {error}", path.display()))?;
        totals.0 = totals.0.saturating_add(stats.0);
        totals.1 = totals.1.saturating_add(stats.1);
    }
    Ok(totals)
}

fn move_aged_files(
    source: &Path,
    destination: &Path,
    cutoff: SystemTime,
) -> Result<(u64, u64), String> {
    if !source.is_dir() {
        return Ok((0, 0));
    }
    let mut totals = (0_u64, 0_u64);
    let mut pending = vec![source.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in read_entries(&directory)? {
            let path = entry.path();
            let metadata = path
                .symlink_metadata()
                .map_err(|error| format!("读取文件信息失败: {error}"))?;
            if is_link_like(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if metadata.modified().unwrap_or(SystemTime::now()) > cutoff {
                continue;
            }
            let relative = path
                .strip_prefix(source)
                .map_err(|_| "清理路径越过受管目录".to_string())?;
            let target = destination.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建恢复目录失败: {error}"))?;
            }
            let target = unique_destination(&target);
            fs::rename(&path, target)
                .map_err(|error| format!("移动过期文件失败（{}）: {error}", path.display()))?;
            totals.0 = totals.0.saturating_add(1);
            totals.1 = totals.1.saturating_add(metadata.len());
        }
    }
    for entry in read_entries(source)? {
        let path = entry.path();
        let metadata = path
            .symlink_metadata()
            .map_err(|error| format!("读取文件信息失败: {error}"))?;
        if metadata.is_dir() && !is_link_like(&metadata) {
            remove_empty_directories(&path)?;
        }
    }
    Ok(totals)
}

fn delete_directory_contents(source: &Path) -> Result<(u64, u64), String> {
    let mut totals = (0_u64, 0_u64);
    for entry in read_entries(source)? {
        let path = entry.path();
        let stats = delete_path(&path)?;
        totals.0 = totals.0.saturating_add(stats.0);
        totals.1 = totals.1.saturating_add(stats.1);
    }
    Ok(totals)
}

fn restore_batch(
    layout: &super::storage::StorageLayout,
    batch_id: &str,
) -> Result<CleanupResult, String> {
    if !is_safe_batch_id(batch_id) {
        return Err("恢复批次标识无效".to_string());
    }
    let batch = layout.recovery.join(batch_id);
    if !batch.exists() {
        return Err("恢复批次不存在".to_string());
    }
    ensure_real_directory_within(&batch, &layout.recovery)?;
    let mut totals = (0_u64, 0_u64);
    for (name, destination) in [("cache", &layout.cache), ("logs", &layout.logs)] {
        let source = batch.join(name);
        if !source.exists() {
            continue;
        }
        ensure_real_directory_within(&source, &batch)?;
        ensure_real_directory_within(destination, &layout.root)?;
        let stats = move_directory_contents(&source, destination)?;
        totals.0 = totals.0.saturating_add(stats.0);
        totals.1 = totals.1.saturating_add(stats.1);
    }
    let _ = fs::remove_dir_all(&batch);
    Ok(CleanupResult {
        permanent: false,
        files_processed: totals.0,
        bytes_processed: totals.1,
        recovery_batch_id: Some(batch_id.to_string()),
    })
}

fn latest_recovery_batch(recovery: &Path) -> Result<Option<String>, String> {
    if !recovery.is_dir() {
        return Ok(None);
    }
    ensure_real_directory_within(recovery, recovery)?;
    let mut names = read_entries(recovery)?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = entry.path().symlink_metadata().ok()?;
            (metadata.is_dir() && !is_link_like(&metadata) && is_safe_batch_id(&name))
                .then_some(name)
        })
        .collect::<Vec<_>>();
    names.sort_unstable();
    Ok(names.pop())
}

fn new_batch_id() -> String {
    format!(
        "cleanup-{}-{}",
        Utc::now().format("%Y%m%d%H%M%S%3f"),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    )
}

fn is_safe_batch_id(value: &str) -> bool {
    value.starts_with("cleanup-")
        && value.len() <= 48
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn read_entries(path: &Path) -> Result<Vec<fs::DirEntry>, String> {
    if !path.is_dir() {
        return Ok(Vec::new());
    }
    fs::read_dir(path)
        .map_err(|error| format!("读取目录失败（{}）: {error}", path.display()))?
        .map(|entry| entry.map_err(|error| format!("读取目录项失败: {error}")))
        .collect()
}

fn ensure_real_directory_within(path: &Path, boundary: &Path) -> Result<(), String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("读取受管目录失败（{}）: {error}", path.display()))?;
    if !metadata.is_dir() || is_link_like(&metadata) {
        return Err(format!("拒绝清理符号链接或非目录路径: {}", path.display()));
    }
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("规范化受管目录失败（{}）: {error}", path.display()))?;
    let canonical_boundary = boundary
        .canonicalize()
        .map_err(|error| format!("规范化存储边界失败（{}）: {error}", boundary.display()))?;
    if !canonical_path.starts_with(&canonical_boundary) {
        return Err(format!("清理路径越过受管目录: {}", path.display()));
    }
    Ok(())
}

fn path_stats(path: &Path) -> Result<(u64, u64), String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("读取文件信息失败: {error}"))?;
    if is_link_like(&metadata) {
        return Ok((0, 0));
    }
    if metadata.is_file() {
        return Ok((1, metadata.len()));
    }
    let mut totals = (0_u64, 0_u64);
    for entry in read_entries(path)? {
        let stats = path_stats(&entry.path())?;
        totals.0 = totals.0.saturating_add(stats.0);
        totals.1 = totals.1.saturating_add(stats.1);
    }
    Ok(totals)
}

fn unique_destination(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    for index in 1..=10_000_u32 {
        let candidate = parent.join(format!("{name}.restored-{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{name}.restored-{}", uuid::Uuid::new_v4()))
}

fn remove_empty_directories(root: &Path) -> Result<bool, String> {
    if !root.is_dir() {
        return Ok(false);
    }
    let mut empty = true;
    for entry in read_entries(root)? {
        let path = entry.path();
        let metadata = path
            .symlink_metadata()
            .map_err(|error| format!("读取文件信息失败: {error}"))?;
        if metadata.is_dir() && !is_link_like(&metadata) {
            if !remove_empty_directories(&path)? {
                empty = false;
            }
        } else {
            empty = false;
        }
    }
    if empty {
        fs::remove_dir(root)
            .map_err(|error| format!("移除空目录失败（{}）: {error}", root.display()))?;
    }
    Ok(empty)
}

fn delete_path(path: &Path) -> Result<(u64, u64), String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("读取文件信息失败: {error}"))?;
    if is_link_like(&metadata) {
        let result = if metadata.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        };
        result.map_err(|error| format!("删除链接失败（{}）: {error}", path.display()))?;
        return Ok((1, 0));
    }
    if metadata.is_file() {
        fs::remove_file(path)
            .map_err(|error| format!("彻底删除失败（{}）: {error}", path.display()))?;
        return Ok((1, metadata.len()));
    }

    let mut totals = (0_u64, 0_u64);
    for entry in read_entries(path)? {
        let stats = delete_path(&entry.path())?;
        totals.0 = totals.0.saturating_add(stats.0);
        totals.1 = totals.1.saturating_add(stats.1);
    }
    fs::remove_dir(path)
        .map_err(|error| format!("彻底删除目录失败（{}）: {error}", path.display()))?;
    Ok(totals)
}

fn is_link_like(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

#[tauri::command]
pub(crate) fn get_cleanup_status(
    app: AppHandle,
    manager: tauri::State<'_, CleanupManager>,
) -> Result<CleanupStatus, String> {
    manager.status(&app)
}

#[tauri::command]
pub(crate) fn set_automatic_cleanup_enabled(
    app: AppHandle,
    manager: tauri::State<'_, CleanupManager>,
    enabled: bool,
) -> Result<CleanupPolicy, String> {
    manager.set_automatic_enabled(&app, enabled)
}

#[tauri::command]
pub(crate) fn set_cleanup_retention_days(
    app: AppHandle,
    cache_days: u32,
    log_days: u32,
) -> Result<(), String> {
    if !(1..=365).contains(&cache_days) || !(1..=365).contains(&log_days) {
        return Err("缓存和日志保留天数必须在 1 到 365 天之间".to_string());
    }
    let governor = app.state::<ResourceGovernor>();
    let mut policy = governor.policy();
    policy.cache_retention_days = cache_days;
    policy.log_retention_days = log_days;
    governor.replace_policy(&app, policy)
}

#[tauri::command]
pub(crate) async fn run_storage_cleanup(
    app: AppHandle,
    request: CleanupRequest,
) -> Result<CleanupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<CleanupManager>().run_manual(&app, request)
    })
    .await
    .map_err(|error| format!("清理任务异常结束: {error}"))?
}

#[tauri::command]
pub(crate) async fn restore_latest_cleanup(app: AppHandle) -> Result<CleanupResult, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<CleanupManager>().restore_latest(&app))
        .await
        .map_err(|error| format!("恢复任务异常结束: {error}"))?
}

pub(crate) fn schedule_automatic_cleanup(app: &AppHandle) {
    if !app
        .state::<CleanupManager>()
        .should_run_automatic(Utc::now().timestamp())
    {
        return;
    }
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = app_handle
            .state::<CleanupManager>()
            .run_automatic_if_due(&app_handle)
        {
            eprintln!("[CleanupManager] 自动清理失败: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_layout(name: &str) -> super::super::storage::StorageLayout {
        let root =
            std::env::temp_dir().join(format!("dtkit-cleanup-{name}-{}", uuid::Uuid::new_v4()));
        let layout = super::super::storage::StorageLayout::from_root(
            super::super::storage::StorageMode::Standard,
            root,
        );
        for directory in layout.managed_directories() {
            fs::create_dir_all(directory).unwrap();
        }
        layout
    }

    #[test]
    fn safe_cleanup_moves_files_to_a_restorable_batch() {
        let layout = test_layout("safe");
        fs::write(layout.cache.join("cache.bin"), vec![0_u8; 12]).unwrap();
        fs::create_dir_all(layout.logs.join("nested")).unwrap();
        fs::write(layout.logs.join("nested/app.log"), vec![0_u8; 7]).unwrap();

        let result =
            run_cleanup(&layout, &[CleanupTarget::Cache, CleanupTarget::Logs], false).unwrap();
        assert_eq!(result.files_processed, 2);
        assert_eq!(result.bytes_processed, 19);
        assert!(!layout.cache.join("cache.bin").exists());

        let restored =
            restore_batch(&layout, result.recovery_batch_id.as_deref().unwrap()).unwrap();
        assert_eq!(restored.files_processed, 2);
        assert!(layout.cache.join("cache.bin").is_file());
        assert!(layout.logs.join("nested/app.log").is_file());
        fs::remove_dir_all(layout.root).unwrap();
    }

    #[test]
    fn permanent_cleanup_deletes_only_selected_managed_contents() {
        let layout = test_layout("permanent");
        fs::write(layout.cache.join("remove.bin"), vec![0_u8; 5]).unwrap();
        fs::write(layout.logs.join("keep.log"), vec![0_u8; 9]).unwrap();
        let result = run_cleanup(&layout, &[CleanupTarget::Cache], true).unwrap();
        assert!(result.permanent);
        assert_eq!(result.bytes_processed, 5);
        assert!(!layout.cache.join("remove.bin").exists());
        assert!(layout.logs.join("keep.log").is_file());
        fs::remove_dir_all(layout.root).unwrap();
    }

    #[test]
    fn batch_ids_reject_traversal() {
        assert!(is_safe_batch_id("cleanup-20260101000000000-deadbeef"));
        assert!(!is_safe_batch_id("../cleanup-anything"));
        assert!(!is_safe_batch_id("cleanup/anything"));
    }

    #[test]
    fn canonical_directory_check_rejects_paths_outside_the_boundary() {
        let layout = test_layout("boundary");
        let outside = std::env::temp_dir();
        assert!(ensure_real_directory_within(&layout.cache, &layout.root).is_ok());
        assert!(ensure_real_directory_within(&outside, &layout.root).is_err());
        fs::remove_dir_all(layout.root).unwrap();
    }

    #[test]
    fn automatic_cleanup_has_no_polling_and_runs_at_most_daily() {
        let manager = CleanupManager::default();
        assert!(!manager.should_run_automatic(100_000));
        *manager.policy.write().unwrap() = CleanupPolicy {
            automatic_enabled: true,
            last_automatic_run_at: Some(100_000),
        };
        assert!(!manager.should_run_automatic(100_001));
        assert!(manager.should_run_automatic(100_000 + AUTO_CLEANUP_INTERVAL_SECONDS));
    }
}
