use super::screenshot::{
    capture_virtual_screen, wait_for_hidden_window, ScreenCapture, ScreenRequestContext,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const OVERLAY_LABEL_PREFIX: &str = "color-picker-overlay-";
type RequestKey = (String, String, String);

fn request_key(owner: &str, request: &ScreenRequestContext) -> Option<RequestKey> {
    Some((
        owner.to_string(),
        request.instance_id.clone()?,
        request.request_id.clone()?,
    ))
}

fn remember_cancellation(requests: &mut HashMap<RequestKey, Instant>, key: RequestKey) {
    requests.retain(|_, time| time.elapsed() < Duration::from_secs(120));
    if requests.len() >= 256 {
        if let Some(oldest) = requests
            .iter()
            .min_by_key(|(_, time)| **time)
            .map(|(key, _)| key.clone())
        {
            requests.remove(&oldest);
        }
    }
    requests.insert(key, Instant::now());
}

#[derive(Clone)]
struct ColorPickSession {
    owner_label: String,
    request: ScreenRequestContext,
    capture: Option<ScreenCapture>,
}

impl ColorPickSession {
    fn matches(&self, owner: &str, request: &ScreenRequestContext) -> bool {
        self.owner_label == owner
            && self.request.instance_id == request.instance_id
            && self.request.request_id == request.request_id
    }
}

#[derive(Default)]
pub(crate) struct ScreenColorPickerManager {
    next_label: AtomicU64,
    // Pending captures are registered before hiding their owner, so cancellation
    // also works while the blocking screen capture has not returned yet.
    sessions: Mutex<HashMap<String, ColorPickSession>>,
    // A synchronous cancel IPC may reach the UI thread before its preceding
    // async start has been polled. Remember its exact identity briefly.
    cancelled_requests: Mutex<HashMap<RequestKey, Instant>>,
}

impl ScreenColorPickerManager {
    pub(crate) fn cancel_window(&self, app: &AppHandle, owner_label: &str) {
        let labels = self
            .sessions
            .lock()
            .map(|mut sessions| {
                let labels: Vec<_> = sessions
                    .iter()
                    .filter(|(_, session)| session.owner_label == owner_label)
                    .map(|(label, _)| label.clone())
                    .collect();
                for label in &labels {
                    sessions.remove(label);
                }
                labels
            })
            .unwrap_or_default();
        // An owner closing (including closing to the tray) must not be revived.
        for label in labels {
            if let Some(overlay) = app.get_webview_window(&label) {
                let _ = overlay.close();
            }
        }
    }

    fn remove(&self, label: &str) -> Option<ColorPickSession> {
        self.sessions.lock().ok()?.remove(label)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColorPickResult {
    #[serde(flatten)]
    request: ScreenRequestContext,
    color: Option<String>,
    cancelled: bool,
}

fn restore_owner(app: &AppHandle, session: ColorPickSession, color: Option<String>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let manager = handle.state::<ScreenColorPickerManager>();
        let Ok(sessions) = manager.sessions.lock() else {
            return;
        };
        if let Some(owner) = handle.get_webview_window(&session.owner_label) {
            let result = ColorPickResult {
                request: session.request.clone(),
                cancelled: color.is_none(),
                color,
            };
            let _ = owner.emit("screen-color-picked", result);
            // A newer request may already have hidden the same owner. An older
            // completion must not reveal it in the newer request's screenshot.
            if !sessions
                .values()
                .any(|pending| pending.owner_label == session.owner_label)
            {
                let _ = owner.show();
                let _ = owner.unminimize();
                let _ = owner.set_focus();
            }
        }
    });
}

// Check session liveness and change visibility in the same UI task. Holding a
// registry mutex on a worker while waiting for a window API can deadlock with
// the UI thread's CloseRequested cleanup.
async fn set_session_visibility(
    window: WebviewWindow,
    label: String,
    visible: bool,
) -> Result<bool, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let manager = target.state::<ScreenColorPickerManager>();
            let result = manager
                .sessions
                .lock()
                .map_err(|_| "屏幕取色状态不可用".to_string())
                .and_then(|sessions| {
                    if !sessions.contains_key(&label) {
                        return Ok(false);
                    }
                    if visible {
                        target.show()
                    } else {
                        target.hide()
                    }
                    .map(|_| true)
                    .map_err(|error| format!("切换取色窗口状态失败: {error}"))
                });
            let _ = sender.send(result);
        })
        .map_err(|error| format!("调度取色窗口失败: {error}"))?;
    receiver
        .await
        .map_err(|error| format!("取色窗口任务异常结束: {error}"))?
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
    instance_id: Option<String>,
    request_id: Option<String>,
) -> Result<(), String> {
    let request = ScreenRequestContext::new(instance_id, request_id)?;
    let _work = super::launch::keep_native_work(window.app_handle());
    let owner_label = window.label().to_string();
    let sequence = manager.next_label.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("{OVERLAY_LABEL_PREFIX}{sequence}");
    {
        let mut cancelled = manager
            .cancelled_requests
            .lock()
            .map_err(|_| "屏幕取色状态不可用".to_string())?;
        cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(120));
        if request_key(&owner_label, &request).is_some_and(|key| cancelled.remove(&key).is_some()) {
            return Ok(());
        }
        let mut sessions = manager
            .sessions
            .lock()
            .map_err(|_| "屏幕取色状态不可用".to_string())?;
        if !sessions.is_empty() {
            return Err("已有屏幕取色任务，请先完成或取消".to_string());
        }
        sessions.insert(
            label.clone(),
            ColorPickSession {
                owner_label,
                request,
                capture: None,
            },
        );
    }
    match set_session_visibility(window.clone(), label.clone(), false).await {
        Ok(true) => {}
        Ok(false) => return Ok(()),
        Err(error) => {
            if let Some(session) = manager.remove(&label) {
                restore_owner(window.app_handle(), session, None);
            }
            return Err(error);
        }
    }
    wait_for_hidden_window().await;
    // Cancellation before the capture even starts avoids unnecessary work.
    if !manager
        .sessions
        .lock()
        .map_err(|_| "屏幕取色状态不可用".to_string())?
        .contains_key(&label)
    {
        return Ok(());
    }
    let capture = match tauri::async_runtime::spawn_blocking(capture_virtual_screen).await {
        Ok(Ok(capture)) => capture,
        result => {
            if let Some(session) = manager.remove(&label) {
                restore_owner(window.app_handle(), session, None);
            }
            return Err(match result {
                Ok(Err(error)) => error,
                Err(error) => format!("屏幕取色任务异常结束: {error}"),
                _ => unreachable!(),
            });
        }
    };
    let position = PhysicalPosition::new(capture.x, capture.y);
    let size = PhysicalSize::new(capture.width, capture.height);
    {
        let mut sessions = manager
            .sessions
            .lock()
            .map_err(|_| "屏幕取色状态不可用".to_string())?;
        let Some(session) = sessions.get_mut(&label) else {
            return Ok(());
        };
        session.capture = Some(capture);
    }

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
            if let Some(session) = manager.remove(&label) {
                restore_owner(window.app_handle(), session, None);
            }
            return Err(format!("创建取色覆盖层失败: {error}"));
        }
    };
    let app = window.app_handle().clone();
    let closing_label = label.clone();
    overlay.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            if let Some(session) = app
                .state::<ScreenColorPickerManager>()
                .remove(&closing_label)
            {
                restore_owner(&app, session, None);
            }
        }
    });
    let positioned = overlay
        .set_position(position)
        .map_err(|error| format!("定位取色覆盖层失败: {error}"))
        .and_then(|_| {
            overlay
                .set_size(size)
                .map_err(|error| format!("调整取色覆盖层失败: {error}"))
        });
    if let Err(error) = positioned {
        let session = manager.remove(&label);
        let _ = overlay.close();
        if let Some(session) = session {
            restore_owner(window.app_handle(), session, None);
        }
        return Err(error);
    }
    // A cancelled in-flight builder may finish, but its hidden window is
    // closed without ever being presented.
    match set_session_visibility(overlay.clone(), label.clone(), true).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = overlay.close();
            return Ok(());
        }
        Err(error) => {
            let session = manager.remove(&label);
            let _ = overlay.close();
            if let Some(session) = session {
                restore_owner(window.app_handle(), session, None);
            }
            return Err(error);
        }
    }
    let _ = overlay.set_focus();
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_screen_color_pick(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenColorPickerManager>,
    instance_id: String,
    request_id: String,
) -> Result<(), String> {
    let request = ScreenRequestContext::new(Some(instance_id), Some(request_id))?;
    let session = {
        let mut cancelled = manager
            .cancelled_requests
            .lock()
            .map_err(|_| "屏幕取色状态不可用".to_string())?;
        if let Some(key) = request_key(window.label(), &request) {
            remember_cancellation(&mut cancelled, key);
        }
        let mut sessions = manager
            .sessions
            .lock()
            .map_err(|_| "屏幕取色状态不可用".to_string())?;
        let label = sessions
            .iter()
            .find(|(_, session)| session.matches(window.label(), &request))
            .map(|(label, _)| label.clone());
        label.and_then(|label| sessions.remove(&label).map(|session| (label, session)))
    };
    if let Some((label, session)) = session {
        if let Some(overlay) = window.app_handle().get_webview_window(&label) {
            let _ = overlay.close();
        }
        restore_owner(window.app_handle(), session, None);
    }
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
        .remove(window.label());
    if let Some(session) = session {
        let app = window.app_handle().clone();
        let _ = window.close();
        restore_owner(&app, session, color);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_color_result_targets_one_specific_page_request() {
        let request =
            ScreenRequestContext::new(Some("page-b".into()), Some("color-request-7".into()))
                .unwrap();
        let result = ColorPickResult {
            request,
            color: Some("#12ABEF".into()),
            cancelled: false,
        };
        let payload = serde_json::to_value(result).unwrap();
        assert_eq!(payload["instanceId"], "page-b");
        assert_eq!(payload["requestId"], "color-request-7");
        assert_eq!(payload["color"], "#12ABEF");
    }

    #[test]
    fn picked_colors_are_strict_six_digit_hex_values() {
        assert_eq!(
            normalize_hex_color(Some("#12abEF".into())).unwrap(),
            Some("#12ABEF".into())
        );
        for invalid in [
            "rgb(1,2,3)",
            "#123",
            "#ABCDEF00",
            "#12GG34",
            "#１２３４５６",
        ] {
            assert!(normalize_hex_color(Some(invalid.into())).is_err());
        }
        assert_eq!(normalize_hex_color(None).unwrap(), None);
    }

    #[test]
    fn pending_capture_cancellation_requires_the_owner_page_and_request() {
        let request =
            ScreenRequestContext::new(Some("page-a".into()), Some("pick-1".into())).unwrap();
        let session = ColorPickSession {
            owner_label: "main".into(),
            request: request.clone(),
            capture: None,
        };
        assert!(session.matches("main", &request));
        assert!(!session.matches("quick-host-1", &request));
        assert!(!session.matches(
            "main",
            &ScreenRequestContext::new(Some("page-b".into()), Some("pick-1".into())).unwrap()
        ));
        assert!(!session.matches(
            "main",
            &ScreenRequestContext::new(Some("page-a".into()), Some("pick-2".into())).unwrap()
        ));
        assert!(!session.matches("main", &ScreenRequestContext::new(None, None).unwrap()));
    }

    #[test]
    fn removing_pending_session_is_idempotent_and_releases_capture() {
        let manager = ScreenColorPickerManager::default();
        manager.sessions.lock().unwrap().insert(
            "overlay-1".into(),
            ColorPickSession {
                owner_label: "main".into(),
                request: ScreenRequestContext::new(Some("page-a".into()), Some("pick-1".into()))
                    .unwrap(),
                capture: None,
            },
        );
        assert!(manager.remove("overlay-1").is_some());
        assert!(manager.remove("overlay-1").is_none());
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_before_async_start_is_bounded_and_keeps_exact_request_identity() {
        let mut requests = HashMap::new();
        let request =
            ScreenRequestContext::new(Some("page-a".into()), Some("pick-1".into())).unwrap();
        let key = request_key("main", &request).unwrap();
        remember_cancellation(&mut requests, key.clone());
        assert!(!requests.contains_key(&request_key("quick-host-1", &request).unwrap()));
        assert!(requests.remove(&key).is_some());
        for index in 0..300 {
            remember_cancellation(
                &mut requests,
                ("main".into(), "page-a".into(), index.to_string()),
            );
        }
        assert_eq!(requests.len(), 256);
    }
}
