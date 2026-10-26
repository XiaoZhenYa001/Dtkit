// 文件图标提取模块
// File Icon Extractor - 从文件中提取图标

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use image::{ImageBuffer, Rgba};
use lazy_static::lazy_static;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON,
    SHGFI_LARGEICON, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

/// 图标缓存 - 使用 LRU 缓存策略
/// 最多缓存 200 个图标，避免内存过度占用
const MAX_CACHE_SIZE: usize = 200;

lazy_static! {
    static ref ICON_CACHE: Mutex<IconCache> = Mutex::new(IconCache::new(MAX_CACHE_SIZE));
}

/// LRU 图标缓存
struct IconCache {
    cache: HashMap<String, CacheEntry>,
    access_order: Vec<String>,
    max_size: usize,
}

struct CacheEntry {
    icon_data: Option<String>,
}

impl IconCache {
    fn new(max_size: usize) -> Self {
        Self {
            cache: HashMap::new(),
            access_order: Vec::new(),
            max_size,
        }
    }

    fn get(&mut self, key: &str) -> Option<Option<String>> {
        if let Some(entry) = self.cache.get(key) {
            // 更新访问顺序
            self.access_order.retain(|k| k != key);
            self.access_order.push(key.to_string());
            Some(entry.icon_data.clone())
        } else {
            None
        }
    }

    fn insert(&mut self, key: String, icon_data: Option<String>) {
        // 如果缓存已满，移除最久未使用的项
        while self.cache.len() >= self.max_size && !self.access_order.is_empty() {
            if let Some(oldest) = self.access_order.first().cloned() {
                self.cache.remove(&oldest);
                self.access_order.remove(0);
            }
        }

        self.cache.insert(key.clone(), CacheEntry { icon_data });
        self.access_order.push(key);
    }

    /// 清理缓存
    #[allow(dead_code)]
    fn clear(&mut self) {
        self.cache.clear();
        self.access_order.clear();
    }
}

/// 将路径字符串转换为宽字符
fn to_wide_string(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 从文件中提取图标并转换为 Base64 PNG
///
/// # 内存安全
/// - 所有 GDI 资源在函数结束前都会被正确释放
/// - 使用 RAII 风格的清理
pub fn extract_file_icon(file_path: &str) -> Option<String> {
    // 检查缓存
    {
        let mut cache = ICON_CACHE.lock().ok()?;
        if let Some(cached) = cache.get(file_path) {
            return cached;
        }
    }

    // 提取图标
    let icon_data = extract_icon_internal(file_path);

    // 存入缓存
    {
        if let Ok(mut cache) = ICON_CACHE.lock() {
            cache.insert(file_path.to_string(), icon_data.clone());
        }
    }

    icon_data
}

/// 内部图标提取实现
fn extract_icon_internal(file_path: &str) -> Option<String> {
    // 检查文件是否存在
    if !Path::new(file_path).exists() {
        return None;
    }

    let wide_path = to_wide_string(file_path);
    // SHGFI_LARGEICON usually returns only 32px. Prefer the Shell image factory
    // so a 56px tile remains sharp at 125%, 150%, and 200% display scaling.
    if let Some(icon) = high_resolution_icon(&wide_path) {
        return Some(icon);
    }
    let mut shfi = SHFILEINFOW::default();

    // 获取文件图标
    let result = unsafe {
        SHGetFileInfoW(
            windows::core::PCWSTR(wide_path.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };

    if result == 0 || shfi.hIcon.is_invalid() {
        return None;
    }

    // 使用 RAII 确保资源释放
    let _icon_guard = IconGuard(shfi.hIcon);

    // 转换 HICON 为 PNG Base64
    hicon_to_base64(shfi.hIcon)
}

fn high_resolution_icon(path: &[u16]) -> Option<String> {
    use windows::Win32::{
        Foundation::SIZE,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
    };
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if initialized.is_err() && initialized.0 != 0x80010106u32 as i32 {
        return None;
    }
    let _com = ComGuard(initialized.is_ok());
    let factory: IShellItemImageFactory =
        unsafe { SHCreateItemFromParsingName(windows::core::PCWSTR(path.as_ptr()), None) }.ok()?;
    let bitmap = unsafe {
        factory.GetImage(
            SIZE { cx: 128, cy: 128 },
            SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
        )
    }
    .ok()?;
    let _bitmap = GdiObjGuard(windows::Win32::Graphics::Gdi::HGDIOBJ(bitmap.0));
    hbitmap_to_base64(bitmap)
}

/// RAII 守卫 - 确保 HICON 被释放
struct IconGuard(windows::Win32::UI::WindowsAndMessaging::HICON);

impl Drop for IconGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DestroyIcon(self.0);
            }
        }
    }
}

/// RAII 守卫 - 确保 HDC 被释放
struct DcGuard(windows::Win32::Graphics::Gdi::HDC);

impl Drop for DcGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }
}

/// RAII 守卫 - 确保 HGDIOBJ 被释放
struct GdiObjGuard(windows::Win32::Graphics::Gdi::HGDIOBJ);

impl Drop for GdiObjGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DeleteObject(self.0);
            }
        }
    }
}

/// 将 HICON 转换为 Base64 PNG
fn hicon_to_base64(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<String> {
    // 获取图标信息
    let mut icon_info = ICONINFO::default();
    let success = unsafe { GetIconInfo(hicon, &mut icon_info) };

    if success.is_err() {
        return None;
    }

    // 确保位图被释放
    let _mask_guard = if !icon_info.hbmMask.is_invalid() {
        Some(GdiObjGuard(windows::Win32::Graphics::Gdi::HGDIOBJ(
            icon_info.hbmMask.0,
        )))
    } else {
        None
    };
    let _color_guard = if !icon_info.hbmColor.is_invalid() {
        Some(GdiObjGuard(windows::Win32::Graphics::Gdi::HGDIOBJ(
            icon_info.hbmColor.0,
        )))
    } else {
        None
    };

    // 如果没有颜色位图，使用掩码位图
    let hbitmap = if !icon_info.hbmColor.is_invalid() {
        icon_info.hbmColor
    } else {
        icon_info.hbmMask
    };

    if hbitmap.is_invalid() {
        return None;
    }

    hbitmap_to_base64(hbitmap)
}

fn hbitmap_to_base64(hbitmap: HBITMAP) -> Option<String> {
    // 获取位图的实际尺寸
    let mut bitmap = BITMAP::default();
    let obj_size = unsafe {
        GetObjectW(
            hbitmap,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut _ as *mut _),
        )
    };

    if obj_size == 0 {
        return None;
    }

    let width = bitmap.bmWidth;
    let height = bitmap.bmHeight.abs(); // 确保高度为正

    if width <= 0 || height <= 0 || width > 1024 || height > 1024 {
        return None;
    }

    // 创建兼容 DC
    let hdc = unsafe { CreateCompatibleDC(None) };
    if hdc.is_invalid() {
        return None;
    }
    let _dc_guard = DcGuard(hdc);

    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // 负值表示从上到下
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default()],
    };

    // 分配像素缓冲区
    let mut pixels: Vec<u8> = vec![0u8; (width * height * 4) as usize];

    // 获取位图数据
    let lines = unsafe {
        GetDIBits(
            hdc,
            hbitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };

    if lines == 0 {
        return None;
    }

    // BGRA -> RGBA 转换
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2); // 交换 B 和 R
                          // Shell bitmaps use premultiplied BGRA; PNG expects straight RGBA.
        let alpha = u16::from(chunk[3]);
        if alpha > 0 && alpha < 255 {
            for channel in &mut chunk[..3] {
                *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }

    // 创建图像
    let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width as u32, height as u32, pixels)?;
    // Some legacy providers center a 32px icon in a 128/256px transparent
    // canvas. Do not turn that padding into a tiny icon inside the UI tile.
    let mut bounds = (img.width(), img.height(), 0, 0);
    let mut found = false;
    for (x, y, pixel) in img.enumerate_pixels() {
        if pixel[3] <= 16 {
            continue;
        }
        found = true;
        bounds.0 = bounds.0.min(x);
        bounds.1 = bounds.1.min(y);
        bounds.2 = bounds.2.max(x);
        bounds.3 = bounds.3.max(y);
    }
    if found
        && (bounds.2 - bounds.0 + 1) * 2 < img.width()
        && (bounds.3 - bounds.1 + 1) * 2 < img.height()
    {
        let left = bounds.0.saturating_sub(2);
        let top = bounds.1.saturating_sub(2);
        let right = (bounds.2 + 3).min(img.width());
        let bottom = (bounds.3 + 3).min(img.height());
        img = image::imageops::crop_imm(&img, left, top, right - left, bottom - top).to_image();
    }

    // 编码为 PNG
    let mut png_data = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_data);

    if img.write_to(&mut cursor, image::ImageFormat::Png).is_err() {
        return None;
    }

    // 转换为 Base64
    let base64_str = base64::engine::general_purpose::STANDARD.encode(&png_data);
    Some(format!("data:image/png;base64,{}", base64_str))
}

/// 清理图标缓存（可在需要时调用）
#[allow(dead_code)]
pub fn clear_icon_cache() {
    if let Ok(mut cache) = ICON_CACHE.lock() {
        cache.clear();
    }
}

/// 获取缓存状态
#[allow(dead_code)]
pub fn get_cache_stats() -> (usize, usize) {
    if let Ok(cache) = ICON_CACHE.lock() {
        (cache.cache.len(), cache.max_size)
    } else {
        (0, MAX_CACHE_SIZE)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn shell_icon_factory_keeps_high_resolution_pixels() {
        use base64::Engine;
        let path =
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("explorer.exe");
        let icon =
            super::extract_file_icon(&path.to_string_lossy()).expect("Explorer has a system icon");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(icon.split_once(',').unwrap().1)
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert!(
            image.width() >= 128 && image.height() >= 128,
            "{}x{}",
            image.width(),
            image.height()
        );
    }
}
