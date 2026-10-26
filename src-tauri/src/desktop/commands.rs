// 桌面整理 Tauri 命令
// Desktop Organizer Commands

use crate::desktop::apps::{
    known_app_path, list_desktop_apps, reset_desktop_app, save_desktop_app,
    set_desktop_app_category, DesktopApp, SaveDesktopAppRequest,
};
use crate::desktop::scanner::{
    scan_desktop, scan_folder_contents, search_desktop_files, CategorizedFiles, DesktopFile,
    FolderContents,
};
use crate::infrastructure::storage::StorageManager;
use crate::path_safety::validate_leaf_filename;
use base64::Engine;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Manager};

fn validated_desktop_entry(path: &str) -> Result<PathBuf, String> {
    let desktop = crate::desktop::scanner::get_desktop_path()
        .ok_or_else(|| "无法获取桌面路径".to_string())?;
    validated_entry_in_root(&desktop, Path::new(path))
}

fn validated_entry_in_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let desktop = root
        .canonicalize()
        .map_err(|error| format!("无法验证桌面路径: {error}"))?;
    let candidate = path
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

/// 扫描桌面文件
#[tauri::command]
pub async fn desktop_scan(
    storage: tauri::State<'_, StorageManager>,
) -> Result<CategorizedFiles, String> {
    let mut files = tauri::async_runtime::spawn_blocking(scan_desktop)
        .await
        .map_err(|error| format!("桌面扫描任务异常结束: {error}"))??;
    for app in list_desktop_apps(&storage, false, false)? {
        let extension = Path::new(&app.path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase();
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
    files
        .applications
        .sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(files)
}

#[tauri::command]
pub fn desktop_list_apps(
    storage: tauri::State<'_, StorageManager>,
    include_hidden: Option<bool>,
    refresh: Option<bool>,
) -> Result<Vec<DesktopApp>, String> {
    list_desktop_apps(
        &storage,
        include_hidden.unwrap_or(true),
        refresh.unwrap_or(false),
    )
}

#[tauri::command]
pub fn desktop_save_app(
    app: tauri::AppHandle,
    storage: tauri::State<'_, StorageManager>,
    request: SaveDesktopAppRequest,
) -> Result<(), String> {
    save_desktop_app(&storage, request)?;
    let _ = app.emit("desktop-app-index-changed", ());
    Ok(())
}

#[tauri::command]
pub fn desktop_reset_app(
    app: tauri::AppHandle,
    storage: tauri::State<'_, StorageManager>,
    path: String,
) -> Result<(), String> {
    reset_desktop_app(&storage, &path)?;
    let _ = app.emit("desktop-app-index-changed", ());
    Ok(())
}

#[tauri::command]
pub fn desktop_set_app_category(
    app: tauri::AppHandle,
    storage: tauri::State<'_, StorageManager>,
    path: String,
    category: String,
) -> Result<(), String> {
    set_desktop_app_category(&storage, &path, &category)?;
    let _ = app.emit("desktop-app-index-changed", ());
    Ok(())
}

fn validated_known_app(storage: &StorageManager, path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if !candidate.is_file() {
        return Err("应用不存在或无法访问".to_string());
    }
    if !known_app_path(storage, &candidate) {
        return Err("应用不在桌面整理的受管索引中".to_string());
    }
    Ok(candidate)
}

#[tauri::command]
pub fn desktop_open_app(
    storage: tauri::State<'_, StorageManager>,
    path: String,
) -> Result<(), String> {
    let path = validated_known_app(&storage, &path)?;
    opener::open(path).map_err(|error| format!("打开应用失败: {error}"))
}

#[tauri::command]
pub fn desktop_locate_app(
    storage: tauri::State<'_, StorageManager>,
    path: String,
) -> Result<(), String> {
    let path = validated_known_app(&storage, &path)?;
    Command::new("explorer")
        .args(["/select,", &path.to_string_lossy()])
        .spawn()
        .map_err(|error| format!("定位应用失败: {error}"))?;
    Ok(())
}

#[cfg(windows)]
fn extract_icon_on_worker(path: &Path) -> Result<Option<String>, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    // Blocking workers do not inherit the WebView UI thread's COM apartment.
    // Shell icon handlers require one, especially for shortcuts.
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if initialized.is_err() && initialized.0 != 0x80010106u32 as i32 {
        return Err(format!("图标服务初始化失败: {initialized:?}"));
    }
    let _guard = ComGuard(initialized.is_ok());
    Ok(crate::desktop::icon::extract_file_icon(
        &path.to_string_lossy(),
    ))
}

#[cfg(windows)]
#[tauri::command]
pub async fn desktop_get_app_icon(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<StorageManager>();
        let path = validated_known_app(&storage, &path)?;
        extract_icon_on_worker(&path)
    })
    .await
    .map_err(|error| format!("应用图标读取任务异常结束: {error}"))?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn desktop_get_app_icon(
    _app: tauri::AppHandle,
    _path: String,
) -> Result<Option<String>, String> {
    Ok(None)
}

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
pub async fn desktop_get_icon(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validated_desktop_entry(&path)?;
        extract_icon_on_worker(&path)
    })
    .await
    .map_err(|error| format!("文件图标读取任务异常结束: {error}"))?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn desktop_get_icon(_path: String) -> Result<Option<String>, String> {
    Ok(None)
}

/// 打开文件
#[tauri::command]
pub fn desktop_open_file(path: String) -> Result<(), String> {
    let path = validated_desktop_entry(&path)?;
    opener::open(path).map_err(|e| format!("打开文件失败: {}", e))
}

const TEXT_PREVIEW_LIMIT: u64 = 512 * 1024;
const MEDIA_PREVIEW_LIMIT: u64 = 12 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreview {
    kind: &'static str,
    name: String,
    path: String,
    extension: String,
    size: u64,
    modified_time: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn preview_kind(extension: &str) -> (&'static str, Option<&'static str>) {
    match extension {
        "txt" | "md" | "markdown" | "log" | "json" | "csv" | "tsv" | "toml" | "yaml" | "yml"
        | "xml" | "html" | "htm" | "css" | "js" | "mjs" | "ts" | "tsx" | "jsx" | "rs" | "py"
        | "c" | "h" | "cpp" | "hpp" | "cs" | "java" | "sql" | "ini" | "conf" | "bat" | "ps1"
        | "sh" | "gitignore" => ("text", None),
        "png" => ("image", Some("image/png")),
        "jpg" | "jpeg" => ("image", Some("image/jpeg")),
        "gif" => ("image", Some("image/gif")),
        "webp" => ("image", Some("image/webp")),
        "bmp" => ("image", Some("image/bmp")),
        "ico" => ("image", Some("image/x-icon")),
        "pdf" => ("pdf", Some("application/pdf")),
        _ => ("metadata", None),
    }
}

fn read_desktop_preview(path: &Path) -> Result<DesktopPreview, String> {
    let entry_metadata =
        std::fs::metadata(path).map_err(|error| format!("无法读取文件信息: {error}"))?;
    if !entry_metadata.is_file() {
        return Err("快速预览只支持文件，请打开文件夹查看内容".into());
    }
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("无法读取预览文件: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取文件信息: {error}"))?;
    if !metadata.is_file() {
        return Err("快速预览只支持文件，请打开文件夹查看内容".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let (kind, mime) = preview_kind(&extension);
    let mut preview = DesktopPreview {
        kind,
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        extension,
        size: metadata.len(),
        modified_time: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
        text: None,
        data_url: None,
        message: None,
    };
    if kind == "metadata" {
        preview.message = Some("此格式暂不支持内容预览，可用默认应用打开".into());
        return Ok(preview);
    }
    let limit = if kind == "text" {
        TEXT_PREVIEW_LIMIT
    } else {
        MEDIA_PREVIEW_LIMIT
    };
    if metadata.len() > limit {
        return Err(format!(
            "文件过大，快速预览上限为 {}",
            if kind == "text" { "512 KB" } else { "12 MB" }
        ));
    }
    // Bound the actual read as well: a file may grow after metadata was read.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取文件预览失败: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err("文件在读取时超出快速预览大小限制".into());
    }
    if kind == "text" {
        let text = String::from_utf8(bytes)
            .map_err(|_| "此文本不是有效 UTF-8 编码，暂无法预览".to_string())?;
        if text.contains('\0') {
            return Err("此文件含有二进制内容，暂无法作为文本预览".into());
        }
        preview.text = Some(text.trim_start_matches('\u{feff}').to_string());
    } else {
        if kind == "pdf" && !bytes.starts_with(b"%PDF-") {
            return Err("文件不是有效的 PDF 文档".into());
        }
        preview.data_url = Some(format!(
            "data:{};base64,{}",
            mime.unwrap_or_default(),
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
    }
    Ok(preview)
}

/// Read a bounded desktop file without opening its default application.
#[tauri::command]
pub async fn desktop_preview_file(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<DesktopPreview, String> {
    if !["desktop-space", "desktop-organizer"].contains(&window.label()) {
        return Err("此窗口不能预览桌面文件".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = validated_desktop_entry(&path)?;
        read_desktop_preview(&path)
    })
    .await
    .map_err(|error| format!("文件预览任务异常结束: {error}"))?
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
    use super::*;

    struct PreviewFiles(PathBuf);

    impl PreviewFiles {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("dtkit-desktop-preview-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        }
    }

    impl Drop for PreviewFiles {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

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

    #[test]
    fn preview_reads_real_utf8_text_and_marks_unsupported_formats() {
        let files = PreviewFiles::new();
        let path = files.file("notes.md", "\u{feff}# 项目笔记\n真实内容".as_bytes());
        let preview = read_desktop_preview(&path).unwrap();
        assert_eq!(preview.kind, "text");
        assert_eq!(preview.text.as_deref(), Some("# 项目笔记\n真实内容"));
        assert!(preview.data_url.is_none());
        let path = files.file("proposal.docx", b"content is not fabricated as preview");
        let preview = read_desktop_preview(&path).unwrap();
        assert_eq!(preview.kind, "metadata");
        assert!(preview.message.is_some());
        assert!(preview.text.is_none());
        assert_eq!(preview.size, 36);
    }

    #[test]
    fn preview_rejects_directories_missing_files_binary_text_and_large_content() {
        let files = PreviewFiles::new();
        assert!(read_desktop_preview(&files.0)
            .err()
            .unwrap()
            .contains("文件夹"));
        assert!(read_desktop_preview(&files.0.join("missing.txt")).is_err());
        assert!(read_desktop_preview(&files.file("invalid.txt", &[0xff, 0xfe])).is_err());
        assert!(read_desktop_preview(&files.file("binary.txt", b"hello\0world")).is_err());
        let large = files.file("large.txt", b"");
        std::fs::File::options()
            .write(true)
            .open(&large)
            .unwrap()
            .set_len(TEXT_PREVIEW_LIMIT + 1)
            .unwrap();
        assert!(read_desktop_preview(&large).is_err());
        let pdf = files.file("large.pdf", b"%PDF-1.7");
        std::fs::File::options()
            .write(true)
            .open(&pdf)
            .unwrap()
            .set_len(MEDIA_PREVIEW_LIMIT + 1)
            .unwrap();
        assert!(read_desktop_preview(&pdf).is_err());
    }

    #[test]
    fn preview_returns_bounded_pdf_bytes_and_checks_its_signature() {
        let files = PreviewFiles::new();
        let preview =
            read_desktop_preview(&files.file("reference.pdf", b"%PDF-1.7\nexample")).unwrap();
        assert_eq!(preview.kind, "pdf");
        assert_eq!(
            preview.data_url.as_deref(),
            Some("data:application/pdf;base64,JVBERi0xLjcKZXhhbXBsZQ==")
        );
        assert!(read_desktop_preview(&files.file("fake.pdf", b"<html>not a PDF</html>")).is_err());
    }

    #[test]
    fn canonical_boundary_rejects_parent_traversal_and_the_root_itself() {
        let files = PreviewFiles::new();
        let desktop = files.0.join("Desktop");
        std::fs::create_dir(&desktop).unwrap();
        let inside = desktop.join("notes.txt");
        std::fs::write(&inside, b"inside").unwrap();
        files.file("outside.txt", b"outside");
        assert_eq!(
            validated_entry_in_root(&desktop, &inside).unwrap(),
            inside.canonicalize().unwrap()
        );
        assert!(validated_entry_in_root(&desktop, &desktop).is_err());
        assert!(validated_entry_in_root(&desktop, &desktop.join("..\\outside.txt")).is_err());
        assert!(validated_entry_in_root(&desktop, &desktop.join("missing.txt")).is_err());
    }
}
