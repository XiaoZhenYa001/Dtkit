//! A transient file launcher. No Explorer attachment or desktop polling is needed.
use crate::infrastructure::{shortcuts::ShortcutRegistry, storage::StorageManager};
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const LABEL: &str = "desktop-space";
const MODE_FILE: &str = "desktop-organizer-mode.json";

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Presentation {
    #[default]
    Classic,
    Space,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct ModeConfig {
    version: u32,
    enabled: bool,
    presentation: Presentation,
    #[serde(default, rename = "shortcutInitialized")]
    shortcut_initialized: bool,
}

impl Default for ModeConfig {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            presentation: Presentation::Classic,
            shortcut_initialized: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrganizerMode {
    configured: bool,
    enabled: bool,
    presentation: Presentation,
    hotzone_running: bool,
    desktop_space_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    shortcut_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopViewport {
    width: u32,
    height: u32,
    scale_factor: f64,
    session: u64,
    reduced_motion: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    light_background: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    background_luminance: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize)]
struct ClosingSession {
    session: u64,
    #[serde(rename = "reducedMotion")]
    reduced_motion: bool,
}

#[derive(Default)]
struct Inner {
    configured: bool,
    mode: ModeConfig,
    ready: bool,
    visible: bool,
    closing: bool,
    session: u64,
    shortcut_warning: Option<String>,
}

impl Inner {
    fn begin_show(&mut self) -> u64 {
        self.session = self.session.wrapping_add(1);
        self.visible = true;
        self.closing = false;
        self.session
    }

    fn begin_close(&mut self) -> Option<u64> {
        if !self.visible || self.closing {
            return None;
        }
        self.closing = true;
        Some(self.session)
    }

    fn begin_hide(&mut self, expected: Option<u64>) -> bool {
        if expected.is_some_and(|session| session != self.session) {
            return false;
        }
        self.session = self.session.wrapping_add(1);
        self.visible = false;
        self.closing = false;
        true
    }

    fn close_expired(&self, session: u64) -> bool {
        self.visible && self.closing && self.session == session
    }
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    transition: tokio::sync::Mutex<()>,
    ready: tokio::sync::Notify,
    exiting: AtomicBool,
}

#[derive(Default, Clone)]
pub(crate) struct DesktopSpaceManager(Arc<Shared>);

impl DesktopSpaceManager {
    pub(crate) fn restore_config(&self, app: &AppHandle) -> Result<(), String> {
        let path = app.state::<StorageManager>().config_file(MODE_FILE)?;
        if !path.exists() {
            return Ok(());
        }
        let mode: ModeConfig =
            serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                .map_err(|error| format!("桌面整理配置无效: {error}"))?;
        if mode.version != 1 {
            return Err("桌面整理配置版本不受支持".into());
        }
        let mut inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        inner.mode = mode;
        inner.configured = true;
        Ok(())
    }

    pub(crate) fn classic_allowed(&self) -> bool {
        self.0
            .inner
            .lock()
            .map(|inner| {
                !inner.configured
                    || (inner.mode.enabled && inner.mode.presentation == Presentation::Classic)
            })
            .unwrap_or(false)
    }

    pub(crate) fn show_classic_if_allowed(&self, window: &WebviewWindow) -> Result<(), String> {
        let inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        if !inner.configured
            || (inner.mode.enabled && inner.mode.presentation == Presentation::Classic)
        {
            super::classic_motion::set_visible(window, true)?;
        }
        Ok(())
    }

    fn space_enabled(&self) -> bool {
        !self.0.exiting.load(Ordering::Acquire)
            && self
                .0
                .inner
                .lock()
                .map(|inner| inner.mode.enabled && inner.mode.presentation == Presentation::Space)
                .unwrap_or(false)
    }

    fn status(&self, app: &AppHandle) -> OrganizerMode {
        let inner = self
            .0
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        OrganizerMode {
            configured: inner.configured,
            enabled: inner.mode.enabled,
            presentation: inner.mode.presentation,
            hotzone_running: super::hotzone::is_hotzone_running(),
            desktop_space_visible: inner.visible && app.get_webview_window(LABEL).is_some(),
            shortcut_warning: if inner.mode.enabled
                && inner.mode.presentation == Presentation::Space
                && !app
                    .state::<ShortcutRegistry>()
                    .is_registered(&crate::infrastructure::shortcuts::ShortcutTarget::DesktopSpace)
            {
                app.state::<ShortcutRegistry>()
                    .registration_error(
                        &crate::infrastructure::shortcuts::ShortcutTarget::DesktopSpace,
                    )
                    .or_else(|| inner.shortcut_warning.clone())
            } else {
                None
            },
        }
    }

    fn emit_status(&self, app: &AppHandle) {
        let _ = app.emit("desktop-organizer-mode-changed", self.status(app));
    }

    pub(crate) fn resume(&self, app: &AppHandle) {
        let manager = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = manager.0.transition.lock().await;
            let mode = manager
                .0
                .inner
                .lock()
                .map(|inner| inner.mode)
                .unwrap_or_default();
            if let Err(error) = manager.apply_mode(&app, mode).await {
                eprintln!("[DesktopSpace] 恢复桌面整理失败: {error}");
                let _ = app.emit("desktop-organizer-error", error);
            }
        });
    }

    async fn apply_mode(&self, app: &AppHandle, mode: ModeConfig) -> Result<(), String> {
        super::hotzone::set_user_interacting(false);
        super::hotzone::stop_hotzone_monitor();
        if let Some(window) = app.get_webview_window("desktop-organizer") {
            super::classic_motion::cancel(&window);
            let _ = window.hide();
        }
        if !mode.enabled || mode.presentation == Presentation::Classic {
            self.0
                .inner
                .lock()
                .map_err(|_| "桌面整理状态不可用")?
                .shortcut_warning = None;
            self.release_space(app).await?;
            if mode.enabled {
                crate::start_hotzone_monitor(app.clone())?;
            }
            return Ok(());
        }
        let (added, shortcut_warning) = if mode.shortcut_initialized {
            (
                false,
                self.0
                    .inner
                    .lock()
                    .map_err(|_| "桌面整理状态不可用")?
                    .shortcut_warning
                    .clone(),
            )
        } else {
            match app.state::<ShortcutRegistry>().ensure_desktop_space_binding(app) {
                Ok(added) => (added, None),
                Err(error) => (false, Some(format!("桌面空间已启用，但默认快捷键未能设置：{error}。可点击“打开空间”，或在快捷键设置中更换组合键。"))),
            }
        };
        if let Err(error) = self.ensure_space(app) {
            if added {
                let _ = app
                    .state::<ShortcutRegistry>()
                    .remove_desktop_space_binding(app);
            }
            return Err(error);
        }
        if !mode.shortcut_initialized {
            let initialized = ModeConfig {
                shortcut_initialized: true,
                ..mode
            };
            let persisted = (|| {
                let path = app.state::<StorageManager>().config_file(MODE_FILE)?;
                let bytes =
                    serde_json::to_vec_pretty(&initialized).map_err(|error| error.to_string())?;
                fs::write(path, bytes)
                    .map_err(|error| format!("保存桌面空间快捷键初始化状态失败: {error}"))
            })();
            if let Err(error) = persisted {
                if added {
                    let _ = app
                        .state::<ShortcutRegistry>()
                        .remove_desktop_space_binding(app);
                }
                return Err(error);
            }
            self.0
                .inner
                .lock()
                .map_err(|_| "桌面整理状态不可用")?
                .mode
                .shortcut_initialized = true;
        }
        self.0
            .inner
            .lock()
            .map_err(|_| "桌面整理状态不可用")?
            .shortcut_warning = shortcut_warning;
        // Startup and mode selection only prepare the hidden WebView.
        Ok(())
    }

    fn ensure_space(&self, app: &AppHandle) -> Result<WebviewWindow, String> {
        if let Some(window) = app.get_webview_window(LABEL) {
            return Ok(window);
        }
        if !self.space_enabled() {
            return Err("桌面空间尚未启用".into());
        }
        {
            let mut inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
            inner.ready = false;
            inner.visible = false;
            inner.closing = false;
        }
        let builder = WebviewWindowBuilder::new(
            app,
            LABEL,
            WebviewUrl::App("desktop-organizer/space.html".into()),
        )
        .title("桌面空间")
        .disable_drag_drop_handler()
        .transparent(true)
        .decorations(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .shadow(false)
        .inner_size(1100.0, 660.0);
        let window = builder
            .build()
            .map_err(|error| format!("创建桌面空间失败: {error}"))?;
        #[cfg(windows)]
        super::space_surface::configure(&window)?;
        let manager = self.clone();
        let app_handle = app.clone();
        #[cfg(windows)]
        let surface_window = window.clone();
        window.on_window_event(move |event| match event {
            #[cfg(windows)]
            WindowEvent::Focused(true) => {
                if let Err(error) = super::space_surface::configure(&surface_window) {
                    eprintln!("桌面空间外观更新失败: {error}");
                }
            }
            #[cfg(windows)]
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                if let Err(error) = super::space_surface::configure(&surface_window) {
                    eprintln!("桌面空间圆角更新失败: {error}");
                }
            }
            WindowEvent::Focused(false) => {
                if super::space_settings::read_settings(&app_handle)
                    .map(|settings| settings.close_on_blur)
                    .unwrap_or(true)
                {
                    let _ = manager.request_close(&app_handle);
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = manager.request_close(&app_handle);
            }
            WindowEvent::Destroyed => {
                if let Ok(mut inner) = manager.0.inner.lock() {
                    inner.ready = false;
                    inner.begin_hide(None);
                }
                manager.0.ready.notify_waiters();
            }
            _ => {}
        });
        Ok(window)
    }

    async fn present(&self, app: &AppHandle) -> Result<(), String> {
        if !self.space_enabled() {
            return Err("桌面空间尚未启用".into());
        }
        let window = self.ensure_space(app)?;
        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                let notified = self.0.ready.notified();
                if self
                    .0
                    .inner
                    .lock()
                    .map(|inner| inner.ready)
                    .unwrap_or(false)
                {
                    return Ok(());
                }
                if !self.space_enabled() {
                    return Err("桌面空间已关闭".to_string());
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| "桌面空间加载超时，请稍后重试".to_string())??;
        let monitor = match app.cursor_position() {
            Ok(cursor) => app.monitor_from_point(cursor.x, cursor.y).ok().flatten(),
            Err(_) => None,
        }
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or("无法获取显示器工作区域")?;
        let area = monitor.work_area();
        let settings = super::space_settings::read_settings(app).unwrap_or_default();
        let reduced_motion =
            settings.reduced_motion || super::space_surface::system_reduced_motion();
        let (position, size) = launcher_bounds_with_percentages(
            area.position,
            area.size,
            monitor.scale_factor(),
            settings.window_width as f64,
            settings.window_height as f64,
        );
        let manager = self.clone();
        let app_handle = app.clone();
        on_ui(app, move || {
            if !manager.space_enabled() {
                return Err("桌面空间已关闭".to_string());
            }
            window.set_size(size).map_err(|error| error.to_string())?;
            window
                .set_position(position)
                .map_err(|error| error.to_string())?;
            #[cfg(windows)]
            super::space_surface::configure(&window)?;
            let session = {
                let mut inner = manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
                inner.begin_show()
            };
            let fresh = !window.is_visible().unwrap_or(false);
            #[cfg(windows)]
            if let Err(error) = super::space_surface::prepare_open(&window, fresh, reduced_motion) {
                eprintln!("桌面空间入场准备失败: {error}");
            }
            #[cfg(windows)]
            let contrast = if window.is_visible().unwrap_or(false) {
                None
            } else {
                super::space_surface::background_contrast(position, size)
            };
            #[cfg(not(windows))]
            let contrast: Option<(bool, Vec<f64>)> = None;
            let (light_background, background_luminance) = contrast
                .map(|(light, grid)| (Some(light), Some(grid)))
                .unwrap_or_default();
            if let Err(error) = window.show().and_then(|_| window.set_focus()) {
                manager.hide(&app_handle)?;
                return Err(format!("显示桌面空间失败: {error}"));
            }
            #[cfg(windows)]
            super::space_surface::configure(&window)?;
            let size = window.inner_size().map_err(|error| error.to_string())?;
            let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
            window
                .emit(
                    "desktop-space-opened",
                    DesktopViewport {
                        width: size.width,
                        height: size.height,
                        scale_factor,
                        session,
                        reduced_motion,
                        light_background,
                        background_luminance,
                    },
                )
                .map_err(|error| error.to_string())?;
            #[cfg(windows)]
            if let Err(error) =
                super::space_surface::animate_visibility(&window, true, reduced_motion)
            {
                eprintln!("桌面空间入场动效失败: {error}");
            }
            manager.emit_status(&app_handle);
            Ok(())
        })
        .await
    }

    pub(crate) async fn toggle(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.0.transition.lock().await;
        if !self.space_enabled() {
            return Ok(());
        }
        let should_close = self
            .0
            .inner
            .lock()
            .map(|inner| inner.visible && !inner.closing)
            .unwrap_or(false);
        if should_close {
            self.request_close(app)
        } else {
            self.present(app).await
        }
    }

    fn request_close(&self, app: &AppHandle) -> Result<(), String> {
        self.request_close_matching(app, None)
    }

    fn request_close_matching(&self, app: &AppHandle, expected: Option<u64>) -> Result<(), String> {
        let session = {
            let mut inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
            if expected.is_some_and(|session| session != inner.session) {
                return Ok(());
            }
            inner.begin_close()
        };
        let Some(session) = session else {
            return Ok(());
        };
        let reduced_motion = super::space_settings::read_settings(app)
            .map(|settings| settings.reduced_motion)
            .unwrap_or(false)
            || super::space_surface::system_reduced_motion();
        let manager = self.clone();
        let app_handle = app.clone();
        // Both the retained native backdrop and the WebView fade before the
        // HWND is hidden. The native deadline also works with suspended JS.
        let queued = app.run_on_main_thread(move || {
            if !manager
                .0
                .inner
                .lock()
                .map(|inner| inner.close_expired(session))
                .unwrap_or(false)
            {
                return;
            }
            if let Some(window) = app_handle.get_webview_window(LABEL) {
                #[cfg(windows)]
                if let Err(error) =
                    super::space_surface::animate_visibility(&window, false, reduced_motion)
                {
                    eprintln!("桌面空间退场动效失败: {error}");
                }
            }
            let _ = app_handle.emit_to(
                LABEL,
                "desktop-space-closing",
                ClosingSession {
                    session,
                    reduced_motion,
                },
            );
            if reduced_motion {
                let _ = manager.hide_matching(&app_handle, Some(session));
                return;
            }
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(180)).await;
                let ui_app = app_handle.clone();
                let _ = on_ui(&app_handle, move || {
                    if manager
                        .0
                        .inner
                        .lock()
                        .map(|inner| inner.close_expired(session))
                        .unwrap_or(false)
                    {
                        manager.hide_matching(&ui_app, Some(session))?;
                    }
                    Ok(())
                })
                .await;
            });
        });
        if let Err(error) = queued {
            if let Ok(mut inner) = self.0.inner.lock() {
                if inner.close_expired(session) {
                    inner.closing = false;
                }
            }
            return Err(error.to_string());
        }
        Ok(())
    }

    fn hide(&self, app: &AppHandle) -> Result<(), String> {
        self.hide_matching(app, None)
    }

    fn hide_matching(&self, app: &AppHandle, session: Option<u64>) -> Result<(), String> {
        {
            let mut inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
            if !inner.begin_hide(session) {
                return Ok(());
            }
        }
        if let Some(window) = app.get_webview_window(LABEL) {
            window.hide().map_err(|error| error.to_string())?;
        }
        self.emit_status(app);
        Ok(())
    }

    async fn release_space(&self, app: &AppHandle) -> Result<(), String> {
        let manager = self.clone();
        let app_handle = app.clone();
        on_ui(app, move || {
            manager.hide(&app_handle)?;
            if let Some(window) = app_handle.get_webview_window(LABEL) {
                window.destroy().map_err(|error| error.to_string())?;
            }
            Ok(())
        })
        .await?;
        for _ in 0..25 {
            if app.get_webview_window(LABEL).is_none() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Err("桌面空间窗口尚未完成关闭，请稍后重试".into())
    }

    pub(crate) fn shutdown(&self) {
        self.0.exiting.store(true, Ordering::Release);
        super::hotzone::stop_hotzone_monitor();
        self.0.ready.notify_waiters();
    }
}

#[cfg(test)]
fn launcher_bounds(
    position: PhysicalPosition<i32>,
    area: PhysicalSize<u32>,
    scale: f64,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    launcher_bounds_with_percentages(position, area, scale, 90.0, 70.0)
}

fn launcher_bounds_with_percentages(
    position: PhysicalPosition<i32>,
    area: PhysicalSize<u32>,
    scale: f64,
    width_percent: f64,
    height_percent: f64,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let width = ((area.width as f64 * width_percent.clamp(60.0, 96.0) / 100.0)
        .clamp(680.0 * scale, 1440.0 * scale) as u32)
        .min(area.width.saturating_sub(24).max(1));
    let height = ((area.height as f64 * height_percent.clamp(45.0, 90.0) / 100.0)
        .clamp(420.0 * scale, 850.0 * scale) as u32)
        .min(area.height.saturating_sub(24).max(1));
    (
        PhysicalPosition::new(
            position.x + (area.width.saturating_sub(width) / 2) as i32,
            position.y + (area.height.saturating_sub(height) / 2) as i32,
        ),
        PhysicalSize::new(width, height),
    )
}

async fn on_ui<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(operation());
    })
    .map_err(|error| error.to_string())?;
    receive
        .await
        .map_err(|_| "桌面窗口线程已结束".to_string())?
}

pub(crate) async fn show_classic_window(
    app: &AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    let manager = app.state::<DesktopSpaceManager>().inner().clone();
    on_ui(app, move || manager.show_classic_if_allowed(&window)).await
}

fn validate_mode_window(window: &WebviewWindow) -> Result<(), String> {
    if ["main", "desktop-organizer", LABEL].contains(&window.label()) {
        Ok(())
    } else {
        Err("此窗口不能设置桌面整理方式".into())
    }
}

fn validate_space_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err("此窗口不是桌面空间".into())
    }
}

#[tauri::command]
pub(crate) fn get_desktop_organizer_mode(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<OrganizerMode, String> {
    validate_mode_window(&window)?;
    Ok(app.state::<DesktopSpaceManager>().status(&app))
}

#[tauri::command]
pub(crate) async fn set_desktop_organizer_mode(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
    presentation: Presentation,
) -> Result<OrganizerMode, String> {
    validate_mode_window(&window)?;
    let manager = app.state::<DesktopSpaceManager>().inner().clone();
    let _guard = manager.0.transition.lock().await;
    if window.label() == LABEL && !manager.space_enabled() {
        return Err("桌面空间已关闭".into());
    }
    let (previous, configured) = {
        let inner = manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        (inner.mode, inner.configured)
    };
    let previous_hotzone_running = super::hotzone::is_hotzone_running();
    let mode = ModeConfig {
        version: 1,
        enabled,
        presentation,
        shortcut_initialized: previous.shortcut_initialized,
    };
    let path = app.state::<StorageManager>().config_file(MODE_FILE)?;
    fs::write(
        &path,
        serde_json::to_vec_pretty(&mode).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("保存桌面整理方式失败: {error}"))?;
    {
        let mut inner = manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        inner.mode = mode;
        inner.configured = true;
    }
    if let Err(error) = manager.apply_mode(&app, mode).await {
        {
            let mut inner = manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
            inner.mode = previous;
            inner.configured = configured;
        }
        if configured {
            let _ = fs::write(
                path,
                serde_json::to_vec_pretty(&previous).unwrap_or_default(),
            );
        } else {
            let _ = fs::remove_file(path);
        }
        let _ = manager.apply_mode(&app, previous).await;
        if !configured && previous_hotzone_running {
            let _ = crate::start_hotzone_monitor(app.clone());
        }
        manager.emit_status(&app);
        return Err(error);
    }
    manager.emit_status(&app);
    Ok(manager.status(&app))
}

#[tauri::command]
pub(crate) fn desktop_space_ready(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<DesktopViewport, String> {
    validate_space_window(&window)?;
    let manager = app.state::<DesktopSpaceManager>();
    if !manager.space_enabled() {
        return Err("桌面空间尚未启用".into());
    }
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let session = {
        let mut inner = manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        inner.ready = true;
        inner.session
    };
    manager.0.ready.notify_waiters();
    Ok(DesktopViewport {
        width: size.width,
        height: size.height,
        scale_factor,
        session,
        reduced_motion: super::space_settings::read_settings(&app)
            .map(|settings| settings.reduced_motion)
            .unwrap_or(false)
            || super::space_surface::system_reduced_motion(),
        light_background: None,
        background_luminance: None,
    })
}

#[tauri::command]
pub(crate) async fn desktop_space_show(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    validate_mode_window(&window)?;
    let manager = app.state::<DesktopSpaceManager>().inner().clone();
    let _guard = manager.0.transition.lock().await;
    manager.present(&app).await
}

#[tauri::command]
pub(crate) fn desktop_space_hide(
    app: AppHandle,
    window: WebviewWindow,
    session: Option<u64>,
) -> Result<(), String> {
    validate_space_window(&window)?;
    app.state::<DesktopSpaceManager>()
        .request_close_matching(&app, session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_mode_defaults_keep_the_classic_way() {
        let manager = DesktopSpaceManager::default();
        assert!(manager.classic_allowed());
        assert!(!manager.space_enabled());
        let mut inner = manager.0.inner.lock().unwrap();
        inner.configured = true;
        inner.mode.enabled = true;
        inner.mode.presentation = Presentation::Space;
        drop(inner);
        assert!(!manager.classic_allowed());
        assert!(manager.space_enabled());
        manager.shutdown();
        assert!(!manager.space_enabled());
    }

    #[test]
    fn existing_mode_configs_initialize_the_shortcut_once() {
        let old: ModeConfig =
            serde_json::from_str(r#"{"version":1,"enabled":true,"presentation":"space"}"#).unwrap();
        assert!(!old.shortcut_initialized);
        let initialized = ModeConfig {
            shortcut_initialized: true,
            ..old
        };
        let saved = serde_json::to_value(initialized).unwrap();
        assert_eq!(saved["shortcutInitialized"], true);
        assert!(
            serde_json::from_value::<ModeConfig>(saved)
                .unwrap()
                .shortcut_initialized
        );
    }

    #[test]
    fn delayed_close_or_hide_cannot_dismiss_a_newer_show() {
        let mut state = Inner::default();
        let first = state.begin_show();
        assert_eq!(state.begin_close(), Some(first));
        assert!(state.close_expired(first));
        assert!(state.begin_close().is_none());
        let reopened = state.begin_show();
        assert_ne!(first, reopened);
        assert!(!state.close_expired(first));
        assert!(!state.begin_hide(Some(first)));
        assert!(state.visible);
        assert_eq!(state.begin_close(), Some(reopened));
        assert!(state.close_expired(reopened));
        assert!(state.begin_hide(Some(reopened)));
        assert!(!state.visible);
        assert!(!state.close_expired(reopened));
    }

    #[test]
    fn repeated_close_requests_keep_one_deadline_and_reopen_invalidates_it() {
        let mut state = Inner::default();
        let first = state.begin_show();
        assert_eq!(state.begin_close(), Some(first));
        for _ in 0..5 {
            assert_eq!(state.begin_close(), None);
            assert_eq!(state.session, first);
            assert!(state.close_expired(first));
        }
        let reopened = state.begin_show();
        assert!(!state.close_expired(first));
        assert!(!state.begin_hide(Some(first)));
        assert!(state.visible);
        assert_eq!(state.begin_close(), Some(reopened));
        assert!(state.close_expired(reopened));
    }

    #[test]
    fn unversioned_and_internal_hides_invalidate_pending_closes() {
        let mut state = Inner::default();
        let first = state.begin_show();
        state.begin_close();
        assert!(state.begin_hide(None));
        assert!(!state.visible);
        assert!(!state.close_expired(first));
        let next = state.begin_show();
        assert_ne!(first, next);
        assert!(state.begin_hide(Some(next)));
        assert!(!state.begin_hide(Some(next)));
    }

    #[test]
    fn launcher_is_centered_in_the_mouse_monitors_work_area() {
        let (position, size) = launcher_bounds(
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1920, 1040),
            1.0,
        );
        assert_eq!(size, PhysicalSize::new(1440, 728));
        assert_eq!(position, PhysicalPosition::new(-1680, 156));
    }

    #[test]
    fn launcher_keeps_margins_on_small_or_high_dpi_screens() {
        let (position, size) = launcher_bounds(
            PhysicalPosition::new(0, 40),
            PhysicalSize::new(640, 400),
            2.0,
        );
        assert_eq!(size, PhysicalSize::new(616, 376));
        assert_eq!(position, PhysicalPosition::new(12, 52));
        let (_, size) = launcher_bounds(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(3840, 2080),
            2.0,
        );
        assert_eq!(size, PhysicalSize::new(2880, 1456));
    }
}
