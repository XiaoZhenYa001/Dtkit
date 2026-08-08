use super::screenshot::{capture_virtual_screen, wait_for_hidden_window, ScreenCapture};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const OVERLAY_LABEL_PREFIX: &str = "color-picker-overlay-";

#[derive(Clone)]
struct ColorPickSession {
    owner_label: String,
    capture: Option<ScreenCapture>,
}

#[derive(Default)]
pub(crate) struct ScreenColorPickerManager {
    next_label: AtomicU64,
    sessions: Mutex<HashMap<String, ColorPickSession>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColorPickResult {
    color: Option<String>,
    cancelled: bool,
}

fn restore_owner(app: &AppHandle, session: ColorPickSession, color: Option<String>) {
    if let Some(owner) = app.get_webview_window(&session.owner_label) {
        let result = ColorPickResult {
            cancelled: color.is_none(),
            color,
        };
        let _ = owner.emit("screen-color-picked", result);
        let _ = owner.show();
        let _ = owner.unminimize();
        let _ = owner.set_focus();
    }
}

fn normalize_hex_color(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_ascii_uppercase();
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(Some(value))
    } else {
        Err("取色结果格式无效".to_string())
    }
}

#[tauri::command]
pub(crate) async fn start_screen_color_pick(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenColorPickerManager>,
) -> Result<(), String> {
    let owner_label = window.label().to_string();
    window
        .hide()
        .map_err(|error| format!("隐藏取色来源窗口失败: {error}"))?;
    wait_for_hidden_window().await;
    let capture = match tauri::async_runtime::spawn_blocking(capture_virtual_screen).await {
        Ok(Ok(capture)) => capture,
        Ok(Err(error)) => {
            let _ = window.show();
            let _ = window.set_focus();
            return Err(error);
        }
        Err(error) => {
            let _ = window.show();
            let _ = window.set_focus();
            return Err(format!("屏幕取色任务异常结束: {error}"));
        }
    };

    let sequence = manager.next_label.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("{OVERLAY_LABEL_PREFIX}{sequence}");
    let overlay = match WebviewWindowBuilder::new(
        window.app_handle(),
        &label,
        WebviewUrl::App("color-pick.html".into()),
    )
    .title("DtKit 屏幕取色")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(true)
    .visible(false)
    .build()
    {
        Ok(overlay) => overlay,
        Err(error) => {
            let _ = window.show();
            let _ = window.set_focus();
            return Err(format!("创建取色覆盖层失败: {error}"));
        }
    };
    if let Err(error) = overlay.set_position(PhysicalPosition::new(capture.x, capture.y)) {
        let _ = overlay.close();
        let _ = window.show();
        return Err(format!("定位取色覆盖层失败: {error}"));
    }
    if let Err(error) = overlay.set_size(PhysicalSize::new(capture.width, capture.height)) {
        let _ = overlay.close();
        let _ = window.show();
        return Err(format!("调整取色覆盖层失败: {error}"));
    }
    manager
        .sessions
        .lock()
        .map_err(|_| "屏幕取色状态不可用".to_string())?
        .insert(
            label.clone(),
            ColorPickSession {
                owner_label,
                capture: Some(capture),
            },
        );
    let app = window.app_handle().clone();
    overlay.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            let session = app
                .state::<ScreenColorPickerManager>()
                .sessions
                .lock()
                .ok()
                .and_then(|mut sessions| sessions.remove(&label));
            if let Some(session) = session {
                restore_owner(&app, session, None);
            }
        }
    });
    overlay.show().map_err(|error| {
        if let Ok(mut sessions) = manager.sessions.lock() {
            sessions.remove(overlay.label());
        }
        let _ = overlay.close();
        let _ = window.show();
        format!("显示取色覆盖层失败: {error}")
    })?;
    let _ = overlay.set_focus();
    Ok(())
}

#[tauri::command]
pub(crate) fn get_screen_color_pick_capture(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenColorPickerManager>,
) -> Result<ScreenCapture, String> {
    manager
        .sessions
        .lock()
        .map_err(|_| "屏幕取色状态不可用".to_string())?
        .get_mut(window.label())
        .and_then(|session| session.capture.take())
        .ok_or_else(|| "屏幕取色画面不存在或已释放".to_string())
}

#[tauri::command]
pub(crate) fn finish_screen_color_pick(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenColorPickerManager>,
    color: Option<String>,
) -> Result<(), String> {
    let color = normalize_hex_color(color)?;
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "屏幕取色状态不可用".to_string())?
        .remove(window.label())
        .ok_or_else(|| "屏幕取色会话不存在".to_string())?;
    let app = window.app_handle().clone();
    let _ = window.close();
    restore_owner(&app, session, color);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picked_colors_are_strict_six_digit_hex_values() {
        assert_eq!(
            normalize_hex_color(Some("#12abEF".into())).unwrap(),
            Some("#12ABEF".into())
        );
        assert!(normalize_hex_color(Some("rgb(1,2,3)".into())).is_err());
        assert_eq!(normalize_hex_color(None).unwrap(), None);
    }
}
