use crate::infrastructure::storage::StorageManager;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const APP_CONFIG_FILE: &str = "desktop-apps.json";
const MAX_DISCOVERED_APPS: usize = 1_200;
const MAX_SCAN_DEPTH: usize = 8;
const MAX_ICON_BYTES: u64 = 4 * 1024 * 1024;
const APP_INDEX_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

static START_MENU_CACHE: OnceLock<Mutex<Option<(Instant, Vec<PathBuf>)>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopApp {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) source: String,
    pub(crate) category: String,
    pub(crate) icon: Option<String>,
    pub(crate) hidden: bool,
    pub(crate) manual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppOverride {
    path: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    icon_file: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    manual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppOverrides {
    #[serde(default)]
    items: Vec<AppOverride>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveDesktopAppRequest {
    path: String,
    name: String,
    category: String,
    hidden: bool,
    manual: bool,
    icon_path: Option<String>,
}

fn normalized_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    value
        .strip_prefix(r"\\?\")
        .unwrap_or(&value)
        .replace('/', "\\")
        .to_lowercase()
}

fn normalized_name(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    for suffix in [".exe", ".lnk", ".url"] {
        if let Some(name) = normalized.strip_suffix(suffix) {
            return name.trim().to_string();
        }
    }
    normalized
}

fn app_id(path: &Path) -> String {
    let digest = Sha256::digest(normalized_path(path).as_bytes());
    format!("app-{}", &hex::encode(digest)[..16])
}

fn allowed_app_extension(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str(),
        "exe" | "lnk" | "url"
    )
}

fn allowed_indexed_app_extension(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str(),
        "exe" | "lnk"
    )
}

fn allowed_icon_extension(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "ico"
    )
}

fn start_menu_roots() -> Vec<PathBuf> {
    let mut roots = Vec::with_capacity(2);
    if let Some(app_data) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(app_data).join("Microsoft").join("Windows").join("Start Menu").join("Programs"));
    }
    if let Some(program_data) = std::env::var_os("ProgramData") {
        roots.push(PathBuf::from(program_data).join("Microsoft").join("Windows").join("Start Menu").join("Programs"));
    }
    roots
}

fn scan_start_menu_paths() -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut queue = VecDeque::new();
    for root in start_menu_roots().into_iter().filter(|root| root.is_dir()) {
        queue.push_back((root, 0usize));
    }
    while let Some((directory, depth)) = queue.pop_front() {
        if found.len() >= MAX_DISCOVERED_APPS { break; }
        let Ok(entries) = fs::read_dir(directory) else { continue; };
        for entry in entries.flatten() {
            if found.len() >= MAX_DISCOVERED_APPS { break; }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else { continue; };
            if metadata.file_type().is_symlink() { continue; }
            if metadata.is_dir() && depth < MAX_SCAN_DEPTH {
                queue.push_back((path, depth + 1));
            } else if metadata.is_file() && allowed_indexed_app_extension(&path) {
                found.push(path);
            }
        }
    }
    found
}

fn discover_start_menu_paths(force_refresh: bool) -> Vec<PathBuf> {
    let cache = START_MENU_CACHE.get_or_init(|| Mutex::new(None));
    if !force_refresh {
        if let Ok(guard) = cache.lock() {
            if let Some((captured_at, paths)) = guard.as_ref() {
                if captured_at.elapsed() < APP_INDEX_CACHE_TTL {
                    return paths.clone();
                }
            }
        }
    }
    let paths = scan_start_menu_paths();
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), paths.clone()));
    }
    paths
}

fn config_path(storage: &StorageManager) -> Result<PathBuf, String> {
    storage.config_file(APP_CONFIG_FILE)
}

fn load_overrides(storage: &StorageManager) -> AppOverrides {
    let Ok(path) = config_path(storage) else { return AppOverrides::default(); };
    fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn save_overrides(storage: &StorageManager, overrides: &AppOverrides) -> Result<(), String> {
    let path = config_path(storage)?;
    let parent = path.parent().ok_or_else(|| "应用配置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建应用配置目录失败: {error}"))?;
    let temporary = parent.join(format!(".{APP_CONFIG_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(overrides).map_err(|error| format!("序列化应用配置失败: {error}"))?;
    fs::write(&temporary, bytes).map_err(|error| format!("写入应用配置失败: {error}"))?;
    let backup = parent.join(format!(".{APP_CONFIG_FILE}.backup"));
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(&path, &backup).map_err(|error| format!("备份旧应用配置失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.exists() { let _ = fs::rename(&backup, &path); }
        let _ = fs::remove_file(&temporary);
        return Err(format!("提交应用配置失败: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn custom_icon_data(storage: &StorageManager, file_name: &str) -> Option<String> {
    if file_name.is_empty() || file_name.contains(['/', '\\']) { return None; }
    let path = storage.layout().ok()?.kits.join("DesktopOrganizer").join("Icons").join(file_name);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES { return None; }
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match extension.as_str() { "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "ico" => "image/x-icon", _ => return None };
    let encoded = base64::engine::general_purpose::STANDARD.encode(fs::read(path).ok()?);
    Some(format!("data:{mime};base64,{encoded}"))
}

pub(crate) fn list_desktop_apps(storage: &StorageManager, include_hidden: bool, refresh_index: bool) -> Result<Vec<DesktopApp>, String> {
    let overrides = load_overrides(storage);
    let override_map = overrides.items.iter().map(|item| (normalized_path(Path::new(&item.path)), item)).collect::<HashMap<_, _>>();
    let mut paths = discover_start_menu_paths(refresh_index);
    paths.extend(overrides.items.iter().filter(|item| item.manual).map(|item| PathBuf::from(&item.path)));
    let mut seen = HashSet::new();
    let mut seen_names = HashSet::new();
    let mut apps = Vec::new();
    for path in paths {
        if !path.is_file() || !allowed_app_extension(&path) { continue; }
        let key = normalized_path(&path);
        if !seen.insert(key.clone()) { continue; }
        let custom = override_map.get(&key).copied();
        let hidden = custom.is_some_and(|item| item.hidden);
        if hidden && !include_hidden { continue; }
        let default_name = path.file_stem().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "未命名应用".to_string());
        let display_name = custom.filter(|item| !item.name.trim().is_empty()).map(|item| item.name.trim().to_string()).unwrap_or(default_name);
        if !custom.is_some_and(|item| item.manual) && !seen_names.insert(normalized_name(&display_name)) { continue; }
        apps.push(DesktopApp {
            id: app_id(&path),
            name: display_name,
            path: path.to_string_lossy().to_string(),
            source: if custom.is_some_and(|item| item.manual) { "manual" } else { "start-menu" }.to_string(),
            category: custom.filter(|item| !item.category.trim().is_empty()).map(|item| item.category.trim().to_string()).unwrap_or_else(|| "program".to_string()),
            icon: custom.and_then(|item| custom_icon_data(storage, &item.icon_file)),
            hidden,
            manual: custom.is_some_and(|item| item.manual),
        });
    }
    apps.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(apps)
}

fn validate_app_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_file() || !allowed_app_extension(&path) { return Err("请选择有效的 .exe、.lnk 或 .url 应用文件".to_string()); }
    Ok(path)
}

pub(crate) fn save_desktop_app(storage: &StorageManager, request: SaveDesktopAppRequest) -> Result<(), String> {
    let app_path = validate_app_path(&request.path)?;
    if request.name.chars().count() > 160 || request.category.chars().count() > 80 { return Err("应用名称或分类过长".to_string()); }
    let mut overrides = load_overrides(storage);
    let key = normalized_path(&app_path);
    let existing_index = overrides.items.iter().position(|item| normalized_path(Path::new(&item.path)) == key);
    let existing_icon = existing_index.and_then(|index| { let value = overrides.items[index].icon_file.clone(); (!value.is_empty()).then_some(value) }).unwrap_or_default();
    let previous_icon = existing_icon.clone();
    let icon_file = if let Some(icon_path) = request.icon_path.as_deref().filter(|value| !value.is_empty()) {
        let source = PathBuf::from(icon_path);
        let metadata = fs::metadata(&source).map_err(|error| format!("读取图标失败: {error}"))?;
        if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES || !allowed_icon_extension(&source) { return Err("图标必须是小于 4MB 的 PNG、JPG 或 ICO 文件".to_string()); }
        let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("png").to_ascii_lowercase();
        let file_name = format!("{}.{}", app_id(&app_path), extension);
        let directory = storage.layout()?.kits.join("DesktopOrganizer").join("Icons");
        fs::create_dir_all(&directory).map_err(|error| format!("创建图标目录失败: {error}"))?;
        fs::copy(&source, directory.join(&file_name)).map_err(|error| format!("保存自定义图标失败: {error}"))?;
        file_name
    } else { existing_icon };
    let item = AppOverride { path: app_path.to_string_lossy().to_string(), name: request.name.trim().to_string(), category: request.category.trim().to_string(), icon_file: icon_file.clone(), hidden: request.hidden, manual: request.manual || existing_index.and_then(|index| overrides.items.get(index)).is_some_and(|item| item.manual) };
    if let Some(index) = existing_index { overrides.items[index] = item; } else if overrides.items.len() < MAX_DISCOVERED_APPS { overrides.items.push(item); } else { return Err("应用管理记录已达到 1200 条上限".to_string()); }
    if let Err(error) = save_overrides(storage, &overrides) {
        if !icon_file.is_empty() && icon_file != previous_icon {
            if let Ok(layout) = storage.layout() { let _ = fs::remove_file(layout.kits.join("DesktopOrganizer").join("Icons").join(&icon_file)); }
        }
        return Err(error);
    }
    if !previous_icon.is_empty() && previous_icon != icon_file {
        if let Ok(layout) = storage.layout() { let _ = fs::remove_file(layout.kits.join("DesktopOrganizer").join("Icons").join(previous_icon)); }
    }
    Ok(())
}

pub(crate) fn reset_desktop_app(storage: &StorageManager, path: &str) -> Result<(), String> {
    let mut overrides = load_overrides(storage);
    let key = normalized_path(Path::new(path));
    if let Some(index) = overrides.items.iter().position(|item| normalized_path(Path::new(&item.path)) == key) {
        let removed = overrides.items.remove(index);
        save_overrides(storage, &overrides)?;
        if !removed.icon_file.is_empty() {
            if let Ok(layout) = storage.layout() { let _ = fs::remove_file(layout.kits.join("DesktopOrganizer").join("Icons").join(removed.icon_file)); }
        }
    }
    Ok(())
}

pub(crate) fn known_app_path(storage: &StorageManager, candidate: &Path) -> bool {
    let key = normalized_path(candidate);
    discover_start_menu_paths(false).iter().any(|path| normalized_path(path) == key)
        || load_overrides(storage).items.iter().any(|item| normalized_path(Path::new(&item.path)) == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_index_excludes_url_helpers_but_manual_validation_keeps_compatibility() {
        assert!(allowed_indexed_app_extension(Path::new("Steam.lnk")));
        assert!(allowed_indexed_app_extension(Path::new("Steam.exe")));
        assert!(!allowed_indexed_app_extension(Path::new("Steam Support Center.url")));
        assert!(allowed_app_extension(Path::new("manually-added.url")));
    }

    #[test]
    fn duplicate_names_ignore_case_and_common_executable_suffixes() {
        assert_eq!(normalized_name(" Steam "), normalized_name("steam.LNK"));
        assert_eq!(normalized_name("Tool.exe"), "tool");
    }

    #[test]
    fn extended_windows_paths_normalize_like_regular_paths() {
        assert_eq!(
            normalized_path(Path::new(r"\\?\C:\ProgramData\Steam.lnk")),
            normalized_path(Path::new(r"C:\ProgramData\Steam.lnk"))
        );
    }
}
