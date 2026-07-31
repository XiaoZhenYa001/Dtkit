use super::resources::ResourceGovernor;
use super::tool_modules::ToolModuleManager;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const QUICK_HOST_LABEL_PREFIX: &str = "quick-host-";

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

    fn initial_url(&self) -> String {
        match self.kind {
            QuickHostKind::Palette => "quick.html?kind=palette".to_string(),
            QuickHostKind::Tool => format!(
                "quick.html?kind=tool&toolId={}",
                self.tool_id.as_deref().unwrap_or_default()
            ),
        }
    }
}

#[derive(Default)]
pub(crate) struct QuickHostManager {
    next_label: AtomicU64,
    active_labels: RwLock<HashSet<String>>,
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
        let sequence = self.next_label.fetch_add(1, Ordering::Relaxed) + 1;
        let label = format!("{QUICK_HOST_LABEL_PREFIX}{sequence}");
        let window =
            WebviewWindowBuilder::new(app, &label, WebviewUrl::App(target.initial_url().into()))
                .title("DtKit 快捷窗口")
                .inner_size(760.0, 580.0)
                .min_inner_size(560.0, 400.0)
                .resizable(true)
                .decorations(false)
                .transparent(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(true)
                .center()
                .build()
                .map_err(|error| format!("创建快捷宿主失败: {error}"))?;
        self.active_labels
            .write()
            .map_err(|_| "快捷宿主状态不可用".to_string())?
            .insert(label);
        Ok(window)
    }

    pub(crate) fn dismiss(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        if !label.starts_with(QUICK_HOST_LABEL_PREFIX) {
            return Err("只能关闭当前快捷窗口".to_string());
        }
        self.remove_label(label);
        let Some(window) = app.get_webview_window(label) else {
            return Ok(());
        };
        let retention = app
            .state::<ResourceGovernor>()
            .quick_host_retention_seconds();
        if retention == 0 {
            return window.close().map_err(|error| error.to_string());
        }

        window.hide().map_err(|error| error.to_string())?;
        let app_handle = app.clone();
        let retained_label = label.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(retention)).await;
            if let Some(window) = app_handle.get_webview_window(&retained_label) {
                let _ = window.close();
            }
        });
        Ok(())
    }

    pub(crate) fn release_now(&self, app: &AppHandle) {
        if let Ok(mut labels) = self.active_labels.write() {
            labels.clear();
        }
        for (label, window) in app.webview_windows() {
            if label.starts_with(QUICK_HOST_LABEL_PREFIX) {
                let _ = window.close();
            }
        }
    }

    fn remove_label(&self, label: &str) {
        if let Ok(mut labels) = self.active_labels.write() {
            labels.remove(label);
        }
    }
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
            | "password-vault"
            | "whiteboard"
            | "text-snippets"
            | "screenshot-annotator"
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
        assert_eq!(palette.initial_url(), "quick.html?kind=palette");
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
