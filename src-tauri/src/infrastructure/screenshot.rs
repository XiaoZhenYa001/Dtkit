use super::quick_host::QUICK_HOST_LABEL_PREFIX;
use super::screenshot_content::{decode_png, png_bytes, MAX_SCREENSHOT_BYTES};
use super::storage::StorageManager;
use crate::path_safety::validate_leaf_filename;
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const REGION_OVERLAY_LABEL_PREFIX: &str = "screen-region-overlay-";
const LONG_BORDER_LABEL_PREFIX: &str = "screen-long-border-";
const MAX_LONG_SCREENSHOT_PIXELS: u64 = 16_000_000;

pub(crate) async fn wait_for_hidden_window() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::DwmFlush;
        for _ in 0..2 {
            let _ = tauri::async_runtime::spawn_blocking(|| unsafe { DwmFlush() }).await;
        }
    }
    #[cfg(not(target_os = "windows"))]
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenCapture {
    pub(crate) data_url: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) x: i32,
    pub(crate) y: i32,
}

#[derive(Clone)]
struct ScreenRegionCaptureSession {
    owner_label: String,
    request: ScreenRequestContext,
    hidden_quick_hosts: Vec<TemporarilyHiddenQuickHost>,
    capture: Option<ScreenCapture>,
    long_direction: Option<String>,
    long_mode: String,
    keep_hidden: bool,
    max_segments: u8,
    source_rect: (i32, i32, u32, u32),
    cancelled: Arc<AtomicBool>,
    finishing: bool,
    border_label: Option<String>,
}

#[derive(Clone)]
struct TemporarilyHiddenQuickHost {
    label: String,
    was_visible: bool,
    was_minimized: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenRegionSource {
    #[serde(flatten)]
    capture: ScreenCapture,
    long_direction: Option<String>,
    long_mode: String,
}

#[derive(Default)]
pub(crate) struct ScreenRegionCaptureManager {
    next_label: AtomicU64,
    sessions: Mutex<HashMap<String, ScreenRegionCaptureSession>>,
    cancelled_requests: Mutex<HashMap<(String, String, String), Instant>>,
}

impl ScreenRegionCaptureSession {
    fn matches(&self, owner: &str, request: &ScreenRequestContext) -> bool {
        self.owner_label == owner
            && self.request.instance_id == request.instance_id
            && self.request.request_id == request.request_id
    }
}

fn request_key(owner: &str, request: &ScreenRequestContext) -> Option<(String, String, String)> {
    Some((
        owner.into(),
        request.instance_id.clone()?,
        request.request_id.clone()?,
    ))
}

fn remember_cancellation(
    requests: &mut HashMap<(String, String, String), Instant>,
    key: (String, String, String),
) {
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

impl ScreenRegionCaptureManager {
    pub(crate) fn cancel_window(&self, app: &AppHandle, owner_label: &str) {
        let labels = self
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .filter(|(_, session)| session.owner_label == owner_label)
                    .map(|(label, session)| {
                        session.cancelled.store(true, Ordering::Release);
                        label.clone()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for label in labels {
            complete_session(app, label, None, false);
        }
    }
}

// Removal, window visibility and future request registration are serialized on
// the UI thread. An old completion cannot reveal windows hidden by a new shot.
fn complete_session(
    app: &AppHandle,
    label: String,
    capture: Option<ScreenCapture>,
    restore_owner: bool,
) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let session = handle
            .state::<ScreenRegionCaptureManager>()
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&label));
        let Some(session) = session else { return };
        session.cancelled.store(true, Ordering::Release);
        if session.keep_hidden {
            let quick_hosts = handle.state::<super::quick_host::QuickHostManager>();
            for state in &session.hidden_quick_hosts {
                if state.was_visible && state.label.starts_with(QUICK_HOST_LABEL_PREFIX) {
                    quick_hosts.retain_for_manual_restore(&state.label);
                }
            }
        }
        if let Some(overlay) = handle.get_webview_window(&label) {
            let _ = overlay.close();
        }
        if let Some(border) = session
            .border_label
            .as_deref()
            .and_then(|label| handle.get_webview_window(label))
        {
            let _ = border.close();
        }
        if restore_owner {
            restore_region_capture_owner(&handle, session, capture);
        } else {
            // Closing to tray must not reopen the owner. Other windows hidden
            // for this request still regain their original visible state.
            if !session.keep_hidden {
                restore_capture_windows(
                    &handle,
                    &session.owner_label,
                    &session.hidden_quick_hosts,
                    false,
                );
            }
        }
    });
}

async fn reserve_and_hide(
    window: WebviewWindow,
    label: String,
    request: ScreenRequestContext,
    long_direction: Option<String>,
    long_mode: String,
    keep_hidden: bool,
    max_segments: u8,
) -> Result<bool, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let manager = target.state::<ScreenRegionCaptureManager>();
                let mut cancelled = manager
                    .cancelled_requests
                    .lock()
                    .map_err(|_| "截图状态不可用")?;
                cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(120));
                if request_key(target.label(), &request)
                    .is_some_and(|key| cancelled.remove(&key).is_some())
                {
                    return Ok(false);
                }
                let mut sessions = manager.sessions.lock().map_err(|_| "截图状态不可用")?;
                if !sessions.is_empty() {
                    return Err("已有截图任务，请先完成或取消".to_string());
                }
                let hidden_quick_hosts = hide_quick_hosts_for_capture(&target, keep_hidden)?;
                sessions.insert(
                    label,
                    ScreenRegionCaptureSession {
                        owner_label: target.label().into(),
                        request,
                        hidden_quick_hosts,
                        capture: None,
                        long_direction,
                        long_mode,
                        keep_hidden,
                        max_segments,
                        source_rect: (0, 0, 0, 0),
                        cancelled: Arc::new(AtomicBool::new(false)),
                        finishing: false,
                        border_label: None,
                    },
                );
                Ok(true)
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| format!("调度截图窗口失败：{error}"))?;
    receiver
        .await
        .map_err(|error| format!("截图窗口任务异常结束：{error}"))?
}

async fn show_session_window(window: WebviewWindow, session_label: String) -> Result<bool, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let result = target
                .state::<ScreenRegionCaptureManager>()
                .sessions
                .lock()
                .map_err(|_| "截图状态不可用".to_string())
                .and_then(|sessions| {
                    if sessions
                        .get(&session_label)
                        .is_none_or(|session| session.cancelled.load(Ordering::Acquire))
                    {
                        return Ok(false);
                    }
                    target
                        .show()
                        .map_err(|error| format!("显示截图窗口失败：{error}"))?;
                    Ok(true)
                });
            let _ = sender.send(result);
        })
        .map_err(|error| format!("调度截图窗口失败：{error}"))?;
    receiver
        .await
        .map_err(|error| format!("截图窗口任务异常结束：{error}"))?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenRegionCaptureResult {
    #[serde(flatten)]
    request: ScreenRequestContext,
    cancelled: bool,
    capture: Option<ScreenCapture>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenRequestContext {
    pub(crate) instance_id: Option<String>,
    pub(crate) request_id: Option<String>,
}

impl ScreenRequestContext {
    pub(crate) fn new(
        instance_id: Option<String>,
        request_id: Option<String>,
    ) -> Result<Self, String> {
        let valid = |value: &str| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        };
        match (&instance_id, &request_id) {
            (None, None) => {} // Compatibility with older single-page callers.
            (Some(instance), Some(request)) if valid(instance) && valid(request) => {}
            _ => return Err("屏幕操作缺少有效的页面或请求标识".to_string()),
        }
        Ok(Self {
            instance_id,
            request_id,
        })
    }
}

fn hide_quick_hosts_for_capture(
    owner: &WebviewWindow,
    hide_main: bool,
) -> Result<Vec<TemporarilyHiddenQuickHost>, String> {
    let owner_label = owner.label();
    let mut hidden = Vec::new();
    for (label, candidate) in owner.app_handle().webview_windows() {
        if label != owner_label
            && !label.starts_with(QUICK_HOST_LABEL_PREFIX)
            && !(hide_main && label == "main")
        {
            continue;
        }
        let was_visible = candidate.is_visible().unwrap_or(true);
        let was_minimized = candidate.is_minimized().unwrap_or(false);
        if was_visible {
            if let Err(error) = candidate.hide() {
                if label == owner_label || hide_main {
                    restore_capture_windows(owner.app_handle(), "", &hidden, false);
                    return Err(format!("隐藏 DtKit 窗口失败: {error}"));
                }
                continue;
            }
        }
        hidden.push(TemporarilyHiddenQuickHost {
            label,
            was_visible,
            was_minimized,
        });
    }
    Ok(hidden)
}

fn restore_capture_windows(
    app: &AppHandle,
    owner_label: &str,
    hidden_quick_hosts: &[TemporarilyHiddenQuickHost],
    restore_owner: bool,
) {
    for state in hidden_quick_hosts {
        if state.label == owner_label || !state.was_visible {
            continue;
        }
        if let Some(window) = app.get_webview_window(&state.label) {
            let _ = window.show();
            if state.was_minimized {
                let _ = window.minimize();
            }
        }
    }
    if let Some(owner) = app
        .get_webview_window(owner_label)
        .filter(|_| restore_owner)
    {
        let _ = owner.show();
        let _ = owner.unminimize();
        let _ = owner.set_focus();
    }
}

fn restore_region_capture_owner(
    app: &AppHandle,
    session: ScreenRegionCaptureSession,
    capture: Option<ScreenCapture>,
) {
    if let Some(owner) = app.get_webview_window(&session.owner_label) {
        let result = ScreenRegionCaptureResult {
            request: session.request.clone(),
            cancelled: capture.is_none(),
            capture,
        };
        let _ = owner.emit("screen-region-captured", result);
    }
    if !session.keep_hidden {
        restore_capture_windows(app, &session.owner_label, &session.hidden_quick_hosts, true);
    }
}

fn validate_long_mode(mode: Option<&str>) -> Result<&str, String> {
    match mode.unwrap_or("automatic") {
        value @ ("manual" | "automatic") => Ok(value),
        _ => Err("长截图滚动方式无效".into()),
    }
}

fn validate_selected_capture(
    data_url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<Option<ScreenCapture>, String> {
    if data_url.is_none() && width.is_none() && height.is_none() {
        return Ok(None);
    }
    let data_url = data_url.ok_or_else(|| "截图选区缺少图像数据".to_string())?;
    let width = width.ok_or_else(|| "截图选区缺少宽度".to_string())?;
    let height = height.ok_or_else(|| "截图选区缺少高度".to_string())?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 100_000_000 {
        return Err("截图选区尺寸无效或过大".to_string());
    }
    let bytes = png_bytes(&data_url)?;
    let image = decode_png(&bytes)?;
    if image.dimensions() != (width, height) {
        return Err("截图选区尺寸与 PNG 图像不一致".into());
    }
    Ok(Some(ScreenCapture {
        data_url,
        width,
        height,
        x: 0,
        y: 0,
    }))
}

#[cfg(target_os = "windows")]
pub(crate) fn capture_virtual_screen() -> Result<ScreenCapture, String> {
    use image::{ImageBuffer, Rgba};
    use std::io::Cursor;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 || (width as i64) * (height as i64) > 100_000_000 {
        return Err("当前虚拟桌面尺寸无效或过大".to_string());
    }

    let screen = unsafe { GetDC(HWND(std::ptr::null_mut())) };
    if screen.is_invalid() {
        return Err("无法读取桌面画面".to_string());
    }
    let memory = unsafe { CreateCompatibleDC(screen) };
    if memory.is_invalid() {
        unsafe { ReleaseDC(HWND(std::ptr::null_mut()), screen) };
        return Err("无法创建截图缓冲区".to_string());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen, width, height) };
    if bitmap.is_invalid() {
        unsafe {
            let _ = DeleteDC(memory);
            ReleaseDC(HWND(std::ptr::null_mut()), screen);
        }
        return Err("无法创建截图位图".to_string());
    }
    let old = unsafe { SelectObject(memory, bitmap) };
    let copied = unsafe {
        BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            x,
            y,
            SRCCOPY | CAPTUREBLT,
        )
    };
    if copied.is_err() {
        unsafe {
            SelectObject(memory, old);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(memory);
            ReleaseDC(HWND(std::ptr::null_mut()), screen);
        }
        return Err("复制桌面画面失败".to_string());
    }

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        bmiColors: [Default::default()],
    };
    let mut pixels = vec![0_u8; width as usize * height as usize * 4];
    let lines = unsafe {
        GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        SelectObject(memory, old);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(memory);
        ReleaseDC(HWND(std::ptr::null_mut()), screen);
    }
    if lines == 0 {
        return Err("读取截图像素失败".to_string());
    }
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    let image: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width as u32, height as u32, pixels)
            .ok_or_else(|| "创建截图图像失败".to_string())?;
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|error| format!("编码截图失败: {error}"))?;
    Ok(ScreenCapture {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ),
        width: width as u32,
        height: height as u32,
        x,
        y,
    })
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn capture_virtual_screen() -> Result<ScreenCapture, String> {
    Err("截图与标注当前仅支持 Windows".to_string())
}

#[derive(Clone, Copy)]
struct CaptureRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
fn capture_region_image(rect: CaptureRect) -> Result<image::RgbaImage, String> {
    use image::{ImageBuffer, Rgba};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };

    let width = i32::try_from(rect.width).map_err(|_| "长截图宽度无效".to_string())?;
    let height = i32::try_from(rect.height).map_err(|_| "长截图高度无效".to_string())?;
    let screen = unsafe { GetDC(HWND(std::ptr::null_mut())) };
    if screen.is_invalid() {
        return Err("无法读取长截图区域".to_string());
    }
    let memory = unsafe { CreateCompatibleDC(screen) };
    if memory.is_invalid() {
        unsafe { ReleaseDC(HWND(std::ptr::null_mut()), screen) };
        return Err("无法创建长截图缓冲区".to_string());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen, width, height) };
    if bitmap.is_invalid() {
        unsafe {
            let _ = DeleteDC(memory);
            ReleaseDC(HWND(std::ptr::null_mut()), screen);
        }
        return Err("无法创建长截图位图".to_string());
    }
    let old = unsafe { SelectObject(memory, bitmap) };
    let copied = unsafe {
        BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            rect.x,
            rect.y,
            SRCCOPY | CAPTUREBLT,
        )
    };
    if copied.is_err() {
        unsafe {
            SelectObject(memory, old);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(memory);
            ReleaseDC(HWND(std::ptr::null_mut()), screen);
        }
        return Err("复制长截图区域失败".to_string());
    }
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        bmiColors: [Default::default()],
    };
    let mut pixels = vec![0_u8; rect.width as usize * rect.height as usize * 4];
    let lines = unsafe {
        GetDIBits(
            memory,
            bitmap,
            0,
            rect.height,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        SelectObject(memory, old);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(memory);
        ReleaseDC(HWND(std::ptr::null_mut()), screen);
    }
    if lines == 0 {
        return Err("读取长截图像素失败".to_string());
    }
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(rect.width, rect.height, pixels)
        .ok_or_else(|| "创建长截图图像失败".to_string())
}

#[cfg(target_os = "windows")]
fn sampled_difference(
    previous: &image::RgbaImage,
    next: &image::RgbaImage,
    overlap: u32,
    vertical: bool,
) -> f64 {
    let (width, height) = previous.dimensions();
    let step_x = (width / 96).max(2) as usize;
    let step_y = (height / 72).max(2) as usize;
    let mut difference = 0_u64;
    let mut samples = 0_u64;
    if vertical {
        for y in (0..overlap).step_by(step_y) {
            for x in (0..width).step_by(step_x) {
                let a = previous.get_pixel(x, height - overlap + y).0;
                let b = next.get_pixel(x, y).0;
                difference += a[..3]
                    .iter()
                    .zip(&b[..3])
                    .map(|(left, right)| left.abs_diff(*right) as u64)
                    .sum::<u64>();
                samples += 3;
            }
        }
    } else {
        for y in (0..height).step_by(step_y) {
            for x in (0..overlap).step_by(step_x) {
                let a = previous.get_pixel(width - overlap + x, y).0;
                let b = next.get_pixel(x, y).0;
                difference += a[..3]
                    .iter()
                    .zip(&b[..3])
                    .map(|(left, right)| left.abs_diff(*right) as u64)
                    .sum::<u64>();
                samples += 3;
            }
        }
    }
    difference as f64 / samples.max(1) as f64
}

#[cfg(target_os = "windows")]
fn frames_are_equal(previous: &image::RgbaImage, next: &image::RgbaImage) -> bool {
    let step_x = (previous.width() / 96).max(2) as usize;
    let step_y = (previous.height() / 72).max(2) as usize;
    let mut difference = 0_u64;
    let mut samples = 0_u64;
    for y in (0..previous.height()).step_by(step_y) {
        for x in (0..previous.width()).step_by(step_x) {
            let a = previous.get_pixel(x, y).0;
            let b = next.get_pixel(x, y).0;
            difference += a[..3]
                .iter()
                .zip(&b[..3])
                .map(|(left, right)| left.abs_diff(*right) as u64)
                .sum::<u64>();
            samples += 3;
        }
    }
    difference as f64 / (samples.max(1) as f64) < 1.8
}

#[cfg(target_os = "windows")]
fn find_vertical_overlap(previous: &image::RgbaImage, next: &image::RgbaImage) -> u32 {
    find_overlap(previous, next, true)
}

#[cfg(target_os = "windows")]
fn find_horizontal_overlap(previous: &image::RgbaImage, next: &image::RgbaImage) -> u32 {
    find_overlap(previous, next, false)
}

#[cfg(target_os = "windows")]
fn find_overlap(previous: &image::RgbaImage, next: &image::RgbaImage, vertical: bool) -> u32 {
    let span = if vertical {
        previous.height()
    } else {
        previous.width()
    };
    let minimum = (span / 10).max(8);
    let maximum = (span * 9 / 10).max(minimum);
    let step = (span / 160).max(2) as usize;
    (minimum..=maximum)
        .step_by(step)
        .min_by(|left, right| {
            sampled_difference(previous, next, *left, vertical)
                .total_cmp(&sampled_difference(previous, next, *right, vertical))
        })
        .unwrap_or(minimum)
}

#[cfg(target_os = "windows")]
struct LongImage {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[cfg(target_os = "windows")]
impl LongImage {
    fn new(image: &image::RgbaImage) -> Self {
        Self {
            width: image.width(),
            height: image.height(),
            pixels: image.as_raw().clone(),
        }
    }

    fn append_vertical(&mut self, image: &image::RgbaImage, overlap: u32) -> Result<(), String> {
        let added = image.height().saturating_sub(overlap);
        if u64::from(self.width) * u64::from(self.height + added) > MAX_LONG_SCREENSHOT_PIXELS {
            return Err("长截图已达到低内存安全上限".to_string());
        }
        let start = overlap as usize * image.width() as usize * 4;
        self.pixels.extend_from_slice(&image.as_raw()[start..]);
        self.height += added;
        Ok(())
    }

    fn append_horizontal(&mut self, image: &image::RgbaImage, overlap: u32) -> Result<(), String> {
        let added = image.width().saturating_sub(overlap);
        let new_width = self.width + added;
        if u64::from(new_width) * u64::from(self.height) > MAX_LONG_SCREENSHOT_PIXELS {
            return Err("长截图已达到低内存安全上限".to_string());
        }
        let old_stride = self.width as usize * 4;
        let new_stride = new_width as usize * 4;
        let added_stride = added as usize * 4;
        self.pixels.resize(new_stride * self.height as usize, 0);
        for row in (0..self.height as usize).rev() {
            self.pixels
                .copy_within(row * old_stride..(row + 1) * old_stride, row * new_stride);
            let source = row * image.width() as usize * 4 + overlap as usize * 4;
            let destination = row * new_stride + old_stride;
            self.pixels[destination..destination + added_stride]
                .copy_from_slice(&image.as_raw()[source..source + added_stride]);
        }
        self.width = new_width;
        Ok(())
    }

    fn into_capture(self, x: i32, y: i32) -> Result<ScreenCapture, String> {
        use std::io::Cursor;
        let image = image::RgbaImage::from_raw(self.width, self.height, self.pixels)
            .ok_or_else(|| "生成长截图失败".to_string())?;
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|error| format!("编码长截图失败: {error}"))?;
        if png.len() > MAX_SCREENSHOT_BYTES {
            return Err("长截图超过 100MB 限制".to_string());
        }
        Ok(ScreenCapture {
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            ),
            width: image.width(),
            height: image.height(),
            x,
            y,
        })
    }
}

#[cfg(target_os = "windows")]
fn scroll_target_window(target: isize, rect: CaptureRect, direction: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        PostMessageW, WHEEL_DELTA, WM_MOUSEHWHEEL, WM_MOUSEWHEEL,
    };
    let vertical = direction == "vertical";
    let delta: i16 = if vertical {
        -(WHEEL_DELTA as i16) * 6
    } else {
        (WHEEL_DELTA as i16) * 6
    };
    let wparam = WPARAM((delta as u16 as usize) << 16);
    let center_x = rect.x + rect.width as i32 / 2;
    let center_y = rect.y + rect.height as i32 / 2;
    let lparam = LPARAM((((center_y as u16 as u32) << 16) | center_x as u16 as u32) as isize);
    unsafe {
        PostMessageW(
            HWND(target as *mut _),
            if vertical {
                WM_MOUSEWHEEL
            } else {
                WM_MOUSEHWHEEL
            },
            wparam,
            lparam,
        )
    }
    .map_err(|error| format!("无法滚动目标窗口: {error}"))
}

#[cfg(target_os = "windows")]
fn target_window_at(rect: CaptureRect) -> Result<isize, String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::WindowFromPoint;
    let point = POINT {
        x: rect.x + rect.width as i32 / 2,
        y: rect.y + rect.height as i32 / 2,
    };
    let target = unsafe { WindowFromPoint(point) };
    if target.is_invalid() {
        Err("未找到长截图目标窗口".to_string())
    } else {
        Ok(target.0 as isize)
    }
}

#[cfg(target_os = "windows")]
fn capture_automatic_long_region(
    rect: CaptureRect,
    direction: String,
    max_segments: u8,
    target: isize,
    cancelled: Arc<AtomicBool>,
) -> Result<ScreenCapture, String> {
    let vertical = direction == "vertical";
    let mut previous = capture_region_image(rect)?;
    let mut output = LongImage::new(&previous);
    let was_cancelled = || {
        cancelled.load(Ordering::Acquire)
            || unsafe {
                windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
                    windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE.0 as i32,
                ) < 0
            }
    };
    for _ in 1..max_segments {
        if was_cancelled() {
            return Err("长截图已取消".into());
        }
        scroll_target_window(target, rect, &direction)?;
        std::thread::sleep(std::time::Duration::from_millis(360));
        if was_cancelled() {
            return Err("长截图已取消".into());
        }
        let next = capture_region_image(rect)?;
        if frames_are_equal(&previous, &next) {
            break;
        }
        let overlap = if vertical {
            find_vertical_overlap(&previous, &next)
        } else {
            find_horizontal_overlap(&previous, &next)
        };
        let appended = if vertical {
            output.append_vertical(&next, overlap)
        } else {
            output.append_horizontal(&next, overlap)
        };
        if appended.is_err() {
            break;
        }
        previous = next;
    }
    output.into_capture(rect.x, rect.y)
}

// Reserve these keys on the capture worker's own message queue. Enter must not
// also reach the target application (for example, send a chat message).
#[cfg(target_os = "windows")]
struct ManualCaptureKeys;

#[cfg(target_os = "windows")]
impl ManualCaptureKeys {
    const FINISH: i32 = 0x4451;
    const CANCEL: i32 = 0x4452;

    fn register() -> Result<Self, String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            RegisterHotKey, MOD_NOREPEAT, VK_ESCAPE, VK_RETURN,
        };
        let guard = Self;
        unsafe {
            RegisterHotKey(
                HWND::default(),
                Self::FINISH,
                MOD_NOREPEAT,
                u32::from(VK_RETURN.0),
            )
            .map_err(|_| {
                "无法占用 Enter 完成长截图，请关闭占用该键的程序或使用自动模式".to_string()
            })?;
            RegisterHotKey(
                HWND::default(),
                Self::CANCEL,
                MOD_NOREPEAT,
                u32::from(VK_ESCAPE.0),
            )
            .map_err(|_| {
                "无法占用 Esc 取消长截图，请关闭占用该键的程序或使用自动模式".to_string()
            })?;
        }
        Ok(guard)
    }

    fn poll(&self) -> (bool, bool) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY};
        let mut message = MSG::default();
        let (mut finish, mut cancel) = (false, false);
        while unsafe {
            PeekMessageW(
                &mut message,
                HWND::default(),
                WM_HOTKEY,
                WM_HOTKEY,
                PM_REMOVE,
            )
        }
        .as_bool()
        {
            finish |= message.wParam.0 == Self::FINISH as usize;
            cancel |= message.wParam.0 == Self::CANCEL as usize;
        }
        (finish, cancel)
    }
}

#[cfg(target_os = "windows")]
impl Drop for ManualCaptureKeys {
    fn drop(&mut self) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Input::KeyboardAndMouse::UnregisterHotKey;
        unsafe {
            let _ = UnregisterHotKey(HWND::default(), Self::FINISH);
            let _ = UnregisterHotKey(HWND::default(), Self::CANCEL);
        }
        // Tokio reuses blocking threads. Do not leave old WM_HOTKEY messages
        // behind for a later capture running on this same thread.
        let _ = self.poll();
    }
}

#[cfg(target_os = "windows")]
fn reliable_forward_overlap(
    previous: &image::RgbaImage,
    next: &image::RgbaImage,
    vertical: bool,
) -> Option<u32> {
    let span = if vertical {
        previous.height()
    } else {
        previous.width()
    };
    let refine = |a: &image::RgbaImage, b: &image::RgbaImage| {
        let coarse = find_overlap(a, b, vertical);
        let radius = (span / 160).max(2);
        let overlap = (coarse.saturating_sub(radius).max(8)..=(coarse + radius).min(span * 9 / 10))
            .min_by(|left, right| {
                sampled_difference(a, b, *left, vertical)
                    .total_cmp(&sampled_difference(a, b, *right, vertical))
            })?;
        Some((overlap, sampled_difference(a, b, overlap, vertical)))
    };
    let (overlap, error) = refine(previous, next)?;
    let (_, reverse_error) = refine(next, previous)?;
    // Blank, repeated or backwards-moving content cannot establish a reliable
    // forward seam. Keep the last accepted frame so the user can scroll back.
    if error > 8.0 || reverse_error < error + 1.0 {
        return None;
    }
    Some(overlap)
}

#[cfg(target_os = "windows")]
fn capture_manual_long_region(
    rect: CaptureRect,
    direction: String,
    max_segments: u8,
    cancelled: Arc<AtomicBool>,
    progress: impl Fn(&str),
) -> Result<ScreenCapture, String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RETURN};
    let keys = ManualCaptureKeys::register()?;
    let vertical = direction == "vertical";
    let mut previous = capture_region_image(rect)?;
    let mut candidate = previous.clone();
    let mut output = LongImage::new(&previous);
    let mut changed_at = Instant::now();
    let started = Instant::now();
    let mut segments = 1;
    let mut ready_for_finish = false;
    let mut finish_requested = None;
    let mut last_message = String::new();
    let mut last_progress_at = Instant::now();
    loop {
        let (finish, cancel) = keys.poll();
        if cancelled.load(Ordering::Acquire) || cancel {
            return Err("长截图已取消".into());
        }
        if finish && ready_for_finish && finish_requested.is_none() {
            finish_requested = Some(Instant::now());
        }
        // Selection may have been confirmed by Enter or a held mouse button.
        // Only accept a fresh Enter after both have been released.
        if unsafe {
            GetAsyncKeyState(VK_RETURN.0 as i32) >= 0 && GetAsyncKeyState(VK_LBUTTON.0 as i32) >= 0
        } {
            ready_for_finish = true;
        }
        let next = capture_region_image(rect)?;
        if !frames_are_equal(&candidate, &next) {
            candidate = next;
            changed_at = Instant::now();
        }
        let mut message =
            format!("手动滚动 · 已采集 {segments}/{max_segments} 段 · Enter 完成 · Esc 取消");
        if changed_at.elapsed() >= Duration::from_millis(240)
            && !frames_are_equal(&previous, &candidate)
        {
            if let Some(overlap) = reliable_forward_overlap(&previous, &candidate, vertical) {
                let appended = if vertical {
                    output.append_vertical(&candidate, overlap)
                } else {
                    output.append_horizontal(&candidate, overlap)
                };
                if appended.is_err() {
                    break;
                }
                previous = candidate.clone();
                segments += 1;
                message = format!(
                    "手动滚动 · 已采集 {segments}/{max_segments} 段 · Enter 完成 · Esc 取消"
                );
                if segments >= max_segments {
                    break;
                }
            } else {
                message =
                    "未匹配重叠：向回滚动后减小幅度，再稍停 · Enter 保留已采集部分 · Esc 取消"
                        .into();
            }
        }
        // The border's listener can initialize after our first emit. Repeat the
        // current status at most once per second while this capture is active.
        if message != last_message || last_progress_at.elapsed() >= Duration::from_secs(1) {
            progress(&message);
            last_message = message;
            last_progress_at = Instant::now();
        }
        if finish_requested.is_some_and(|time| {
            time.elapsed() >= Duration::from_millis(300)
                && (changed_at.elapsed() >= Duration::from_millis(240)
                    || time.elapsed() >= Duration::from_secs(2))
        }) || started.elapsed() >= Duration::from_secs(600)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("长截图已取消".into());
    }
    output.into_capture(rect.x, rect.y)
}

#[cfg(target_os = "windows")]
// Worker inputs and the public capture IPC fields stay separate to preserve
// the existing capture protocol and its cancellation/ownership boundaries.
#[allow(clippy::too_many_arguments)]
async fn run_automatic_long_capture(
    app: &AppHandle,
    rect: CaptureRect,
    direction: String,
    mode: String,
    max_segments: u8,
    border_label: String,
    session_label: String,
    cancelled: Arc<AtomicBool>,
) -> Result<ScreenCapture, String> {
    let target = if mode == "automatic" {
        tauri::async_runtime::spawn_blocking(move || target_window_at(rect))
            .await
            .map_err(|error| format!("定位长截图窗口失败: {error}"))??
    } else {
        0
    };
    let border = WebviewWindowBuilder::new(
        app,
        &border_label,
        WebviewUrl::App(format!("long-capture-border.html?mode={mode}").into()),
    )
    .title("DtKit 长截图")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .transparent(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| format!("创建长截图边框失败: {error}"))?;
    let _ = border.set_position(PhysicalPosition::new(rect.x - 4, rect.y - 4));
    let _ = border.set_size(PhysicalSize::new(rect.width + 8, rect.height + 8));
    let _ = border.set_content_protected(true);
    let _ = border.set_ignore_cursor_events(true);
    match show_session_window(border.clone(), session_label).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = border.close();
            return Err("长截图已取消".into());
        }
        Err(error) => {
            let _ = border.close();
            return Err(error);
        }
    }
    wait_for_hidden_window().await;
    let progress = border.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if mode == "manual" {
            capture_manual_long_region(rect, direction, max_segments, cancelled, |message| {
                let _ = progress.emit("screen-long-progress", message);
            })
        } else {
            capture_automatic_long_region(rect, direction, max_segments, target, cancelled)
        }
    })
    .await
    .map_err(|error| format!("长截图任务异常结束: {error}"))
    .and_then(|capture| capture);
    let _ = border.close();
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_screen_region_capture(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenRegionCaptureManager>,
    long_direction: Option<String>,
    long_mode: Option<String>,
    keep_hidden: Option<bool>,
    max_segments: Option<u8>,
    delay_ms: Option<u64>,
    instance_id: Option<String>,
    request_id: Option<String>,
) -> Result<(), String> {
    let request = ScreenRequestContext::new(instance_id, request_id)?;
    let _work = super::launch::keep_native_work(window.app_handle());
    if long_direction
        .as_deref()
        .is_some_and(|value| value != "vertical" && value != "horizontal")
    {
        return Err("长截图方向无效".into());
    }
    let long_mode = validate_long_mode(long_mode.as_deref())?.to_string();
    let delay = delay_ms.unwrap_or(0);
    if ![0, 3000, 5000, 10000].contains(&delay) {
        return Err("延时截图可选 0、3、5 或 10 秒".into());
    }
    let sequence = manager.next_label.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("{REGION_OVERLAY_LABEL_PREFIX}{sequence}");
    if !reserve_and_hide(
        window.clone(),
        label.clone(),
        request,
        long_direction,
        long_mode,
        keep_hidden.unwrap_or(false),
        max_segments.unwrap_or(12).clamp(2, 20),
    )
    .await?
    {
        return Ok(());
    }
    let result = start_reserved_capture(&window, &label, delay).await;
    if result.is_err() {
        complete_session(window.app_handle(), label, None, true);
    }
    result
}

async fn start_reserved_capture(
    window: &WebviewWindow,
    label: &str,
    delay: u64,
) -> Result<(), String> {
    let app = window.app_handle();
    let manager = app.state::<ScreenRegionCaptureManager>();
    let is_active = || {
        manager
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .get(label)
                    .is_some_and(|session| !session.cancelled.load(Ordering::Acquire))
            })
            .unwrap_or(false)
    };
    // The original DtKit windows are already hidden, allowing the user to
    // open a menu or tooltip during the delay. Check cancellation every 50 ms.
    let deadline = Instant::now() + Duration::from_millis(delay);
    while Instant::now() < deadline {
        if !is_active() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    wait_for_hidden_window().await;
    if !is_active() {
        return Ok(());
    }
    let capture = tauri::async_runtime::spawn_blocking(capture_virtual_screen)
        .await
        .map_err(|error| format!("截图任务异常结束：{error}"))??;
    let (capture_x, capture_y, capture_width, capture_height) =
        (capture.x, capture.y, capture.width, capture.height);
    {
        let mut sessions = manager.sessions.lock().map_err(|_| "截图状态不可用")?;
        let Some(session) = sessions.get_mut(label) else {
            return Ok(());
        };
        if session.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        session.source_rect = (capture_x, capture_y, capture_width, capture_height);
        session.capture = Some(capture);
    }
    let overlay =
        WebviewWindowBuilder::new(app, label, WebviewUrl::App("screen-region.html".into()))
            .title("DtKit 区域截图")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(true)
            .visible(false)
            .build()
            .map_err(|error| format!("创建截图选区覆盖层失败：{error}"))?;
    if let Err(error) = overlay
        .set_position(PhysicalPosition::new(capture_x, capture_y))
        .and_then(|_| overlay.set_size(PhysicalSize::new(capture_width, capture_height)))
    {
        let _ = overlay.close();
        return Err(format!("设置截图选区覆盖层失败：{error}"));
    }
    let handle = app.clone();
    let session_label = label.to_string();
    overlay.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            let should_cancel = handle
                .state::<ScreenRegionCaptureManager>()
                .sessions
                .lock()
                .ok()
                .and_then(|sessions| {
                    sessions
                        .get(&session_label)
                        .map(|session| !session.finishing)
                })
                .unwrap_or(false);
            if should_cancel {
                complete_session(&handle, session_label.clone(), None, true);
            }
        }
    });
    match show_session_window(overlay.clone(), label.to_string()).await {
        Ok(true) => {
            let _ = overlay.set_focus();
            Ok(())
        }
        Ok(false) => {
            let _ = overlay.close();
            Ok(())
        }
        Err(error) => {
            let _ = overlay.close();
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_screen_region_capture(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenRegionCaptureManager>,
    instance_id: Option<String>,
    request_id: Option<String>,
) -> Result<(), String> {
    let request = ScreenRequestContext::new(instance_id, request_id)?;
    let mut cancelled = manager
        .cancelled_requests
        .lock()
        .map_err(|_| "截图状态不可用")?;
    if let Some(key) = request_key(window.label(), &request) {
        remember_cancellation(&mut cancelled, key);
    }
    let label = manager
        .sessions
        .lock()
        .map_err(|_| "截图状态不可用")?
        .iter()
        .find(|(_, session)| session.matches(window.label(), &request))
        .map(|(label, session)| {
            session.cancelled.store(true, Ordering::Release);
            label.clone()
        });
    drop(cancelled);
    if let Some(label) = label {
        complete_session(window.app_handle(), label, None, true);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_screen_region_capture(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenRegionCaptureManager>,
) -> Result<ScreenRegionSource, String> {
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "截图选区状态不可用".to_string())?;
    let session = sessions
        .get_mut(window.label())
        .ok_or_else(|| "截图选区会话不存在".to_string())?;
    let capture = session
        .capture
        .take()
        .ok_or_else(|| "截图选区画面不存在或已释放".to_string())?;
    Ok(ScreenRegionSource {
        capture,
        long_direction: session.long_direction.clone(),
        long_mode: session.long_mode.clone(),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn finish_screen_region_capture(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenRegionCaptureManager>,
    data_url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    x: Option<i32>,
    y: Option<i32>,
    long_direction: Option<String>,
    long_mode: Option<String>,
    max_segments: Option<u8>,
) -> Result<(), String> {
    let _work = super::launch::keep_native_work(window.app_handle());
    let label = window.label().to_string();
    let mut session = {
        let mut sessions = manager.sessions.lock().map_err(|_| "截图选区状态不可用")?;
        let Some(session) = sessions.get_mut(&label) else {
            return Ok(());
        };
        if session.finishing || session.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        session.finishing = true;
        session.capture = None;
        session.clone()
    };
    let app = window.app_handle().clone();
    let _ = window.close();
    if data_url.is_none() && width.is_none() && height.is_none() && x.is_none() && y.is_none() {
        complete_session(&app, label, None, true);
        return Ok(());
    }
    let direction = long_direction.or_else(|| session.long_direction.clone());
    let mode = match validate_long_mode(long_mode.as_deref().or(Some(&session.long_mode))) {
        Ok(mode) => mode.to_string(),
        Err(error) => {
            complete_session(&app, label, None, true);
            return Err(error);
        }
    };
    if direction
        .as_deref()
        .is_some_and(|value| value != "vertical" && value != "horizontal")
    {
        complete_session(&app, label, None, true);
        return Err("长截图方向无效".into());
    }
    if let Some(value) = max_segments {
        session.max_segments = value.clamp(2, 20);
    }
    let Some(direction) = direction else {
        let result = tauri::async_runtime::spawn_blocking(move || {
            validate_selected_capture(data_url, width, height)
        })
        .await
        .map_err(|error| format!("选区验证任务异常结束：{error}"))
        .and_then(|capture| capture);
        return match result {
            Ok(capture) => {
                complete_session(&app, label, capture, true);
                Ok(())
            }
            Err(error) => {
                complete_session(&app, label, None, true);
                Err(error)
            }
        };
    };
    let (source_x, source_y, source_width, source_height) = session.source_rect;
    let rect = (|| -> Result<CaptureRect, String> {
        if data_url.is_some() {
            return Err("长截图不接受前端图像数据".to_string());
        }
        let rect = CaptureRect {
            x: x.ok_or_else(|| "长截图选区缺少横坐标".to_string())?,
            y: y.ok_or_else(|| "长截图选区缺少纵坐标".to_string())?,
            width: width.ok_or_else(|| "长截图选区缺少宽度".to_string())?,
            height: height.ok_or_else(|| "长截图选区缺少高度".to_string())?,
        };
        let inside_source = rect.width >= 40
            && rect.height >= 40
            && rect.x >= source_x
            && rect.y >= source_y
            && i64::from(rect.x) + i64::from(rect.width)
                <= i64::from(source_x) + i64::from(source_width)
            && i64::from(rect.y) + i64::from(rect.height)
                <= i64::from(source_y) + i64::from(source_height);
        if inside_source {
            Ok(rect)
        } else {
            Err("长截图选区无效或超出屏幕".to_string())
        }
    })();

    #[cfg(target_os = "windows")]
    let result = match rect {
        Ok(rect) => {
            wait_for_hidden_window().await;
            let border_label = format!(
                "{LONG_BORDER_LABEL_PREFIX}{}",
                manager.next_label.fetch_add(1, Ordering::Relaxed) + 1
            );
            {
                let mut sessions = manager.sessions.lock().map_err(|_| "截图状态不可用")?;
                let Some(active) = sessions.get_mut(&label) else {
                    return Ok(());
                };
                active.border_label = Some(border_label.clone());
            }
            run_automatic_long_capture(
                &app,
                rect,
                direction,
                mode,
                session.max_segments,
                border_label,
                label.clone(),
                session.cancelled.clone(),
            )
            .await
        }
        Err(error) => Err(error),
    };
    #[cfg(not(target_os = "windows"))]
    let result: Result<ScreenCapture, String> = Err("自动长截图当前仅支持 Windows".to_string());

    match result {
        Ok(capture) => {
            complete_session(&app, label, Some(capture), true);
            Ok(())
        }
        Err(error) => {
            complete_session(&app, label, None, true);
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn save_annotated_screenshot(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    filename: String,
    data_url: String,
) -> Result<String, String> {
    let _work = super::launch::keep_native_work(&app);
    validate_leaf_filename(&filename)?;
    if !filename.to_ascii_lowercase().ends_with(".png") {
        return Err("截图只能保存为 PNG 文件".into());
    }
    let directory = storage.layout()?.screenshots;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let bytes = png_bytes(&data_url)?;
        decode_png(&bytes)?;
        fs::create_dir_all(&directory).map_err(|error| format!("创建截图目录失败：{error}"))?;
        let path = directory.join(filename);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "同名截图已存在".to_string()
                } else {
                    format!("创建截图文件失败：{error}")
                }
            })?;
        if let Err(error) = file.write_all(&bytes) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("保存截图失败：{error}"));
        }
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("保存截图任务异常结束：{error}"))?
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::{find_horizontal_overlap, find_vertical_overlap, LongImage};
    use super::{remember_cancellation, request_key, ScreenRegionCaptureSession};
    use super::{validate_selected_capture, ScreenRegionCaptureResult, ScreenRequestContext};

    #[test]
    fn long_capture_modes_validate_without_changing_legacy_callers() {
        assert_eq!(super::validate_long_mode(None).unwrap(), "automatic");
        assert_eq!(super::validate_long_mode(Some("manual")).unwrap(), "manual");
        assert!(super::validate_long_mode(Some("unknown")).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn manual_stitch_accepts_forward_content_and_rejects_reverse_blank_or_unrelated_frames() {
        let frame = |offset| {
            image::RgbaImage::from_fn(80, 180, |x, y| {
                let y = y + offset;
                image::Rgba([
                    ((x * 13 + y * 17) % 251) as u8,
                    ((x * 3 + y * 23) % 253) as u8,
                    ((x * 31 + y * 7) % 255) as u8,
                    255,
                ])
            })
        };
        let first = frame(0);
        let next = frame(60);
        assert_eq!(
            super::reliable_forward_overlap(&first, &next, true),
            Some(120)
        );
        assert!(super::reliable_forward_overlap(&next, &first, true).is_none());
        let blank = image::RgbaImage::from_pixel(80, 180, image::Rgba([255, 255, 255, 255]));
        assert!(super::reliable_forward_overlap(&first, &blank, true).is_none());
        assert!(super::reliable_forward_overlap(&blank, &blank, true).is_none());
        let noise = image::RgbaImage::from_fn(80, 180, |x, y| {
            image::Rgba([
                ((x * 11 + y * 39) % 251) as u8,
                ((x * 3 + y * 37) % 253) as u8,
                ((x * 19 + y * 9) % 255) as u8,
                255,
            ])
        });
        assert!(super::reliable_forward_overlap(&first, &noise, true).is_none());
    }

    #[test]
    fn cancellation_requires_the_owner_page_and_request_and_has_a_bounded_race_cache() {
        let request =
            ScreenRequestContext::new(Some("page-a".into()), Some("capture-1".into())).unwrap();
        let session = ScreenRegionCaptureSession {
            owner_label: "main".into(),
            request: request.clone(),
            hidden_quick_hosts: Vec::new(),
            capture: None,
            long_direction: None,
            long_mode: "automatic".into(),
            keep_hidden: false,
            max_segments: 12,
            source_rect: (0, 0, 100, 100),
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            finishing: false,
            border_label: None,
        };
        assert!(session.matches("main", &request));
        assert!(!session.matches("quick-host-1", &request));
        assert!(!session.matches(
            "main",
            &ScreenRequestContext::new(Some("page-b".into()), Some("capture-1".into())).unwrap()
        ));
        assert!(!session.matches(
            "main",
            &ScreenRequestContext::new(Some("page-a".into()), Some("capture-2".into())).unwrap()
        ));
        assert!(!session.matches("main", &ScreenRequestContext::new(None, None).unwrap()));
        let mut cancelled = std::collections::HashMap::new();
        for index in 0..300 {
            remember_cancellation(
                &mut cancelled,
                ("main".into(), "page-a".into(), format!("capture-{index}")),
            );
        }
        assert_eq!(cancelled.len(), 256);
        let key = request_key("main", &request).unwrap();
        remember_cancellation(&mut cancelled, key.clone());
        assert!(cancelled.remove(&key).is_some());
        assert!(cancelled.remove(&key).is_none());
    }

    #[test]
    fn capture_results_retain_the_exact_page_and_request_identity() {
        let request =
            ScreenRequestContext::new(Some("page-a".into()), Some("request-2".into())).unwrap();
        let result = ScreenRegionCaptureResult {
            request,
            cancelled: true,
            capture: None,
        };
        let payload = serde_json::to_value(result).unwrap();
        assert_eq!(payload["instanceId"], "page-a");
        assert_eq!(payload["requestId"], "request-2");
        assert_eq!(payload["cancelled"], true);
        assert!(ScreenRequestContext::new(Some("page-a".into()), None).is_err());
        assert!(ScreenRequestContext::new(None, Some("request-2".into())).is_err());
        assert!(ScreenRequestContext::new(Some("".into()), Some("request-2".into())).is_err());
        assert!(
            ScreenRequestContext::new(Some("x".repeat(257)), Some("request-2".into())).is_err()
        );
        assert!(
            ScreenRequestContext::new(Some("page-a\n".into()), Some("request-2".into())).is_err()
        );
        assert!(ScreenRequestContext::new(None, None).is_ok());
    }

    #[test]
    fn selected_capture_requires_complete_bounded_png_metadata() {
        assert!(validate_selected_capture(None, None, None)
            .unwrap()
            .is_none());
        assert!(validate_selected_capture(
            Some("data:image/png;base64,AA==".into()),
            None,
            Some(10)
        )
        .is_err());
        assert!(validate_selected_capture(
            Some("data:text/plain;base64,AA==".into()),
            Some(10),
            Some(10)
        )
        .is_err());
        assert!(validate_selected_capture(
            Some("data:image/png;base64,AA==".into()),
            Some(0),
            Some(10)
        )
        .is_err());
        let image = image::RgbaImage::from_pixel(320, 180, image::Rgba([10, 20, 30, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png.get_ref())
        );
        assert!(validate_selected_capture(Some(data_url.clone()), Some(180), Some(320)).is_err());
        let capture = validate_selected_capture(Some(data_url), Some(320), Some(180))
            .unwrap()
            .unwrap();
        assert_eq!((capture.width, capture.height), (320, 180));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn automatic_long_capture_detects_overlap_and_appends_without_frame_history() {
        let vertical_a = image::RgbaImage::from_fn(24, 100, |x, y| {
            image::Rgba([(y * 2) as u8, x as u8, y as u8, 255])
        });
        let vertical_b = image::RgbaImage::from_fn(24, 100, |x, y| {
            let source_y = y + 60;
            image::Rgba([(source_y * 2) as u8, x as u8, source_y as u8, 255])
        });
        let vertical_overlap = find_vertical_overlap(&vertical_a, &vertical_b);
        assert!((38..=42).contains(&vertical_overlap));
        let mut vertical = LongImage::new(&vertical_a);
        vertical
            .append_vertical(&vertical_b, vertical_overlap)
            .unwrap();
        assert!((158..=162).contains(&vertical.height));

        let horizontal_a = image::RgbaImage::from_fn(100, 24, |x, y| {
            image::Rgba([(x * 2) as u8, y as u8, x as u8, 255])
        });
        let horizontal_b = image::RgbaImage::from_fn(100, 24, |x, y| {
            let source_x = x + 60;
            image::Rgba([(source_x * 2) as u8, y as u8, source_x as u8, 255])
        });
        let horizontal_overlap = find_horizontal_overlap(&horizontal_a, &horizontal_b);
        assert!((38..=42).contains(&horizontal_overlap));
        let mut horizontal = LongImage::new(&horizontal_a);
        horizontal
            .append_horizontal(&horizontal_b, horizontal_overlap)
            .unwrap();
        assert!((158..=162).contains(&horizontal.width));
    }
}
