// 桌面整理 Tauri 命令
// Desktop Organizer Commands

use crate::desktop::scanner::{
    scan_desktop, scan_folder_contents, search_desktop_files, CategorizedFiles, DesktopFile,
    FolderContents,
};
use crate::desktop::apps::{
    known_app_path, list_desktop_apps, reset_desktop_app, save_desktop_app, DesktopApp,
    SaveDesktopAppRequest,
};
use crate::infrastructure::storage::StorageManager;
use crate::path_safety::validate_leaf_filename;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

fn validated_desktop_entry(path: &str) -> Result<PathBuf, String> {
    let desktop = crate::desktop::scanner::get_desktop_path()
        .ok_or_else(|| "无法获取桌面路径".to_string())?
        .canonicalize()
        .map_err(|error| format!("无法验证桌面路径: {error}"))?;
    let candidate = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("文件不存在或无法访问: {error}"))?;
    if !is_descendant(&desktop, &candidate) {
        return Err("只允许操作桌面目录内的项目".to_string());
    }
    Ok(candidate)
}

fn is_descendant(root: &Path, candidate: &Path) -> bool {
    candidate != root && candidate.starts_with(root)
}

fn normalized_app_name(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    for suffix in [".exe", ".lnk", ".url"] {
        if let Some(name) = normalized.strip_suffix(suffix) { return name.trim().to_string(); }
    }
    normalized
}

/// 扫描桌面文件
#[tauri::command]
pub async fn desktop_scan(storage: tauri::State<'_, StorageManager>) -> Result<CategorizedFiles, String> {
    let mut files = tauri::async_runtime::spawn_blocking(scan_desktop)
        .await
        .map_err(|error| format!("桌面扫描任务异常结束: {error}"))??;
    let existing_names = files.programs.iter()
        .map(|file| normalized_app_name(&file.name))
        .collect::<std::collections::HashSet<_>>();
    for app in list_desktop_apps(&storage, false, false)? {
        if !app.manual && existing_names.contains(&normalized_app_name(&app.name)) { continue; }
        let extension = Path::new(&app.path).extension().and_then(|value| value.to_str()).unwrap_or_default().to_lowercase();
        files.applications.push(DesktopFile {
            name: app.name,
            path: app.path,
            category: "program".to_string(),
            is_folder: false,
            size: 0,
            extension,
            modified_time: 0,
            accessed_time: 0,
            children: None,
            children_truncated: false,
            icon: app.icon,
            app_id: Some(app.id),
            app_category: Some(app.category),
            app_manual: app.manual,
        });
    }
    files.applications.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(files)
}

#[tauri::command]
pub fn desktop_list_apps(storage: tauri::State<'_, StorageManager>, include_hidden: Option<bool>, refresh: Option<bool>) -> Result<Vec<DesktopApp>, String> {
    list_desktop_apps(&storage, include_hidden.unwrap_or(true), refresh.unwrap_or(false))
}

#[tauri::command]
pub fn desktop_save_app(storage: tauri::State<'_, StorageManager>, request: SaveDesktopAppRequest) -> Result<(), String> {
    save_desktop_app(&storage, request)
}

#[tauri::command]
pub fn desktop_reset_app(storage: tauri::State<'_, StorageManager>, path: String) -> Result<(), String> {
    reset_desktop_app(&storage, &path)
}

fn validated_known_app(storage: &StorageManager, path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if !candidate.is_file() { return Err("应用不存在或无法访问".to_string()); }
    if !known_app_path(storage, &candidate) { return Err("应用不在桌面整理的受管索引中".to_string()); }
    Ok(candidate)
}

#[tauri::command]
pub fn desktop_open_app(storage: tauri::State<'_, StorageManager>, path: String) -> Result<(), String> {
    let path = validated_known_app(&storage, &path)?;
    opener::open(path).map_err(|error| format!("打开应用失败: {error}"))
}

#[tauri::command]
pub fn desktop_locate_app(storage: tauri::State<'_, StorageManager>, path: String) -> Result<(), String> {
    let path = validated_known_app(&storage, &path)?;
    Command::new("explorer").args(["/select,", &path.to_string_lossy()]).spawn().map_err(|error| format!("定位应用失败: {error}"))?;
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn desktop_get_app_icon(storage: tauri::State<'_, StorageManager>, path: String) -> Result<Option<String>, String> {
    let path = validated_known_app(&storage, &path)?;
    Ok(crate::desktop::icon::extract_file_icon(&path.to_string_lossy()))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn desktop_get_app_icon(_storage: tauri::State<'_, StorageManager>, _path: String) -> Result<Option<String>, String> { Ok(None) }

/// 搜索桌面文件
/// category_filter: 可选的分类过滤，如 "document", "image" 等
#[tauri::command]
pub async fn desktop_search(
    query: String,
    category_filter: Option<String>,
) -> Result<Vec<DesktopFile>, String> {
    if query.chars().count() > 128 {
        return Err("搜索内容不能超过 128 个字符".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        search_desktop_files(&query, category_filter.as_deref())
    })
    .await
    .map_err(|error| format!("桌面搜索任务异常结束: {error}"))?
}

/// 按需读取桌面内某个文件夹的一级内容。
#[tauri::command]
pub async fn desktop_list_folder(path: String) -> Result<FolderContents, String> {
    let path = validated_desktop_entry(&path)?;
    if !path.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || scan_folder_contents(&path))
        .await
        .map_err(|error| format!("文件夹扫描任务异常结束: {error}"))?
}

/// 获取单个文件的图标
#[cfg(windows)]
#[tauri::command]
pub fn desktop_get_icon(path: String) -> Result<Option<String>, String> {
    let path = validated_desktop_entry(&path)?;
    Ok(crate::desktop::icon::extract_file_icon(
        &path.to_string_lossy(),
    ))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn desktop_get_icon(_path: String) -> Result<Option<String>, String> {
    Ok(None)
}

/// 打开文件
#[tauri::command]
pub fn desktop_open_file(path: String) -> Result<(), String> {
    let path = validated_desktop_entry(&path)?;
    opener::open(path).map_err(|e| format!("打开文件失败: {}", e))
}

/// 在资源管理器中定位文件
#[tauri::command]
pub fn desktop_locate_file(path: String) -> Result<(), String> {
    let path = validated_desktop_entry(&path)?;
    let path = path.to_string_lossy().to_string();
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
            .arg(
                std::path::Path::new(&path)
                    .parent()
                    .unwrap_or(std::path::Path::new(&path)),
            )
            .spawn()
            .map_err(|e| format!("定位文件失败: {}", e))?;
    }

    Ok(())
}

/// 重命名文件
#[tauri::command]
pub fn desktop_rename_file(old_path: String, new_name: String) -> Result<String, String> {
    validate_leaf_filename(&new_name)?;
    let validated_path = validated_desktop_entry(&old_path)?;
    let path = validated_path.as_path();
    let parent = path.parent().ok_or("无法获取父目录")?;
    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err("目标文件已存在".to_string());
    }

    std::fs::rename(path, &new_path).map_err(|e| format!("重命名失败: {}", e))?;

    Ok(new_path.to_string_lossy().to_string())
}

/// 复制文件路径到剪贴板（通过前端实现）
/// 这里返回路径供前端处理
#[tauri::command]
pub fn desktop_get_file_path(path: String) -> Result<String, String> {
    validated_desktop_entry(&path).map(|path| path.to_string_lossy().to_string())
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
pub fn get_screen_bounds(app: tauri::AppHandle) -> Result<ScreenBounds, String> {
    use crate::desktop::hotzone::{get_primary_screen_size, get_screen_size};

    let fallback_size = get_primary_screen_size();
    let monitor = app
        .get_webview_window("desktop-organizer")
        .and_then(|window| {
            window
                .current_monitor()
                .ok()
                .flatten()
                .or_else(|| window.primary_monitor().ok().flatten())
        });
    let (x, y, width, height) =
        monitor.map_or((0, 0, fallback_size.0, fallback_size.1), |monitor| {
            (
                monitor.position().x,
                monitor.position().y,
                monitor.size().width as i32,
                monitor.size().height as i32,
            )
        });
    let (virtual_width, virtual_height) = get_screen_size();

    Ok(ScreenBounds {
        x,
        y,
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
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub virtual_width: i32,
    pub virtual_height: i32,
}

#[cfg(test)]
mod tests {
    use super::is_descendant;
    use std::path::Path;

    #[test]
    fn desktop_boundary_rejects_root_and_sibling_prefixes() {
        let root = Path::new(r"C:\Users\demo\Desktop");
        assert!(is_descendant(
            root,
            Path::new(r"C:\Users\demo\Desktop\notes.txt")
        ));
        assert!(!is_descendant(root, root));
        assert!(!is_descendant(
            root,
            Path::new(r"C:\Users\demo\Desktop-old\notes.txt")
        ));
    }
}
