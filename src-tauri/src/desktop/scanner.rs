// 桌面扫描器
// Desktop Scanner - 扫描桌面文件并分类

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

/// 文件分类类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FileCategory {
    Document, // 文档
    Image,    // 图片
    Video,    // 视频
    Audio,    // 音频
    Archive,  // 压缩包
    Program,  // 程序
    Folder,   // 文件夹
    Other,    // 其他
}

impl FileCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            FileCategory::Document => "document",
            FileCategory::Image => "image",
            FileCategory::Video => "video",
            FileCategory::Audio => "audio",
            FileCategory::Archive => "archive",
            FileCategory::Program => "program",
            FileCategory::Folder => "folder",
            FileCategory::Other => "other",
        }
    }

    pub fn from_extension(ext: &str, is_dir: bool) -> Self {
        if is_dir {
            return FileCategory::Folder;
        }

        let ext = ext.to_lowercase();
        match ext.as_str() {
            // 文档
            "doc" | "docx" | "pdf" | "txt" | "md" | "rtf" | "xls" | "xlsx" | "ppt" | "pptx"
            | "odt" | "ods" | "odp" | "csv" | "json" | "xml" | "html" | "htm" => {
                FileCategory::Document
            }

            // 图片
            "jpg" | "jpeg" | "png" | "gif" | "bmp" | "svg" | "webp" | "ico" | "tiff" | "tif"
            | "psd" | "raw" | "heic" | "heif" => FileCategory::Image,

            // 视频
            "mp4" | "avi" | "mkv" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpeg" | "mpg"
            | "3gp" | "ts" => FileCategory::Video,

            // 音频
            "mp3" | "wav" | "flac" | "aac" | "ogg" | "wma" | "m4a" | "ape" | "alac" | "aiff" => {
                FileCategory::Audio
            }

            // 压缩包
            "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "dmg" | "cab" => {
                FileCategory::Archive
            }

            // 程序
            "exe" | "msi" | "bat" | "cmd" | "ps1" | "sh" | "app" | "deb" | "rpm" | "lnk" => {
                FileCategory::Program
            }

            // 其他
            _ => FileCategory::Other,
        }
    }
}

/// 桌面文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopFile {
    pub name: String,                       // 文件名
    pub path: String,                       // 完整路径
    pub category: String,                   // 分类
    pub is_folder: bool,                    // 是否是文件夹
    pub size: u64,                          // 文件大小（字节）
    pub extension: String,                  // 扩展名
    pub modified_time: u64,                 // 修改时间（时间戳）
    pub accessed_time: u64,                 // 访问时间（时间戳）
    pub children: Option<Vec<DesktopFile>>, // 子文件（仅文件夹有，一级）
    pub icon: Option<String>,               // 文件图标（Base64 PNG）
}

/// 分类后的桌面文件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategorizedFiles {
    pub recent: Vec<DesktopFile>,    // 最近使用（最多7个）
    pub documents: Vec<DesktopFile>, // 文档
    pub images: Vec<DesktopFile>,    // 图片
    pub videos: Vec<DesktopFile>,    // 视频
    pub audios: Vec<DesktopFile>,    // 音频
    pub archives: Vec<DesktopFile>,  // 压缩包
    pub programs: Vec<DesktopFile>,  // 程序
    pub folders: Vec<DesktopFile>,   // 文件夹
    pub others: Vec<DesktopFile>,    // 其他
    pub total_count: usize,          // 总数
}

/// 获取桌面路径
pub fn get_desktop_path() -> Option<PathBuf> {
    dirs::desktop_dir()
}

/// 获取时间戳
fn get_timestamp(time: std::io::Result<SystemTime>) -> u64 {
    time.ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 扫描单个文件/文件夹信息
fn scan_file_info(path: &PathBuf, include_children: bool) -> Option<DesktopFile> {
    let metadata = fs::metadata(path).ok()?;
    let name = path.file_name()?.to_string_lossy().to_string();
    let is_folder = metadata.is_dir();

    // 跳过隐藏文件（以.开头的文件）
    if name.starts_with('.') {
        return None;
    }

    let extension = if is_folder {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    };

    let category = FileCategory::from_extension(&extension, is_folder);

    // 获取子文件（仅一级）
    let children = if is_folder && include_children {
        scan_folder_children(path)
    } else {
        None
    };

    // 提取文件图标（仅对程序和快捷方式）
    let icon = if category == FileCategory::Program || extension == "lnk" {
        #[cfg(windows)]
        {
            crate::desktop::icon::extract_file_icon(&path.to_string_lossy())
        }
        #[cfg(not(windows))]
        {
            None
        }
    } else {
        None
    };

    Some(DesktopFile {
        name,
        path: path.to_string_lossy().to_string(),
        category: category.as_str().to_string(),
        is_folder,
        size: if is_folder { 0 } else { metadata.len() },
        extension,
        modified_time: get_timestamp(metadata.modified()),
        accessed_time: get_timestamp(metadata.accessed()),
        children,
        icon,
    })
}

/// 扫描文件夹的一级子内容
fn scan_folder_children(folder_path: &PathBuf) -> Option<Vec<DesktopFile>> {
    let entries = fs::read_dir(folder_path).ok()?;
    let mut children = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(file) = scan_file_info(&path, false) {
            children.push(file);
        }
    }

    // 按名称排序
    children.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Some(children)
}

/// 扫描桌面所有文件
pub fn scan_desktop() -> Result<CategorizedFiles, String> {
    let desktop_path = get_desktop_path().ok_or_else(|| "无法获取桌面路径".to_string())?;

    if !desktop_path.exists() {
        return Err("桌面路径不存在".to_string());
    }

    let entries = fs::read_dir(&desktop_path).map_err(|e| format!("读取桌面目录失败: {}", e))?;

    let mut all_files: Vec<DesktopFile> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(file) = scan_file_info(&path, true) {
            all_files.push(file);
        }
    }

    // 分类
    let mut documents = Vec::new();
    let mut images = Vec::new();
    let mut videos = Vec::new();
    let mut audios = Vec::new();
    let mut archives = Vec::new();
    let mut programs = Vec::new();
    let mut folders = Vec::new();
    let mut others = Vec::new();

    for file in &all_files {
        match file.category.as_str() {
            "document" => documents.push(file.clone()),
            "image" => images.push(file.clone()),
            "video" => videos.push(file.clone()),
            "audio" => audios.push(file.clone()),
            "archive" => archives.push(file.clone()),
            "program" => programs.push(file.clone()),
            "folder" => folders.push(file.clone()),
            _ => others.push(file.clone()),
        }
    }

    // 最近使用（按访问时间排序，取前7个）
    let mut recent = all_files.clone();
    recent.sort_by(|a, b| b.accessed_time.cmp(&a.accessed_time));
    recent.truncate(7);

    let total_count = all_files.len();

    Ok(CategorizedFiles {
        recent,
        documents,
        images,
        videos,
        audios,
        archives,
        programs,
        folders,
        others,
        total_count,
    })
}

/// 搜索桌面文件
pub fn search_desktop_files(
    query: &str,
    category_filter: Option<&str>,
) -> Result<Vec<DesktopFile>, String> {
    let desktop_path = get_desktop_path().ok_or_else(|| "无法获取桌面路径".to_string())?;

    let entries = fs::read_dir(&desktop_path).map_err(|e| format!("读取桌面目录失败: {}", e))?;

    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(file) = scan_file_info(&path, false) {
            // 名称匹配
            if !file.name.to_lowercase().contains(&query_lower) {
                continue;
            }

            // 分类过滤
            if let Some(cat) = category_filter {
                if file.category != cat {
                    continue;
                }
            }

            results.push(file);
        }
    }

    // 按名称排序
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(results)
}
