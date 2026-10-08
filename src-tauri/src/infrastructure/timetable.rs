//! A single on-demand timetable WebView. No startup window, polling thread or timer.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "timetable-widget";

fn authorized(label: &str, allow_widget: bool) -> bool {
    label == "main" || label.starts_with("quick-host-") || (allow_widget && label == LABEL)
}

fn authorize(window: &WebviewWindow, allow_widget: bool) -> Result<(), String> {
    if authorized(window.label(), allow_widget) {
        Ok(())
    } else {
        Err("当前窗口不能控制课表小部件".into())
    }
}

#[tauri::command]
pub(crate) async fn open_timetable_widget(
    window: WebviewWindow,
    pinned: bool,
) -> Result<(), String> {
    authorize(&window, false)?;
    let app = window.app_handle();
    let _work = super::launch::keep_native_work(app);
    if !app
        .state::<super::tool_modules::ToolModuleManager>()
        .is_enabled("timetable")
    {
        return Err("课表工具已停用".into());
    }
    if let Some(existing) = app.get_webview_window(LABEL) {
        existing
            .set_always_on_top(pinned)
            .map_err(|e| e.to_string())?;
        existing.unminimize().map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let widget =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("timetable-widget.html".into()))
            .title("DtKit · 我的课表")
            .inner_size(560.0, 640.0)
            .min_inner_size(320.0, 280.0)
            .decorations(false)
            .resizable(true)
            .always_on_top(pinned)
            .skip_taskbar(false)
            .shadow(true)
            .center()
            .build()
            .map_err(|e| format!("打开课表小部件失败: {e}"))?;
    let handle = app.clone();
    let minimized = Arc::new(AtomicBool::new(false));
    widget.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) => {
            if let Some(widget) = handle.get_webview_window(LABEL) {
                let suspended = widget.is_minimized().unwrap_or(false);
                if minimized.swap(suspended, Ordering::Relaxed) != suspended {
                    crate::set_webview_memory_target(&widget, suspended);
                    let _ = widget.emit(
                        "timetable-widget-power",
                        serde_json::json!({ "suspended": suspended }),
                    );
                }
            }
        }
        tauri::WindowEvent::Destroyed => {
            tauri::async_runtime::spawn(super::launch::finish_tool_only_if_idle(handle.clone()));
        }
        _ => {}
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn close_timetable_widget(window: WebviewWindow) -> Result<(), String> {
    authorize(&window, true)?;
    if let Some(widget) = window.app_handle().get_webview_window(LABEL) {
        widget.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn pin_timetable_widget(window: WebviewWindow, pinned: bool) -> Result<(), String> {
    authorize(&window, true)?;
    if let Some(widget) = window.app_handle().get_webview_window(LABEL) {
        widget
            .set_always_on_top(pinned)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn widget_controls_are_scoped_to_manager_and_widget_windows() {
        assert!(authorized("main", false));
        assert!(authorized("quick-host-3", false));
        assert!(!authorized(LABEL, false));
        assert!(authorized(LABEL, true));
        assert!(!authorized("sticky-note-123", true));
        assert!(!authorized("screen-region", true));
    }
}
