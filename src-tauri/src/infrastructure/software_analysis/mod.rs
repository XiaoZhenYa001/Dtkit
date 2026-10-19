mod catalog;
mod manager;
#[cfg(target_os = "windows")]
mod native;
mod paths;
mod scanner;
#[cfg(test)]
mod tests;

pub(crate) use manager::SoftwareAnalysisManager;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewWindow};

const TOOL_ID: &str = "software-analysis";

fn enumerate_platform() -> Result<SoftwareSnapshot, String> {
    #[cfg(target_os = "windows")]
    return native::enumerate();
    #[cfg(not(target_os = "windows"))]
    Err("软件分析目前仅支持 Windows".into())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Software {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) version: Option<String>,
    pub(super) publisher: Option<String>,
    pub(super) install_location: Option<String>,
    pub(super) estimated_bytes: Option<u64>,
    pub(super) install_date: Option<String>,
    pub(super) scope: String,
    pub(super) source: String,
    pub(super) can_analyze: bool,
    pub(super) reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SoftwareSnapshot {
    pub(super) items: Vec<Software>,
    pub(super) scanned_at: i64,
    pub(super) warnings: Vec<String>,
    pub(super) cached: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpaceItem {
    path: String,
    bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpaceReport {
    request_id: String,
    software_id: Option<String>,
    root: String,
    total_bytes: u64,
    files: u64,
    directories: u64,
    skipped: u64,
    complete: bool,
    cancelled: bool,
    elapsed_ms: u64,
    largest_directories: Vec<SpaceItem>,
    largest_files: Vec<SpaceItem>,
    warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SpaceProgress {
    request_id: String,
    files: u64,
    directories: u64,
    total_bytes: u64,
    skipped: u64,
    elapsed_ms: u64,
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn authorize_window(window: &WebviewWindow, instance_id: Option<&str>) -> Result<(), String> {
    if window.label() != "main" && !window.label().starts_with("quick-host-") {
        return Err("此窗口不能使用软件分析".into());
    }
    if instance_id.is_some_and(|id| !valid_token(id)) {
        return Err("软件分析页面标识无效".into());
    }
    Ok(())
}

fn authorize(window: &WebviewWindow, instance_id: Option<&str>) -> Result<(), String> {
    authorize_window(window, instance_id)?;
    if !window
        .state::<super::tool_modules::ToolModuleManager>()
        .is_enabled(TOOL_ID)
    {
        return Err("软件分析工具已停用".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn release_software_analysis(
    window: WebviewWindow,
    instance_id: Option<String>,
) -> Result<(), String> {
    authorize_window(&window, instance_id.as_deref())?;
    window
        .state::<SoftwareAnalysisManager>()
        .release_idle_cache();
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_installed_software(
    window: WebviewWindow,
    refresh: bool,
    instance_id: Option<String>,
) -> Result<SoftwareSnapshot, String> {
    authorize(&window, instance_id.as_deref())?;
    let app = window.app_handle().clone();
    let manager = app.state::<SoftwareAnalysisManager>();
    if !refresh {
        if let Some(snapshot) = manager.cached()? {
            return Ok(snapshot);
        }
    }
    // Reserve before submitting blocking work, so repeated clicks cannot queue workers.
    let lease = manager.reserve_list()?;
    let generation = manager.cache_generation();
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        authorize(&window, instance_id.as_deref())?;
        let manager = app.state::<SoftwareAnalysisManager>();
        let snapshot = enumerate_platform()?;
        authorize(&window, instance_id.as_deref())?;
        manager.store_cache(snapshot.clone(), generation)?;
        Ok(snapshot)
    })
    .await
    .map_err(|error| format!("软件列表读取任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn analyze_software_space(
    window: WebviewWindow,
    request_id: String,
    software_id: Option<String>,
    path: Option<String>,
    instance_id: Option<String>,
) -> Result<SpaceReport, String> {
    authorize(&window, instance_id.as_deref())?;
    if !valid_token(&request_id) {
        return Err("扫描请求标识无效".into());
    }
    let app = window.app_handle().clone();
    let manager = app.state::<SoftwareAnalysisManager>();
    let root = match &software_id {
        Some(id) => manager.resolve_path(id)?,
        None => path.ok_or("请选择软件目录")?,
    };
    paths::validate_lexical(&root)?;
    let (lease, cancelled) = manager.reserve_scan(window.label(), &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        authorize(&window, instance_id.as_deref())?;
        if cancelled.load(Ordering::Acquire) {
            return Ok(scanner::cancelled_report(request_id, software_id, root));
        }
        let root = paths::validate_root(&root)?;
        scanner::scan(
            root,
            request_id,
            software_id,
            &cancelled,
            scanner::Budget::default(),
            |progress| {
                // Progress belongs to the invoking window and is limited to four emissions/sec.
                if window.emit("software-analysis-progress", progress).is_err() {
                    cancelled.store(true, Ordering::Release);
                }
            },
        )
    })
    .await
    .map_err(|error| format!("软件空间扫描任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn cancel_software_analysis(
    window: WebviewWindow,
    request_id: String,
    instance_id: Option<String>,
) -> Result<bool, String> {
    authorize(&window, instance_id.as_deref())?;
    if !valid_token(&request_id) {
        return Err("扫描请求标识无效".into());
    }
    window
        .state::<SoftwareAnalysisManager>()
        .cancel_request(window.label(), &request_id)
}

#[tauri::command]
pub(crate) async fn reveal_software_location(
    window: WebviewWindow,
    path: String,
    instance_id: Option<String>,
) -> Result<(), String> {
    authorize(&window, instance_id.as_deref())?;
    paths::validate_lexical(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        authorize(&window, instance_id.as_deref())?;
        let path = paths::validate_location(&path)?;
        #[cfg(target_os = "windows")]
        return native::reveal(&path);
        #[cfg(not(target_os = "windows"))]
        {
            let _ = path;
            Err("软件位置定位目前仅支持 Windows".into())
        }
    })
    .await
    .map_err(|error| format!("软件位置定位任务异常：{error}"))?
}
