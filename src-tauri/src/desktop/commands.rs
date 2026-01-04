// 桌面整理 Tauri 命令
// Desktop Organizer Commands

use crate::desktop::scanner::{scan_desktop, search_desktop_files, CategorizedFiles, DesktopFile};
use std::process::Command;

/// 扫描桌面文件
#[tauri::command]
pub fn desktop_scan() -> Result<CategorizedFiles, String> {
    scan_desktop()
}

/// 搜索桌面文件
/// category_filter: 可选的分类过滤，如 "document", "image" 等
#[tauri::command]
pub fn desktop_search(query: String, category_filter: Option<String>) -> Result<Vec<DesktopFile>, String> {
    search_desktop_files(&query, category_filter.as_deref())
}

/// 打开文件
#[tauri::command]
pub fn desktop_open_file(path: String) -> Result<(), String> {
    opener::open(&path).map_err(|e| format!("打开文件失败: {}", e))
}

/// 在资源管理器中定位文件
#[tauri::command]
pub fn desktop_locate_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("定位文件失败: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("定位文件失败: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new(&path)))
            .spawn()
            .map_err(|e| format!("定位文件失败: {}", e))?;
    }
    
    Ok(())
}

/// 重命名文件
#[tauri::command]
pub fn desktop_rename_file(old_path: String, new_name: String) -> Result<String, String> {
    let path = std::path::Path::new(&old_path);
    let parent = path.parent().ok_or("无法获取父目录")?;
    let new_path = parent.join(&new_name);
    
    if new_path.exists() {
        return Err("目标文件已存在".to_string());
    }
    
    std::fs::rename(&old_path, &new_path)
        .map_err(|e| format!("重命名失败: {}", e))?;
    
    Ok(new_path.to_string_lossy().to_string())
}

/// 复制文件路径到剪贴板（通过前端实现）
/// 这里返回路径供前端处理
#[tauri::command]
pub fn desktop_get_file_path(path: String) -> Result<String, String> {
    Ok(path)
}

/// 获取桌面路径
#[tauri::command]
pub fn desktop_get_path() -> Result<String, String> {
    crate::desktop::scanner::get_desktop_path()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取桌面路径".to_string())
}

/// 获取屏幕边界信息
#[tauri::command]
pub fn get_screen_bounds() -> Result<ScreenBounds, String> {
    use crate::desktop::hotzone::{get_primary_screen_size, get_screen_size};
    
    let (width, height) = get_primary_screen_size();
    let (virtual_width, virtual_height) = get_screen_size();
    
    Ok(ScreenBounds {
        width,
        height,
        virtual_width,
        virtual_height,
    })
}

/// 设置用户交互状态（拖动/调整大小时）
#[tauri::command]
pub fn set_user_interacting(interacting: bool) -> Result<(), String> {
    use crate::desktop::hotzone::set_user_interacting;
    set_user_interacting(interacting);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ScreenBounds {
    pub width: i32,
    pub height: i32,
    pub virtual_width: i32,
    pub virtual_height: i32,
}
