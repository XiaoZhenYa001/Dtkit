use super::storage::StorageManager;
use crate::path_safety::validate_leaf_filename;
use base64::Engine;
use serde::Serialize;
use std::fs;
use tauri::WebviewWindow;

const MAX_SCREENSHOT_BYTES: usize = 100 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenCapture {
    data_url: String,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
fn capture_virtual_screen() -> Result<ScreenCapture, String> {
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
    })
}

#[cfg(not(target_os = "windows"))]
fn capture_virtual_screen() -> Result<ScreenCapture, String> {
    Err("截图与标注当前仅支持 Windows".to_string())
}

#[tauri::command]
pub(crate) async fn capture_screen_for_annotation(
    window: WebviewWindow,
) -> Result<ScreenCapture, String> {
    window
        .hide()
        .map_err(|error| format!("隐藏截图窗口失败: {error}"))?;
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    let capture = tauri::async_runtime::spawn_blocking(capture_virtual_screen)
        .await
        .map_err(|error| format!("截图任务异常结束: {error}"))?;
    let _ = window.show();
    let _ = window.set_focus();
    capture
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
