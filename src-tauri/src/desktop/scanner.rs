// 桌面扫描器
// Desktop Scanner - 扫描桌面文件并分类

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

const FOLDER_BROWSE_LIMIT: usize = 200;
const SEARCH_RESULT_LIMIT: usize = 200;

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
    pub children_truncated: bool,           // 文件夹预览是否已截断
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

/// 按需读取的文件夹一级内容
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderContents {
    pub path: String,
    pub name: String,
    pub items: Vec<DesktopFile>,
    pub total_count: usize,
    pub truncated: bool,
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
fn scan_file_info(path: &PathBuf) -> Option<DesktopFile> {
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
        children: None,
        children_truncated: false,
        icon,
    })
}

/// 按需扫描指定文件夹的一级内容，不递归、不跟随符号链接。
pub fn scan_folder_contents(folder_path: &PathBuf) -> Result<FolderContents, String> {
    if !folder_path.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    let entries = fs::read_dir(folder_path).map_err(|error| format!("读取文件夹失败: {error}"))?;
    let mut items = Vec::with_capacity(FOLDER_BROWSE_LIMIT);
    let mut total_count = 0usize;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name() {
            Some(name) => name.to_string_lossy(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }

        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }

        total_count += 1;
        if items.len() < FOLDER_BROWSE_LIMIT {
            if let Some(file) = scan_file_info(&path) {
                items.push(file);
            }
        }
    }

    items.sort_by(|left, right| {
        right
            .is_folder
            .cmp(&left.is_folder)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let name = folder_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "文件夹".to_string());

    Ok(FolderContents {
        path: folder_path.to_string_lossy().to_string(),
        name,
        truncated: total_count > items.len(),
        total_count,
        items,
    })
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
        if let Some(file) = scan_file_info(&path) {
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
        if let Some(file) = scan_file_info(&path) {
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
            if results.len() >= SEARCH_RESULT_LIMIT {
                break;
            }
        }
    }

    // 按名称排序
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::{scan_folder_contents, FOLDER_BROWSE_LIMIT};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_directory() -> TestDirectory {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be available")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("dtkit-folder-scan-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).expect("test directory should be created");
        TestDirectory(path)
    }

    #[test]
    fn folder_scan_is_single_level_sorted_and_bounded() {
        let root = test_directory();
        let nested = root.0.join("A-folder");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("not-eagerly-scanned.txt"), b"nested").unwrap();
        fs::write(root.0.join("z-note.txt"), b"note").unwrap();

        let initial = scan_folder_contents(&root.0).unwrap();
        assert_eq!(initial.total_count, 2);
        assert!(initial.items[0].is_folder);
        assert!(initial.items.iter().all(|item| item.children.is_none()));

        for index in 0..=FOLDER_BROWSE_LIMIT {
            fs::write(root.0.join(format!("item-{index:03}.txt")), b"bounded").unwrap();
        }
        fs::write(root.0.join(".hidden.txt"), b"hidden").unwrap();

        let bounded = scan_folder_contents(&root.0).unwrap();
        assert_eq!(bounded.total_count, FOLDER_BROWSE_LIMIT + 3);
        assert_eq!(bounded.items.len(), FOLDER_BROWSE_LIMIT);
        assert!(bounded.truncated);
        assert!(bounded.items.iter().all(|item| item.children.is_none()));
    }
}
