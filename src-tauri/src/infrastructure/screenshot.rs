use super::storage::StorageManager;
use crate::path_safety::validate_leaf_filename;
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const MAX_SCREENSHOT_BYTES: usize = 100 * 1024 * 1024;
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
    capture: Option<ScreenCapture>,
    long_direction: Option<String>,
    max_segments: u8,
    source_rect: (i32, i32, u32, u32),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenRegionSource {
    #[serde(flatten)]
    capture: ScreenCapture,
    long_direction: Option<String>,
}

#[derive(Default)]
pub(crate) struct ScreenRegionCaptureManager {
    next_label: AtomicU64,
    sessions: Mutex<HashMap<String, ScreenRegionCaptureSession>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenRegionCaptureResult {
    cancelled: bool,
    capture: Option<ScreenCapture>,
}

fn restore_region_capture_owner(
    app: &AppHandle,
    session: ScreenRegionCaptureSession,
    capture: Option<ScreenCapture>,
) {
    if let Some(owner) = app.get_webview_window(&session.owner_label) {
        let result = ScreenRegionCaptureResult {
            cancelled: capture.is_none(),
            capture,
        };
        let _ = owner.emit("screen-region-captured", result);
        let _ = owner.show();
        let _ = owner.unminimize();
        let _ = owner.set_focus();
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
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "截图选区数据格式无效".to_string())?;
    let max_encoded_len = MAX_SCREENSHOT_BYTES.saturating_mul(4) / 3 + 8;
    if encoded.len() > max_encoded_len {
        return Err("截图选区数据超过 100MB 限制".to_string());
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
) -> Result<ScreenCapture, String> {
    let vertical = direction == "vertical";
    let mut previous = capture_region_image(rect)?;
    let mut output = LongImage::new(&previous);
    for _ in 1..max_segments {
        scroll_target_window(target, rect, &direction)?;
        std::thread::sleep(std::time::Duration::from_millis(360));
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

#[cfg(target_os = "windows")]
async fn run_automatic_long_capture(
    app: &AppHandle,
    rect: CaptureRect,
    direction: String,
    max_segments: u8,
    border_label: String,
) -> Result<ScreenCapture, String> {
    let target = tauri::async_runtime::spawn_blocking(move || target_window_at(rect))
        .await
        .map_err(|error| format!("定位长截图窗口失败: {error}"))??;
    let border = WebviewWindowBuilder::new(
        app,
        &border_label,
        WebviewUrl::App("long-capture-border.html".into()),
    )
    .title("DtKit 自动长截图")
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
    let _ = border.show();
    wait_for_hidden_window().await;
    let result = tauri::async_runtime::spawn_blocking(move || {
        capture_automatic_long_region(rect, direction, max_segments, target)
    })
    .await
    .map_err(|error| format!("自动长截图任务异常结束: {error}"))
    .and_then(|capture| capture);
    let _ = border.close();
    result
}

#[tauri::command]
pub(crate) async fn start_screen_region_capture(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenRegionCaptureManager>,
    long_direction: Option<String>,
    max_segments: Option<u8>,
) -> Result<(), String> {
    if let Some(direction) = &long_direction {
        if direction != "vertical" && direction != "horizontal" {
            return Err("长截图方向无效".to_string());
        }
    }
    let owner_label = window.label().to_string();
    window
        .hide()
        .map_err(|error| format!("隐藏截图来源窗口失败: {error}"))?;
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
            return Err(format!("截图任务异常结束: {error}"));
        }
    };

    let sequence = manager.next_label.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("{REGION_OVERLAY_LABEL_PREFIX}{sequence}");
    let overlay = match WebviewWindowBuilder::new(
        window.app_handle(),
        &label,
        WebviewUrl::App("screen-region.html".into()),
    )
    .title("DtKit 区域截图")
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
            return Err(format!("创建截图选区覆盖层失败: {error}"));
        }
    };
    if let Err(error) = overlay.set_position(PhysicalPosition::new(capture.x, capture.y)) {
        let _ = overlay.close();
        let _ = window.show();
        return Err(format!("定位截图选区覆盖层失败: {error}"));
    }
    if let Err(error) = overlay.set_size(PhysicalSize::new(capture.width, capture.height)) {
        let _ = overlay.close();
        let _ = window.show();
        return Err(format!("调整截图选区覆盖层失败: {error}"));
    }
    let source_rect = (capture.x, capture.y, capture.width, capture.height);
    manager
        .sessions
        .lock()
        .map_err(|_| "截图选区状态不可用".to_string())?
        .insert(
            label.clone(),
            ScreenRegionCaptureSession {
                owner_label,
                capture: Some(capture),
                long_direction,
                max_segments: max_segments.unwrap_or(12).clamp(2, 20),
                source_rect,
            },
        );
    let app = window.app_handle().clone();
    overlay.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            let session = app
                .state::<ScreenRegionCaptureManager>()
                .sessions
                .lock()
                .ok()
                .and_then(|mut sessions| sessions.remove(&label));
            if let Some(session) = session {
                restore_region_capture_owner(&app, session, None);
            }
        }
    });
    overlay.show().map_err(|error| {
        if let Ok(mut sessions) = manager.sessions.lock() {
            sessions.remove(overlay.label());
        }
        let _ = overlay.close();
        let _ = window.show();
        format!("显示截图选区覆盖层失败: {error}")
    })?;
    let _ = overlay.set_focus();
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
    })
}

#[tauri::command]
pub(crate) async fn finish_screen_region_capture(
    window: WebviewWindow,
    manager: tauri::State<'_, ScreenRegionCaptureManager>,
    data_url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<(), String> {
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "截图选区状态不可用".to_string())?
        .remove(window.label())
        .ok_or_else(|| "截图选区会话不存在".to_string())?;
    let app = window.app_handle().clone();
    let _ = window.close();

    let Some(direction) = session.long_direction.clone() else {
        return match validate_selected_capture(data_url, width, height) {
            Ok(capture) => {
                restore_region_capture_owner(&app, session, capture);
                Ok(())
            }
            Err(error) => {
                restore_region_capture_owner(&app, session, None);
                Err(error)
            }
        };
    };
    let (source_x, source_y, source_width, source_height) = session.source_rect;
    let rect = (|| -> Result<CaptureRect, String> {
        if data_url.is_some() {
            return Err("自动长截图不接受前端图像数据".to_string());
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
            run_automatic_long_capture(&app, rect, direction, session.max_segments, border_label)
                .await
        }
        Err(error) => Err(error),
    };
    #[cfg(not(target_os = "windows"))]
    let result: Result<ScreenCapture, String> = Err("自动长截图当前仅支持 Windows".to_string());

    match result {
        Ok(capture) => {
            restore_region_capture_owner(&app, session, Some(capture));
            Ok(())
        }
        Err(error) => {
            restore_region_capture_owner(&app, session, None);
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn save_annotated_screenshot(
    storage: tauri::State<'_, StorageManager>,
    filename: String,
    data_url: String,
) -> Result<String, String> {
    validate_leaf_filename(&filename)?;
    if !filename.to_ascii_lowercase().ends_with(".png") {
        return Err("截图只能保存为 PNG 文件".to_string());
    }
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "截图数据格式无效".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "截图数据损坏".to_string())?;
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err("截图数据超过 100MB 限制".to_string());
    }
    let layout = storage.layout()?;
    fs::create_dir_all(&layout.screenshots)
        .map_err(|error| format!("创建截图目录失败: {error}"))?;
    let path = layout.screenshots.join(filename);
    if path.exists() {
        return Err("同名截图已存在".to_string());
    }
    fs::write(&path, bytes).map_err(|error| format!("保存截图失败: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_selected_capture;
    #[cfg(target_os = "windows")]
    use super::{find_horizontal_overlap, find_vertical_overlap, LongImage};

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
        let capture = validate_selected_capture(
            Some("data:image/png;base64,AA==".into()),
            Some(320),
            Some(180),
        )
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
