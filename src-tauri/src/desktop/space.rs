//! Explorer owns the transparent desktop space; it stays behind application windows.
//!
//! The native window region contains only rendered controls. Empty wallpaper therefore
//! remains Explorer's surface for clicks, selection rectangles and context menus.
use crate::infrastructure::storage::StorageManager;
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

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
}

impl Default for ModeConfig {
    fn default() -> Self {
        Self { version: 1, enabled: false, presentation: Presentation::Classic }
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
    icons_hidden: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) struct InteractiveRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PixelRect { left: i32, top: i32, right: i32, bottom: i32 }

fn pixel_regions(regions: &[InteractiveRegion], scale: f64, width: i32, height: i32) -> Result<Vec<PixelRect>, String> {
    if regions.len() > 256 || !scale.is_finite() || !(0.5..=8.0).contains(&scale) {
        return Err("桌面交互区域参数无效".into());
    }
    let mut result = Vec::with_capacity(regions.len());
    for region in regions {
        if ![region.x, region.y, region.width, region.height].iter().all(|value| value.is_finite())
            || region.width < 0.0 || region.height < 0.0
            || region.width > 100_000.0 || region.height > 100_000.0 {
            return Err("桌面交互区域参数无效".into());
        }
        let rect = PixelRect {
            left: (region.x * scale).floor().clamp(0.0, width as f64) as i32,
            top: (region.y * scale).floor().clamp(0.0, height as f64) as i32,
            right: ((region.x + region.width) * scale).ceil().clamp(0.0, width as f64) as i32,
            bottom: ((region.y + region.height) * scale).ceil().clamp(0.0, height as f64) as i32,
        };
        if rect.right > rect.left && rect.bottom > rect.top { result.push(rect); }
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopViewport { width: u32, height: u32, scale_factor: f64, displays: Vec<DesktopDisplay> }

#[derive(Debug, Clone, Serialize)]
pub(crate) struct DesktopDisplay { id: String, x: f64, y: f64, width: f64, height: f64 }

fn viewport_displays(scale: f64) -> Vec<DesktopDisplay> {
    #[cfg(windows)]
    { native::logical_displays(scale).unwrap_or_default() }
    #[cfg(not(windows))]
    { let _ = scale; Vec::new() }
}

#[derive(Default)]
struct Inner {
    configured: bool,
    mode: ModeConfig,
    ready: bool,
    visible: bool,
    regions: Vec<InteractiveRegion>,
    #[cfg(windows)]
    attachment: Option<native::Attachment>,
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    transition: tokio::sync::Mutex<()>,
    ready: tokio::sync::Notify,
    monitoring: AtomicBool,
    exiting: AtomicBool,
}

#[derive(Default, Clone)]
pub(crate) struct DesktopSpaceManager(Arc<Shared>);

impl DesktopSpaceManager {
    pub(crate) fn restore_config(&self, app: &AppHandle) -> Result<(), String> {
        let path = app.state::<StorageManager>().config_file(MODE_FILE)?;
        if !path.exists() { return Ok(()); }
        let mode: ModeConfig = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("桌面整理配置无效: {error}"))?;
        if mode.version != 1 { return Err("桌面整理配置版本不受支持".into()); }
        let mut inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        inner.mode = mode;
        inner.configured = true;
        Ok(())
    }

    pub(crate) fn classic_allowed(&self) -> bool {
        self.0.inner.lock().map(|inner| !inner.configured || (inner.mode.enabled && inner.mode.presentation == Presentation::Classic)).unwrap_or(false)
    }

    pub(crate) fn show_classic_if_allowed(&self, window: &WebviewWindow) -> Result<(), String> {
        // Keep the mode check and UI operation together. A sleeping hot-zone
        // callback must not reshow the old panel after space took ownership.
        let inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        if !inner.configured || (inner.mode.enabled && inner.mode.presentation == Presentation::Classic) {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn space_enabled(&self) -> bool {
        !self.0.exiting.load(Ordering::Acquire) && self.0.inner.lock()
            .map(|inner| inner.mode.enabled && inner.mode.presentation == Presentation::Space).unwrap_or(false)
    }

    fn status(&self, app: &AppHandle) -> OrganizerMode {
        let inner = self.0.inner.lock().unwrap_or_else(|error| error.into_inner());
        OrganizerMode {
            configured: inner.configured, enabled: inner.mode.enabled, presentation: inner.mode.presentation,
            hotzone_running: super::hotzone::is_hotzone_running(),
            desktop_space_visible: inner.visible && app.get_webview_window(LABEL).is_some(),
            icons_hidden: false,
        }
    }

    fn emit_status(&self, app: &AppHandle) { let _ = app.emit("desktop-organizer-mode-changed", self.status(app)); }

    pub(crate) fn resume(&self, app: &AppHandle) {
        let manager = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = manager.0.transition.lock().await;
            let mode = manager.0.inner.lock().map(|inner| inner.mode).unwrap_or_default();
            if let Err(error) = manager.apply_mode(&app, mode).await {
                eprintln!("[DesktopSpace] 恢复桌面整理失败: {error}");
                let _ = app.emit("desktop-organizer-error", error);
            }
        });
    }

    async fn apply_mode(&self, app: &AppHandle, mode: ModeConfig) -> Result<(), String> {
        super::hotzone::set_user_interacting(false);
        super::hotzone::stop_hotzone_monitor();
        if let Some(window) = app.get_webview_window("desktop-organizer") { let _ = window.hide(); }
        if !mode.enabled || mode.presentation == Presentation::Classic {
            self.release_space(app).await?;
            if mode.enabled { crate::start_hotzone_monitor(app.clone())?; }
            return Ok(());
        }
        self.ensure_space(app).await?;
        self.start_monitor(app);
        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                let notified = self.0.ready.notified();
                if self.0.inner.lock().map(|inner| inner.visible).unwrap_or(false) { break; }
                notified.await;
            }
        }).await.map_err(|_| "桌面空间未能完成加载，已恢复之前的整理方式".to_string())?;
        Ok(())
    }

    async fn ensure_space(&self, app: &AppHandle) -> Result<(), String> {
        #[cfg(not(windows))]
        { let _ = app; return Err("桌面空间目前仅支持 Windows".into()); }
        #[cfg(windows)]
        {
            if !self.space_enabled() { return Ok(()); }
            let desktop = native::find_desktop()?;
            let window = match app.get_webview_window(LABEL) {
                Some(window) if native::window_exists(&window) => window,
                stale => {
                    if let Some(window) = stale { let _ = window.destroy(); }
                    let mut inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
                    inner.attachment = None;
                    inner.ready = false;
                    inner.visible = false;
                    inner.regions.clear();
                    drop(inner);
                    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("desktop-organizer/index.html?host=desktop".into()))
                        .title("桌面空间")
                        .owner_raw(windows_webview2::Win32::Foundation::HWND(desktop.parent as *mut std::ffi::c_void))
                        .disable_drag_drop_handler().transparent(true)
                        .background_color(tauri::window::Color(0, 0, 0, 0))
                        .decorations(false).resizable(false).always_on_top(false).skip_taskbar(true)
                        .visible(false).shadow(false).inner_size(800.0, 600.0)
                        .build().map_err(|error| format!("创建桌面空间失败: {error}"))?;
                    let dismissal = window.clone();
                    window.on_window_event(move |event| {
                        // WebView2 may retain document focus when its Explorer-
                        // owned HWND loses activation to the wallpaper. DOM blur
                        // alone cannot close a panel on a real outside click.
                        if matches!(event, WindowEvent::Focused(false)) {
                            let _ = dismissal.emit("desktop-space-close-transients", ());
                        }
                    });
                    window
                }
            };
            let manager = self.clone();
            let app_handle = app.clone();
            on_ui(app, move || manager.attach_on_ui(&app_handle, &window, desktop)).await
        }
    }

    #[cfg(windows)]
    fn attach_on_ui(&self, app: &AppHandle, window: &WebviewWindow, desktop: native::Desktop) -> Result<(), String> {
        if !self.space_enabled() { return Ok(()); }
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let mut inner = self.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        let changed = inner.attachment.as_ref().map(|attachment| !attachment.matches(&desktop)).unwrap_or(true);
        if changed {
            inner.attachment = None;
            native::attach(window, &desktop)?;
            let attachment = native::Attachment::new(desktop);
            let rectangles = pixel_regions(&inner.regions, scale, desktop.width(), desktop.height())?;
            native::set_region(window, &rectangles)?;
            if inner.ready && !rectangles.is_empty() {
                native::show(window);
                inner.visible = true;
            }
            inner.attachment = Some(attachment);
            drop(inner);
            let _ = app.emit_to(LABEL, "desktop-space-workarea-changed", DesktopViewport { width: desktop.width() as u32, height: desktop.height() as u32, scale_factor: scale, displays: viewport_displays(scale) });
        }
        Ok(())
    }

    async fn release_space(&self, app: &AppHandle) -> Result<(), String> {
        let visible = self.0.inner.lock().map(|inner| inner.visible).unwrap_or(false);
        if visible && app.get_webview_window(LABEL).is_some() {
            // Let the furniture leave gently while the true wallpaper stays still.
            // A fixed bound also handles a page that is already closing or unresponsive.
            let _ = app.emit_to(LABEL, "desktop-space-hiding", ());
            tokio::time::sleep(Duration::from_millis(160)).await;
        }
        let manager = self.clone();
        let app_handle = app.clone();
        on_ui(app, move || {
            if let Some(window) = app_handle.get_webview_window(LABEL) {
                let _ = window.hide();
                let _ = window.destroy();
            }
            manager.release_native();
            Ok(())
        }).await?;
        // Destroy is dispatched. Wait for label removal so rapid re-enabling cannot
        // accidentally reuse a WebView which is already being destroyed.
        for _ in 0..25 {
            if app.get_webview_window(LABEL).is_none() { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok(())
    }

    fn release_native(&self) {
        if let Ok(mut inner) = self.0.inner.lock() {
            #[cfg(windows)]
            { inner.attachment = None; }
            inner.ready = false;
            inner.visible = false;
            inner.regions.clear();
        }
    }

    pub(crate) fn shutdown(&self) {
        self.0.exiting.store(true, Ordering::Release);
        super::hotzone::stop_hotzone_monitor();
        self.release_native();
    }

    fn start_monitor(&self, app: &AppHandle) {
        if self.0.monitoring.swap(true, Ordering::AcqRel) { return; }
        let manager = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            while manager.space_enabled() {
                std::thread::sleep(Duration::from_secs(1));
                if !manager.space_enabled() { break; }
                if let Ok(_guard) = manager.0.transition.try_lock() {
                    // Creation runs off the UI thread. Attachment/regions themselves
                    // are serialized onto the UI thread, including Explorer recovery.
                    if let Err(error) = tauri::async_runtime::block_on(manager.ensure_space(&app)) {
                        eprintln!("[DesktopSpace] 等待桌面恢复: {error}");
                    }
                }
            }
            manager.0.monitoring.store(false, Ordering::Release);
            // A new mode may have arrived between the loop condition and shutdown.
            if manager.space_enabled() { manager.start_monitor(&app); }
        });
    }
}

async fn on_ui<T: Send + 'static>(app: &AppHandle, operation: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = send.send(operation()); }).map_err(|error| error.to_string())?;
    receive.await.map_err(|_| "桌面窗口线程已结束".to_string())?
}

pub(crate) async fn show_classic_window(app: &AppHandle, window: WebviewWindow) -> Result<(), String> {
    let manager = app.state::<DesktopSpaceManager>().inner().clone();
    on_ui(app, move || manager.show_classic_if_allowed(&window)).await
}

fn validate_mode_window(window: &WebviewWindow) -> Result<(), String> {
    if ["main", "desktop-organizer", LABEL].contains(&window.label()) { Ok(()) }
    else { Err("此窗口不能设置桌面整理方式".into()) }
}

fn validate_space_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == LABEL { Ok(()) } else { Err("此窗口不是桌面空间".into()) }
}

#[tauri::command]
pub(crate) fn get_desktop_organizer_mode(app: AppHandle, window: WebviewWindow) -> Result<OrganizerMode, String> {
    validate_mode_window(&window)?;
    Ok(app.state::<DesktopSpaceManager>().status(&app))
}

#[tauri::command]
pub(crate) async fn set_desktop_organizer_mode(app: AppHandle, window: WebviewWindow, enabled: bool, presentation: Presentation) -> Result<OrganizerMode, String> {
    validate_mode_window(&window)?;
    let manager = app.state::<DesktopSpaceManager>().inner().clone();
    let _guard = manager.0.transition.lock().await;
    // A toolbar request queued before another window switched away must not
    // resurrect a desktop surface that has since been retired.
    if window.label() == LABEL && !manager.space_enabled() {
        return Err("桌面空间已关闭".into());
    }
    let previous = manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?.mode;
    let mode = ModeConfig { version: 1, enabled, presentation };
    let path = app.state::<StorageManager>().config_file(MODE_FILE)?;
    fs::write(&path, serde_json::to_vec_pretty(&mode).map_err(|error| error.to_string())?)
        .map_err(|error| format!("保存桌面整理方式失败: {error}"))?;
    {
        let mut inner = manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        inner.mode = mode;
        inner.configured = true;
    }
    if let Err(error) = manager.apply_mode(&app, mode).await {
        manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?.mode = previous;
        let _ = fs::write(path, serde_json::to_vec_pretty(&previous).unwrap_or_default());
        let _ = manager.apply_mode(&app, previous).await;
        manager.emit_status(&app);
        return Err(error);
    }
    manager.emit_status(&app);
    Ok(manager.status(&app))
}

#[tauri::command]
pub(crate) async fn desktop_space_ready(app: AppHandle, window: WebviewWindow) -> Result<DesktopViewport, String> {
    validate_space_window(&window)?;
    let manager = app.state::<DesktopSpaceManager>().inner().clone();
    if !manager.space_enabled() { return Err("桌面空间尚未启用".into()); }
    // The first page load can race the builder's return. Ensure mounting has
    // finished before the frontend measures its initial viewport.
    manager.ensure_space(&app).await?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?.ready = true;
    manager.0.ready.notify_waiters();
    Ok(DesktopViewport { width: size.width, height: size.height, scale_factor, displays: viewport_displays(scale_factor) })
}

#[tauri::command]
pub(crate) async fn desktop_space_set_regions(app: AppHandle, window: WebviewWindow, regions: Vec<InteractiveRegion>) -> Result<(), String> {
    validate_space_window(&window)?;
    let manager = app.state::<DesktopSpaceManager>().inner().clone();
    if !manager.space_enabled() { return Err("桌面空间尚未启用".into()); }
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let rectangles = pixel_regions(&regions, scale, size.width as i32, size.height as i32)?;
    on_ui(&app, move || {
        if !manager.space_enabled() { return Ok(()); }
        #[cfg(windows)]
        native::set_region(&window, &rectangles)?;
        let mut inner = manager.0.inner.lock().map_err(|_| "桌面整理状态不可用")?;
        inner.regions = regions;
        if inner.ready && !rectangles.is_empty() {
            #[cfg(windows)]
            {
                if inner.attachment.is_none() { return Err("桌面空间尚未挂载".into()); }
                if !inner.visible { native::show(&window); }
            }
            inner.visible = true;
        }
        drop(inner);
        manager.0.ready.notify_waiters();
        Ok(())
    }).await
}

#[cfg(windows)]
mod native;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_mode_defaults_keep_the_classic_way() {
        let mode: ModeConfig = serde_json::from_str(r#"{"version":1,"enabled":true,"presentation":"classic"}"#).unwrap();
        assert_eq!(mode.presentation, Presentation::Classic);
        assert!(mode.enabled);
        assert!(serde_json::from_str::<ModeConfig>(r#"{"version":1,"enabled":true,"presentation":"unknown"}"#).is_err());
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
    }

    #[test]
    fn shaped_regions_scale_outward_and_clip_to_the_work_area() {
        let result = pixel_regions(&[
            InteractiveRegion { x: -5.0, y: 0.5, width: 10.0, height: 20.0 },
            InteractiveRegion { x: 70.0, y: 70.0, width: 50.0, height: 50.0 },
            InteractiveRegion { x: 200.0, y: 200.0, width: 10.0, height: 10.0 },
        ], 1.25, 100, 100).unwrap();
        assert_eq!(result, vec![PixelRect { left: 0, top: 0, right: 7, bottom: 26 }, PixelRect { left: 87, top: 87, right: 100, bottom: 100 }]);
    }

    #[test]
    fn invalid_regions_cannot_replace_the_native_shape() {
        assert!(pixel_regions(&[InteractiveRegion { x: 0.0, y: 0.0, width: f64::INFINITY, height: 5.0 }], 1.0, 1920, 1080).is_err());
        assert!(pixel_regions(&[InteractiveRegion { x: 0.0, y: 0.0, width: -1.0, height: 5.0 }], 1.0, 1920, 1080).is_err());
        assert!(pixel_regions(&[], f64::NAN, 1920, 1080).is_err());
        assert!(pixel_regions(&[], 1.0, 1920, 1080).unwrap().is_empty());
    }
}
