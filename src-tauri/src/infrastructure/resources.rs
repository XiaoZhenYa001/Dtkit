use super::jobs::JobManager;
use super::quick_host::QuickHostManager;
use super::shortcuts::ShortcutRegistry;
use super::storage::{StorageManager, StorageUsage};
use super::transfer_station::TransferStationManager;
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::RwLock;
use tauri::{AppHandle, Manager};

const RESOURCE_POLICY_FILE: &str = "resource-policy.json";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MinimizeMode {
    Standard,
    #[default]
    Efficient,
    Deep,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourcePolicy {
    pub(crate) quick_host_standard_retention_seconds: u64,
    pub(crate) quick_host_efficient_retention_seconds: u64,
    pub(crate) max_workers_on_battery: usize,
    pub(crate) max_workers_on_ac: usize,
    pub(crate) cache_limit_bytes: u64,
    pub(crate) cache_retention_days: u32,
    pub(crate) log_retention_days: u32,
}

impl Default for ResourcePolicy {
    fn default() -> Self {
        Self {
            quick_host_standard_retention_seconds: 60,
            quick_host_efficient_retention_seconds: 10,
            max_workers_on_battery: 2,
            max_workers_on_ac: 4,
            cache_limit_bytes: 100 * 1024 * 1024,
            cache_retention_days: 7,
            log_retention_days: 7,
        }
    }
}

impl ResourcePolicy {
    fn validate(&self) -> Result<(), String> {
        if self.quick_host_standard_retention_seconds > 600
            || self.quick_host_efficient_retention_seconds > 120
        {
            return Err("快捷窗口保留时间超出允许范围".to_string());
        }
        if !(1..=16).contains(&self.max_workers_on_battery)
            || !(1..=32).contains(&self.max_workers_on_ac)
            || self.max_workers_on_battery > self.max_workers_on_ac
        {
            return Err("后台任务并发设置无效".to_string());
        }
        if self.cache_limit_bytes < 10 * 1024 * 1024
            || self.cache_limit_bytes > 10 * 1024 * 1024 * 1024
        {
            return Err("缓存上限超出允许范围".to_string());
        }
        if self.cache_retention_days > 365 || self.log_retention_days > 365 {
            return Err("保留天数超出允许范围".to_string());
        }
        Ok(())
    }
}

pub(crate) struct ResourceGovernor {
    mode: RwLock<MinimizeMode>,
    policy: RwLock<ResourcePolicy>,
}

impl Default for ResourceGovernor {
    fn default() -> Self {
        Self {
            mode: RwLock::new(MinimizeMode::default()),
            policy: RwLock::new(ResourcePolicy::default()),
        }
    }
}

impl ResourceGovernor {
    pub(crate) fn restore(&self, app: &AppHandle) -> Result<(), String> {
        let path = app
            .state::<StorageManager>()
            .config_file(RESOURCE_POLICY_FILE)?;
        if !path.is_file() {
            return Ok(());
        }
        let serialized =
            fs::read_to_string(path).map_err(|error| format!("读取资源策略失败: {error}"))?;
        let policy = serde_json::from_str(&serialized)
            .map_err(|error| format!("资源策略格式无效: {error}"))?;
        self.set_policy(policy)
    }

    pub(crate) fn mode(&self) -> MinimizeMode {
        self.mode.read().map(|mode| *mode).unwrap_or_default()
    }

    pub(crate) fn set_mode(&self, mode: MinimizeMode) -> Result<(), String> {
        *self
            .mode
            .write()
            .map_err(|_| "资源控制器状态不可用".to_string())? = mode;
        Ok(())
    }

    pub(crate) fn policy(&self) -> ResourcePolicy {
        self.policy
            .read()
            .map(|policy| policy.clone())
            .unwrap_or_default()
    }

    pub(crate) fn set_policy(&self, policy: ResourcePolicy) -> Result<(), String> {
        policy.validate()?;
        *self
            .policy
            .write()
            .map_err(|_| "资源控制器状态不可用".to_string())? = policy;
        Ok(())
    }

    pub(crate) fn replace_policy(
        &self,
        app: &AppHandle,
        policy: ResourcePolicy,
    ) -> Result<(), String> {
        policy.validate()?;
        let previous = self.policy();
        self.set_policy(policy.clone())?;
        let persist_result = (|| {
            let path = app
                .state::<StorageManager>()
                .config_file(RESOURCE_POLICY_FILE)?;
            let serialized = serde_json::to_vec_pretty(&policy)
                .map_err(|error| format!("序列化资源策略失败: {error}"))?;
            fs::write(path, serialized).map_err(|error| format!("保存资源策略失败: {error}"))
        })();
        if let Err(error) = persist_result {
            let _ = self.set_policy(previous);
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn quick_host_retention_seconds(&self) -> u64 {
        let policy = self.policy();
        match self.mode() {
            MinimizeMode::Standard => policy.quick_host_standard_retention_seconds,
            MinimizeMode::Efficient => policy.quick_host_efficient_retention_seconds,
            MinimizeMode::Deep => 0,
        }
    }

    pub(crate) fn effective_worker_limit(&self) -> usize {
        let policy = self.policy();
        worker_limit_for_source(&policy, current_power_source())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PowerSource {
    Ac,
    Battery,
    Unknown,
}

fn power_source_from_ac_line_status(status: u8) -> PowerSource {
    match status {
        0 => PowerSource::Battery,
        1 => PowerSource::Ac,
        _ => PowerSource::Unknown,
    }
}

fn worker_limit_for_source(policy: &ResourcePolicy, source: PowerSource) -> usize {
    match source {
        PowerSource::Ac => policy.max_workers_on_ac,
        PowerSource::Battery | PowerSource::Unknown => policy.max_workers_on_battery,
    }
}

#[cfg(windows)]
fn current_power_source() -> PowerSource {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_ok() {
        power_source_from_ac_line_status(status.ACLineStatus)
    } else {
        PowerSource::Unknown
    }
}

#[cfg(not(windows))]
fn current_power_source() -> PowerSource {
    PowerSource::Unknown
}

#[cfg(windows)]
fn process_working_set_bytes() -> Option<u64> {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    }
    .ok()
    .map(|_| counters.WorkingSetSize as u64)
}

#[cfg(not(windows))]
fn process_working_set_bytes() -> Option<u64> {
    None
}

#[cfg(windows)]
fn trim_native_working_set() -> bool {
    use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe { EmptyWorkingSet(GetCurrentProcess()) }.is_ok()
}

#[cfg(not(windows))]
fn trim_native_working_set() -> bool {
    false
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceSnapshot {
    mode: MinimizeMode,
    captured_at: i64,
    power_source: PowerSource,
    effective_worker_limit: usize,
    native_working_set_bytes: Option<u64>,
    webview_count: usize,
    main_window_open: bool,
    quick_host_open: bool,
    active_jobs: usize,
    recorded_jobs: usize,
    registered_shortcuts: usize,
    lan_share_active: bool,
    storage: StorageUsage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceReleaseResult {
    quick_host_released: bool,
    hidden_organizer_released: bool,
    native_working_set_trimmed: bool,
}

#[tauri::command]
pub(crate) fn set_minimize_mode(
    governor: tauri::State<'_, ResourceGovernor>,
    mode: MinimizeMode,
) -> Result<(), String> {
    governor.set_mode(mode)
}

#[tauri::command]
pub(crate) fn get_resource_policy(governor: tauri::State<'_, ResourceGovernor>) -> ResourcePolicy {
    governor.policy()
}

#[tauri::command]
pub(crate) fn set_resource_policy(
    app: AppHandle,
    governor: tauri::State<'_, ResourceGovernor>,
    policy: ResourcePolicy,
) -> Result<(), String> {
    governor.replace_policy(&app, policy)
}

#[tauri::command]
pub(crate) async fn get_resource_snapshot(app: AppHandle) -> Result<ResourceSnapshot, String> {
    let governor = app.state::<ResourceGovernor>();
    let jobs = app.state::<JobManager>();
    let shortcuts = app.state::<ShortcutRegistry>();
    let job_records = jobs.snapshot()?;
    Ok(ResourceSnapshot {
        mode: governor.mode(),
        captured_at: chrono::Utc::now().timestamp_millis(),
        power_source: current_power_source(),
        effective_worker_limit: governor.effective_worker_limit(),
        native_working_set_bytes: process_working_set_bytes(),
        webview_count: app.webview_windows().len(),
        main_window_open: app.get_webview_window("main").is_some(),
        quick_host_open: app.get_webview_window("quick-host").is_some(),
        active_jobs: jobs.active_count(),
        recorded_jobs: job_records.len(),
        registered_shortcuts: shortcuts.binding_count(),
        lan_share_active: app
            .state::<TransferStationManager>()
            .has_active_share()
            .await,
        storage: app.state::<StorageManager>().usage()?,
    })
}

#[tauri::command]
pub(crate) async fn release_idle_resources(
    app: AppHandle,
) -> Result<ResourceReleaseResult, String> {
    let quick_host_released = app.get_webview_window("quick-host").is_some();
    if quick_host_released {
        let release_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            release_app
                .state::<QuickHostManager>()
                .release_now(&release_app);
        });
    }
    let hidden_organizer_released =
        app.get_webview_window("desktop-organizer")
            .is_some_and(|window| {
                if window.is_visible().unwrap_or(true) {
                    false
                } else {
                    window.close().is_ok()
                }
            });
    Ok(ResourceReleaseResult {
        quick_host_released,
        hidden_organizer_released,
        native_working_set_trimmed: trim_native_working_set(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_low_resource_product_policy() {
        let governor = ResourceGovernor::default();
        assert_eq!(governor.mode(), MinimizeMode::Efficient);
        assert_eq!(governor.quick_host_retention_seconds(), 10);
        assert_eq!(governor.policy().max_workers_on_battery, 2);
        assert_eq!(governor.policy().max_workers_on_ac, 4);
    }

    #[test]
    fn deep_mode_releases_the_quick_host_immediately() {
        let governor = ResourceGovernor::default();
        governor.set_mode(MinimizeMode::Deep).unwrap();
        assert_eq!(governor.quick_host_retention_seconds(), 0);
    }

    #[test]
    fn invalid_worker_and_cache_limits_are_rejected() {
        let governor = ResourceGovernor::default();
        let mut policy = governor.policy();
        policy.max_workers_on_battery = 8;
        policy.max_workers_on_ac = 4;
        assert!(governor.set_policy(policy).is_err());
        let mut policy = ResourcePolicy::default();
        policy.cache_limit_bytes = 1;
        assert!(governor.set_policy(policy).is_err());
    }

    #[test]
    fn power_status_mapping_is_explicit_and_unknown_uses_safe_fallback() {
        assert_eq!(power_source_from_ac_line_status(0), PowerSource::Battery);
        assert_eq!(power_source_from_ac_line_status(1), PowerSource::Ac);
        assert_eq!(power_source_from_ac_line_status(255), PowerSource::Unknown);
        let policy = ResourcePolicy::default();
        assert_eq!(worker_limit_for_source(&policy, PowerSource::Ac), 4);
        assert_eq!(worker_limit_for_source(&policy, PowerSource::Battery), 2);
        assert_eq!(worker_limit_for_source(&policy, PowerSource::Unknown), 2);
    }
}
