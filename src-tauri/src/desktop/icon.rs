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
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
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
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
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

/// RAII 守卫 - 确保 HICON 被释放
struct IconGuard(windows::Win32::UI::WindowsAndMessaging::HICON);

impl Drop for IconGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe { let _ = DestroyIcon(self.0); }
        }
    }
}

/// RAII 守卫 - 确保 HDC 被释放
struct DcGuard(windows::Win32::Graphics::Gdi::HDC);

impl Drop for DcGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe { let _ = DeleteDC(self.0); }
        }
    }
}

/// RAII 守卫 - 确保 HGDIOBJ 被释放
struct GdiObjGuard(windows::Win32::Graphics::Gdi::HGDIOBJ);

impl Drop for GdiObjGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe { let _ = DeleteObject(self.0); }
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
        Some(GdiObjGuard(windows::Win32::Graphics::Gdi::HGDIOBJ(icon_info.hbmMask.0)))
    } else {
        None
    };
    let _color_guard = if !icon_info.hbmColor.is_invalid() {
        Some(GdiObjGuard(windows::Win32::Graphics::Gdi::HGDIOBJ(icon_info.hbmColor.0)))
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

    // 创建兼容 DC
    let hdc = unsafe { CreateCompatibleDC(None) };
    if hdc.is_invalid() {
        return None;
    }
    let _dc_guard = DcGuard(hdc);

    // 选择位图到 DC
    let old_bitmap = unsafe { SelectObject(hdc, hbitmap) };

    // 设置位图信息头 - 使用 32x32 固定大小
    let width = 32i32;
    let height = 32i32;

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

    // 恢复旧位图
    unsafe { SelectObject(hdc, old_bitmap) };

    if lines == 0 {
        return None;
    }

    // BGRA -> RGBA 转换
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2); // 交换 B 和 R
    }

    // 创建图像
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> = 
        ImageBuffer::from_raw(width as u32, height as u32, pixels)?;

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

/// 批量提取图标（用于初始加载）
/// 限制并发数量避免内存峰值
pub fn extract_icons_batch(file_paths: &[String]) -> HashMap<String, Option<String>> {
    let mut results = HashMap::new();
    
    for path in file_paths {
        let icon = extract_file_icon(path);
        results.insert(path.clone(), icon);
    }
    
    results
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
