use super::tool_modules::ToolModuleManager;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(crate) const QUICK_HOST_LABEL_PREFIX: &str = "quick-host-";
const PALETTE_IDLE_TIMEOUT_SECONDS: u64 = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum QuickHostKind {
    Tool,
    Palette,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickHostTarget {
    pub(crate) kind: QuickHostKind,
    #[serde(default)]
    pub(crate) tool_id: Option<String>,
}

impl QuickHostTarget {
    pub(crate) fn tool(tool_id: String) -> Result<Self, String> {
        if !is_supported_tool_id(&tool_id) {
            return Err("工具标识无效".to_string());
        }
        Ok(Self {
            kind: QuickHostKind::Tool,
            tool_id: Some(tool_id),
        })
    }

    pub(crate) fn palette() -> Self {
        Self {
            kind: QuickHostKind::Palette,
            tool_id: None,
        }
    }

    fn validate(&self) -> Result<(), String> {
        match self.kind {
            QuickHostKind::Tool => {
                if self.tool_id.as_deref().is_some_and(is_supported_tool_id) {
                    Ok(())
                } else {
                    Err("工具快捷窗口缺少有效工具标识".to_string())
                }
            }
            QuickHostKind::Palette if self.tool_id.is_none() => Ok(()),
            QuickHostKind::Palette => Err("命令面板目标不能包含工具标识".to_string()),
        }
    }

    fn initial_url(&self, instance_id: &str) -> String {
        match self.kind {
            QuickHostKind::Palette => format!("quick.html?kind=palette&instanceId={instance_id}"),
            QuickHostKind::Tool => format!(
                "quick.html?kind=tool&toolId={}&instanceId={instance_id}",
                self.tool_id.as_deref().unwrap_or_default(),
            ),
        }
    }
}

#[derive(Default)]
pub(crate) struct QuickHostManager {
    next_label: AtomicU64,
    active_labels: RwLock<HashSet<String>>,
    palette_activity: RwLock<HashMap<String, Instant>>,
    next_close_token: AtomicU64,
    pending_close: RwLock<HashMap<String, u64>>,
    retained_labels: RwLock<HashSet<String>>,
}

impl QuickHostManager {
    pub(crate) fn has_active_content(&self) -> bool {
        self.active_labels
            .read()
            .map(|labels| !labels.is_empty())
            .unwrap_or(true)
    }

    pub(crate) fn open(
        &self,
        app: &AppHandle,
        target: QuickHostTarget,
    ) -> Result<WebviewWindow, String> {
        target.validate()?;
        let is_palette = target.kind == QuickHostKind::Palette;
        let sequence = self.next_label.fetch_add(1, Ordering::Relaxed) + 1;
        let label = format!("{QUICK_HOST_LABEL_PREFIX}{sequence}");
        let window = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(target.initial_url(&label).into()),
        )
        .title("DtKit 快捷窗口")
        .inner_size(760.0, 580.0)
        .min_inner_size(560.0, 400.0)
        .resizable(true)
        .decorations(false)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .shadow(true)
        .center()
        .build()
        .map_err(|error| format!("创建快捷宿主失败: {error}"))?;
        self.active_labels
            .write()
            .map_err(|_| "快捷宿主状态不可用".to_string())?
            .insert(label);
        if is_palette {
            self.palette_activity
                .write()
                .map_err(|_| "快捷面板活动状态不可用".to_string())?
                .insert(window.label().to_string(), Instant::now());
            spawn_palette_idle_guard(app.clone(), window.label().to_string());
        }
        let app_handle = app.clone();
        let window_label = window.label().to_string();
        let suspended = Arc::new(AtomicBool::new(false));
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                if let Some(window) = app_handle.get_webview_window(&window_label) {
                    let minimized = window.is_minimized().unwrap_or(false);
                    if suspended.swap(minimized, Ordering::Relaxed) != minimized {
                        crate::set_webview_memory_target(&window, minimized);
                        let _ = app_handle.emit_to(
                            &window_label,
                            "app-power-state",
                            serde_json::json!({ "suspended": minimized, "closing": false }),
                        );
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = app_handle
                    .state::<QuickHostManager>()
                    .request_close(&app_handle, &window_label)
                {
                    eprintln!("[QuickHost] 无法请求保存工具页面: {error}");
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                app_handle
                    .state::<QuickHostManager>()
                    .remove_label(&window_label);
            }
        });
        Ok(window)
    }

    pub(crate) fn dismiss(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        if !label.starts_with(QUICK_HOST_LABEL_PREFIX) {
            return Err("只能关闭当前快捷窗口".to_string());
        }
        let Some(window) = app.get_webview_window(label) else {
            self.remove_label(label);
            return Ok(());
        };
        // Each open creates a fresh instance. A hidden closed instance can never be
        // reused, so retaining it only wastes WebView memory and runs old scripts.
        // This command is the frontend acknowledgement after flush + destroy.
        // destroy() bypasses CloseRequested, avoiding recursive save requests.
        window.destroy().map_err(|error| error.to_string())
    }

    fn request_close(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        let token = {
            let mut pending = self
                .pending_close
                .write()
                .map_err(|_| "工具关闭状态不可用")?;
            if pending.contains_key(label) {
                return Ok(());
            }
            let token = self.next_close_token.fetch_add(1, Ordering::Relaxed) + 1;
            pending.insert(label.to_string(), token);
            token
        };
        let _ = app.emit_to(
            label,
            "quick-host-close-request",
            serde_json::json!({ "token": token }),
        );
        let app = app.clone();
        let label = label.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let manager = app.state::<QuickHostManager>();
            let timed_out = manager
                .pending_close
                .write()
                .map(|mut pending| {
                    if pending.get(&label) == Some(&token) {
                        pending.remove(&label);
                        true
                    } else {
                        false
                    }
                })
                .unwrap_or(false);
            if timed_out {
                if let Some(window) = app.get_webview_window(&label) {
                    if let Ok(mut retained) = manager.retained_labels.write() {
                        retained.insert(label.clone());
                    }
                    let _ = app.emit_to(
                        &label,
                        "app-power-state",
                        serde_json::json!({ "suspended": true, "closing": false }),
                    );
                    crate::set_webview_memory_target(&window, true);
                    let _ = window.hide();
                }
            }
        });
        Ok(())
    }

    pub(crate) fn restore_retained(&self, app: &AppHandle) {
        let labels = self
            .retained_labels
            .write()
            .map(|mut labels| std::mem::take(&mut *labels))
            .unwrap_or_default();
        for label in labels {
            if let Some(window) = app.get_webview_window(&label) {
                crate::set_webview_memory_target(&window, false);
                let _ = window.unminimize();
                let _ = window.show();
                let _ = app.emit_to(
                    &label,
                    "app-power-state",
                    serde_json::json!({ "suspended": false, "closing": false }),
                );
            }
        }
    }

    pub(crate) fn release_hidden(&self, app: &AppHandle) -> bool {
        let mut released = false;
        let Ok(active_labels) = self.active_labels.read().map(|labels| labels.clone()) else {
            return false;
        };
        for (label, window) in app.webview_windows() {
            if label.starts_with(QUICK_HOST_LABEL_PREFIX)
                && !active_labels.contains(&label)
                && window.is_visible().is_ok_and(|visible| !visible)
            {
                released |= window.close().is_ok();
            }
        }
        released
    }

    fn remove_label(&self, label: &str) {
        if let Ok(mut labels) = self.active_labels.write() {
            labels.remove(label);
        }
        if let Ok(mut activity) = self.palette_activity.write() {
            activity.remove(label);
        }
        if let Ok(mut pending) = self.pending_close.write() {
            pending.remove(label);
        }
        if let Ok(mut retained) = self.retained_labels.write() {
            retained.remove(label);
        }
    }

    fn touch(&self, label: &str) -> Result<(), String> {
        if !label.starts_with(QUICK_HOST_LABEL_PREFIX) {
            return Err("只能更新当前快捷窗口活动时间".to_string());
        }
        if let Some(last_activity) = self
            .palette_activity
            .write()
            .map_err(|_| "快捷面板活动状态不可用".to_string())?
            .get_mut(label)
        {
            *last_activity = Instant::now();
        }
        Ok(())
    }
}

fn spawn_palette_idle_guard(app: AppHandle, label: String) {
    tauri::async_runtime::spawn(async move {
        let timeout = Duration::from_secs(PALETTE_IDLE_TIMEOUT_SECONDS);
        loop {
            let remaining = {
                let manager = app.state::<QuickHostManager>();
                let Ok(activity) = manager.palette_activity.read() else {
                    return;
                };
                let Some(last_activity) = activity.get(&label) else {
                    return;
                };
                timeout.saturating_sub(last_activity.elapsed())
            };
            if remaining.is_zero() {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.close();
                }
                return;
            }
            tokio::time::sleep(remaining).await;
        }
    });
}

pub(crate) fn is_supported_tool_id(value: &str) -> bool {
    matches!(
        value,
        "timestamp-converter"
            | "json-formatter"
            | "base64-codec"
            | "hash-tool"
            | "qr-generator"
            | "color-picker"
            | "html-preview"
            | "url-encoder"
            | "crontab-explainer"
            | "unit-converter"
            | "alarm-clock"
            | "file-batch"
            | "transfer-station"
            | "resource-center"
            | "system-assistant"
            | "startup-manager"
            | "context-menu"
            | "password-vault"
            | "whiteboard"
            | "text-snippets"
            | "screenshot-annotator"
            | "region-mirror"
            | "sticky-notes"
            | "timetable"
    )
}

#[tauri::command]
pub(crate) async fn open_quick_host(
    app: AppHandle,
    manager: tauri::State<'_, QuickHostManager>,
    modules: tauri::State<'_, ToolModuleManager>,
    target: QuickHostTarget,
) -> Result<(), String> {
    if let Some(tool_id) = target.tool_id.as_deref() {
        if !modules.is_enabled(tool_id) {
            return Err("该工具模块已停用".to_string());
        }
    }
    manager.open(&app, target).map(|_| ())
}

#[tauri::command]
pub(crate) async fn dismiss_quick_host(
    window: WebviewWindow,
    manager: tauri::State<'_, QuickHostManager>,
) -> Result<(), String> {
    let label = window.label().to_string();
    manager.dismiss(window.app_handle(), &label)
}

#[tauri::command]
pub(crate) fn touch_quick_host_activity(
    window: WebviewWindow,
    manager: tauri::State<'_, QuickHostManager>,
) -> Result<(), String> {
    manager.touch(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_targets_only_accept_known_internal_tools() {
        assert!(QuickHostTarget::tool("timestamp-converter".into()).is_ok());
        assert!(QuickHostTarget::tool("whiteboard".into()).is_ok());
        assert!(QuickHostTarget::tool("password-vault".into()).is_ok());
        assert!(QuickHostTarget::tool("../settings".into()).is_err());
        assert!(QuickHostTarget::tool("UPPERCASE".into()).is_err());
        assert!(QuickHostTarget::tool("unknown-tool".into()).is_err());
    }

    #[test]
    fn palette_targets_never_carry_tool_data() {
        let palette = QuickHostTarget::palette();
        assert!(palette.validate().is_ok());
        assert_eq!(
            palette.initial_url("quick-host-1"),
            "quick.html?kind=palette&instanceId=quick-host-1"
        );
    }

    #[test]
    fn every_shortcut_window_gets_an_independent_label() {
        let manager = QuickHostManager::default();
        let first = manager.next_label.fetch_add(1, Ordering::Relaxed) + 1;
        let second = manager.next_label.fetch_add(1, Ordering::Relaxed) + 1;
        assert_ne!(
            format!("{QUICK_HOST_LABEL_PREFIX}{first}"),
            format!("{QUICK_HOST_LABEL_PREFIX}{second}")
        );
    }
}
