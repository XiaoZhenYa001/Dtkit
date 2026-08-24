use super::storage::{StorageLayout, StorageManager};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, KEY_WRITE,
    REG_EXPAND_SZ, REG_SZ,
};
#[cfg(target_os = "windows")]
use winreg::{RegKey, RegValue};

const STORE_VERSION: u8 = 1;
const DISABLED_SUFFIX: &str = ".dtkit-disabled";
const BACKUP_FILE: &str = "startup-disabled.json";

#[derive(Default)]
pub(crate) struct SystemAssistantManager {
    write_lock: Mutex<()>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupEntry {
    id: String,
    name: String,
    command: String,
    target_path: Option<String>,
    source_kind: StartupSourceKind,
    source_label: String,
    source_detail: String,
    scope: StartupScope,
    enabled: bool,
    can_toggle: bool,
    requires_elevation: bool,
    #[serde(skip)]
    source_id: String,
    #[serde(skip)]
    source_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum StartupSourceKind {
    Registry,
    StartupFolder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum StartupScope {
    User,
    System,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupSnapshot {
    items: Vec<StartupEntry>,
    total: usize,
    enabled: usize,
    disabled: usize,
    user_items: usize,
    system_items: usize,
    scanned_at: i64,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryBackupStore {
    version: u8,
    #[serde(default)]
    registry_items: Vec<RegistryBackup>,
}

impl Default for RegistryBackupStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            registry_items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryBackup {
    id: String,
    source_id: String,
    name: String,
    command: String,
    value_kind: RegistryValueKind,
    raw_bytes: Vec<u8>,
    disabled_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RegistryValueKind {
    String,
    ExpandString,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
enum RegistryHive {
    CurrentUser,
    LocalMachine,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
struct RegistrySource {
    id: &'static str,
    hive: RegistryHive,
    path: &'static str,
    view: u32,
    label: &'static str,
    scope: StartupScope,
}

#[cfg(target_os = "windows")]
fn registry_sources() -> [RegistrySource; 6] {
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_ONCE: &str = r"Software\Microsoft\Windows\CurrentVersion\RunOnce";
    [
        RegistrySource {
            id: "hkcu-run",
            hive: RegistryHive::CurrentUser,
            path: RUN,
            view: 0,
            label: "当前用户 · 注册表 Run",
            scope: StartupScope::User,
        },
        RegistrySource {
            id: "hkcu-runonce",
            hive: RegistryHive::CurrentUser,
            path: RUN_ONCE,
            view: 0,
            label: "当前用户 · 注册表 RunOnce",
            scope: StartupScope::User,
        },
        RegistrySource {
            id: "hklm-run64",
            hive: RegistryHive::LocalMachine,
            path: RUN,
            view: KEY_WOW64_64KEY,
            label: "所有用户 · 64 位 Run",
            scope: StartupScope::System,
        },
        RegistrySource {
            id: "hklm-runonce64",
            hive: RegistryHive::LocalMachine,
            path: RUN_ONCE,
            view: KEY_WOW64_64KEY,
            label: "所有用户 · 64 位 RunOnce",
            scope: StartupScope::System,
        },
        RegistrySource {
            id: "hklm-run32",
            hive: RegistryHive::LocalMachine,
            path: RUN,
            view: KEY_WOW64_32KEY,
            label: "所有用户 · 32 位 Run",
            scope: StartupScope::System,
        },
        RegistrySource {
            id: "hklm-runonce32",
            hive: RegistryHive::LocalMachine,
            path: RUN_ONCE,
            view: KEY_WOW64_32KEY,
            label: "所有用户 · 32 位 RunOnce",
            scope: StartupScope::System,
        },
    ]
}

fn store_path(layout: &StorageLayout) -> Result<PathBuf, String> {
    let directory = layout.kits.join("SystemAssistant");
    fs::create_dir_all(&directory).map_err(|error| format!("创建系统助手数据目录失败: {error}"))?;
    Ok(directory.join(BACKUP_FILE))
}

fn read_store(layout: &StorageLayout) -> Result<RegistryBackupStore, String> {
    let path = store_path(layout)?;
    if !path.is_file() {
        return Ok(RegistryBackupStore::default());
    }
    let store: RegistryBackupStore = serde_json::from_slice(
        &fs::read(&path).map_err(|error| format!("读取启动项恢复信息失败: {error}"))?,
    )
    .map_err(|error| format!("启动项恢复信息损坏，请勿继续启停操作: {error}"))?;
    if store.version != STORE_VERSION {
        return Err(format!("暂不支持启动项恢复信息版本 {}", store.version));
    }
    Ok(store)
}

fn write_store(layout: &StorageLayout, store: &RegistryBackupStore) -> Result<(), String> {
    let path = store_path(layout)?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("序列化启动项恢复信息失败: {error}"))?;
    fs::write(&temporary, bytes).map_err(|error| format!("写入启动项恢复信息失败: {error}"))?;
    if path.is_file() {
        let _ = fs::remove_file(&backup);
        fs::rename(&path, &backup).map_err(|error| format!("备份启动项恢复信息失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.is_file() {
            let _ = fs::rename(&backup, &path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("提交启动项恢复信息失败: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn stable_id(namespace: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("{namespace}\0{}", value.to_lowercase()).as_bytes());
    format!("{namespace}-{}", hex::encode(&digest[..10]))
}

fn registry_id(source_id: &str, name: &str) -> String {
    stable_id("registry", &format!("{source_id}\0{name}"))
}

fn folder_id(scope: StartupScope, original_path: &Path) -> String {
    let scope = if scope == StartupScope::User {
        "user"
    } else {
        "system"
    };
    stable_id("folder", &format!("{scope}\0{}", original_path.display()))
}

fn summarize(mut items: Vec<StartupEntry>, warnings: Vec<String>) -> StartupSnapshot {
    items.sort_by(|left, right| {
        right
            .enabled
            .cmp(&left.enabled)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.source_label.cmp(&right.source_label))
    });
    StartupSnapshot {
        total: items.len(),
        enabled: items.iter().filter(|item| item.enabled).count(),
        disabled: items.iter().filter(|item| !item.enabled).count(),
        user_items: items
            .iter()
            .filter(|item| item.scope == StartupScope::User)
            .count(),
        system_items: items
            .iter()
            .filter(|item| item.scope == StartupScope::System)
            .count(),
        scanned_at: Utc::now().timestamp_millis(),
        items,
        warnings,
    }
}

#[cfg(target_os = "windows")]
fn root_key(hive: RegistryHive) -> RegKey {
    match hive {
        RegistryHive::CurrentUser => RegKey::predef(HKEY_CURRENT_USER),
        RegistryHive::LocalMachine => RegKey::predef(HKEY_LOCAL_MACHINE),
    }
}

#[cfg(target_os = "windows")]
fn registry_source(source_id: &str) -> Option<RegistrySource> {
    registry_sources()
        .into_iter()
        .find(|source| source.id == source_id)
}

#[cfg(target_os = "windows")]
fn decode_registry_value(value: &RegValue) -> Option<(String, RegistryValueKind)> {
    let kind = if value.vtype == REG_SZ {
        RegistryValueKind::String
    } else if value.vtype == REG_EXPAND_SZ {
        RegistryValueKind::ExpandString
    } else {
        return None;
    };
    Some((value.to_string(), kind))
}

#[cfg(target_os = "windows")]
fn scan_registry(
    backups: &RegistryBackupStore,
    items: &mut Vec<StartupEntry>,
    warnings: &mut Vec<String>,
) {
    let mut enabled_ids = HashSet::new();
    for source in registry_sources() {
        let key = match root_key(source.hive)
            .open_subkey_with_flags(source.path, KEY_READ | source.view)
        {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                warnings.push(format!("无法读取 {}: {error}", source.label));
                continue;
            }
        };
        for value in key.enum_values().flatten() {
            let (name, raw) = value;
            let Some((command, _)) = decode_registry_value(&raw) else {
                continue;
            };
            let id = registry_id(source.id, &name);
            enabled_ids.insert(id.clone());
            items.push(StartupEntry {
                id,
                name,
                target_path: command_target(&command)
                    .map(|path| path.to_string_lossy().to_string()),
                command,
                source_kind: StartupSourceKind::Registry,
                source_label: source.label.to_string(),
                source_detail: format!("{}\\{}", source.path, source.id),
                scope: source.scope,
                enabled: true,
                can_toggle: true,
                requires_elevation: source.scope == StartupScope::System,
                source_id: source.id.to_string(),
                source_path: None,
            });
        }
    }

    for backup in &backups.registry_items {
        if enabled_ids.contains(&backup.id) {
            continue;
        }
        let Some(source) = registry_source(&backup.source_id) else {
            warnings.push(format!("存在无法识别来源的已停用启动项：{}", backup.name));
            continue;
        };
        items.push(StartupEntry {
            id: backup.id.clone(),
            name: backup.name.clone(),
            target_path: command_target(&backup.command)
                .map(|path| path.to_string_lossy().to_string()),
            command: backup.command.clone(),
            source_kind: StartupSourceKind::Registry,
            source_label: source.label.to_string(),
            source_detail: format!("{}\\{} · 已由 DtKit 安全停用", source.path, source.id),
            scope: source.scope,
            enabled: false,
            can_toggle: true,
            requires_elevation: source.scope == StartupScope::System,
            source_id: source.id.to_string(),
            source_path: None,
        });
    }
}

fn startup_directories() -> Vec<(StartupScope, &'static str, PathBuf)> {
    let mut directories = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        directories.push((
            StartupScope::User,
            "当前用户 · 启动文件夹",
            PathBuf::from(app_data).join(r"Microsoft\Windows\Start Menu\Programs\Startup"),
        ));
    }
    if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
        directories.push((
            StartupScope::System,
            "所有用户 · 启动文件夹",
            PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs\StartUp"),
        ));
    }
    directories
}

fn original_folder_path(path: &Path, disabled: bool) -> PathBuf {
    if !disabled {
        return path.to_path_buf();
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    path.with_file_name(name.strip_suffix(DISABLED_SUFFIX).unwrap_or(name))
}

fn startup_display_name(path: &Path, disabled: bool) -> String {
    let original = original_folder_path(path, disabled);
    original
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("未命名启动项")
        .to_string()
}

fn scan_startup_folders(items: &mut Vec<StartupEntry>, warnings: &mut Vec<String>) {
    for (scope, label, directory) in startup_directories() {
        if !directory.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                warnings.push(format!("无法读取 {label}: {error}"));
                continue;
            }
        };
        let paths = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
        let enabled_originals = paths
            .iter()
            .filter(|path| {
                !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(DISABLED_SUFFIX))
            })
            .map(|path| path.to_string_lossy().to_lowercase())
            .collect::<HashSet<_>>();
        for path in paths {
            let disabled = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(DISABLED_SUFFIX));
            let original = original_folder_path(&path, disabled);
            if disabled && enabled_originals.contains(&original.to_string_lossy().to_lowercase()) {
                continue;
            }
            items.push(StartupEntry {
                id: folder_id(scope, &original),
                name: startup_display_name(&path, disabled),
                command: original.to_string_lossy().to_string(),
                target_path: Some(path.to_string_lossy().to_string()),
                source_kind: StartupSourceKind::StartupFolder,
                source_label: label.to_string(),
                source_detail: directory.to_string_lossy().to_string(),
                scope,
                enabled: !disabled,
                can_toggle: true,
                requires_elevation: scope == StartupScope::System,
                source_id: if scope == StartupScope::User {
                    "user-startup-folder"
                } else {
                    "system-startup-folder"
                }
                .to_string(),
                source_path: Some(path),
            });
        }
    }
}

#[cfg(target_os = "windows")]
fn scan(layout: &StorageLayout) -> Result<StartupSnapshot, String> {
    let store = read_store(layout)?;
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    scan_registry(&store, &mut items, &mut warnings);
    scan_startup_folders(&mut items, &mut warnings);
    Ok(summarize(items, warnings))
}

#[cfg(not(target_os = "windows"))]
fn scan(_layout: &StorageLayout) -> Result<StartupSnapshot, String> {
    Err("开机启动管理目前仅支持 Windows".to_string())
}

fn expand_percent_variables(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            output.push_str(&rest[start..]);
            return output;
        };
        let key = &after[..end];
        if let Some(replacement) = std::env::var_os(key) {
            output.push_str(&replacement.to_string_lossy());
        } else {
            output.push('%');
            output.push_str(key);
            output.push('%');
        }
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    output
}

fn command_target(command: &str) -> Option<PathBuf> {
    let expanded = expand_percent_variables(command.trim());
    let candidate = if let Some(quoted) = expanded.strip_prefix('"') {
        quoted.find('"').map(|end| &quoted[..end])?
    } else {
        let lower = expanded.to_ascii_lowercase();
        [".exe", ".com", ".bat", ".cmd", ".lnk"]
            .iter()
            .filter_map(|suffix| lower.find(suffix).map(|index| index + suffix.len()))
            .min()
            .map(|end| expanded[..end].trim())
            .unwrap_or_else(|| expanded.split_whitespace().next().unwrap_or_default())
    };
    let candidate = candidate.trim_matches('"');
    if candidate.is_empty() {
        return None;
    }
    let direct = PathBuf::from(candidate);
    if direct.is_file() {
        return Some(direct);
    }
    if direct.components().count() == 1 {
        if let Some(path) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&path) {
                let resolved = directory.join(&direct);
                if resolved.is_file() {
                    return Some(resolved);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn disable_registry(layout: &StorageLayout, entry: &StartupEntry) -> Result<(), String> {
    let source = registry_source(&entry.source_id).ok_or_else(|| "启动项来源已失效".to_string())?;
    let key = root_key(source.hive)
        .open_subkey_with_flags(source.path, KEY_READ | KEY_WRITE | source.view)
        .map_err(|error| permission_message("打开", source, error))?;
    let raw = key
        .get_raw_value(&entry.name)
        .map_err(|error| format!("重新读取启动项失败: {error}"))?;
    let (command, value_kind) = decode_registry_value(&raw)
        .ok_or_else(|| "只支持管理文本类型的注册表启动项".to_string())?;
    let previous = read_store(layout)?;
    let mut next = previous.clone();
    next.registry_items.retain(|item| item.id != entry.id);
    next.registry_items.push(RegistryBackup {
        id: entry.id.clone(),
        source_id: entry.source_id.clone(),
        name: entry.name.clone(),
        command,
        value_kind,
        raw_bytes: raw.bytes,
        disabled_at: Utc::now().timestamp_millis(),
    });
    write_store(layout, &next)?;
    if let Err(error) = key.delete_value(&entry.name) {
        let rollback = write_store(layout, &previous);
        return Err(if let Err(rollback_error) = rollback {
            format!("停用失败: {error}；恢复信息回滚也失败: {rollback_error}")
        } else {
            permission_message("停用", source, error)
        });
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn enable_registry(layout: &StorageLayout, entry: &StartupEntry) -> Result<(), String> {
    let source = registry_source(&entry.source_id).ok_or_else(|| "启动项来源已失效".to_string())?;
    let previous = read_store(layout)?;
    let backup = previous
        .registry_items
        .iter()
        .find(|item| item.id == entry.id)
        .cloned()
        .ok_or_else(|| "找不到该启动项的恢复信息".to_string())?;
    let key = root_key(source.hive)
        .open_subkey_with_flags(source.path, KEY_READ | KEY_WRITE | source.view)
        .map_err(|error| permission_message("打开", source, error))?;
    let raw = RegValue {
        bytes: backup.raw_bytes,
        vtype: match backup.value_kind {
            RegistryValueKind::String => REG_SZ,
            RegistryValueKind::ExpandString => REG_EXPAND_SZ,
        },
    };
    key.set_raw_value(&entry.name, &raw)
        .map_err(|error| permission_message("启用", source, error))?;
    let mut next = previous.clone();
    next.registry_items.retain(|item| item.id != entry.id);
    if let Err(error) = write_store(layout, &next) {
        if key.delete_value(&entry.name).is_err() {
            return Err(format!(
                "启动项已经恢复，但清理恢复信息失败，请刷新确认状态: {error}"
            ));
        }
        return Err(format!("提交启用操作失败，已回滚: {error}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn permission_message(action: &str, source: RegistrySource, error: std::io::Error) -> String {
    if source.scope == StartupScope::System && error.kind() == std::io::ErrorKind::PermissionDenied
    {
        format!("{action}系统级启动项需要管理员权限，请以管理员身份运行 DtKit 后重试")
    } else {
        format!("{action}启动项失败: {error}")
    }
}

fn set_folder_enabled(entry: &StartupEntry, enabled: bool) -> Result<(), String> {
    let current = entry
        .source_path
        .as_ref()
        .ok_or_else(|| "启动文件路径已失效".to_string())?;
    let destination = if enabled {
        original_folder_path(current, true)
    } else {
        let file_name = current
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "启动文件名无效".to_string())?;
        current.with_file_name(format!("{file_name}{DISABLED_SUFFIX}"))
    };
    if destination.exists() {
        return Err("目标位置已有同名启动项，未执行任何更改".to_string());
    }
    fs::rename(current, &destination).map_err(|error| {
        if entry.requires_elevation && error.kind() == std::io::ErrorKind::PermissionDenied {
            "管理所有用户的启动文件夹需要管理员权限".to_string()
        } else {
            format!("移动启动文件失败: {error}")
        }
    })
}

#[tauri::command]
pub(crate) async fn scan_system_startup_items(
    storage: tauri::State<'_, StorageManager>,
) -> Result<StartupSnapshot, String> {
    let layout = storage.layout()?;
    tauri::async_runtime::spawn_blocking(move || scan(&layout))
        .await
        .map_err(|error| format!("启动项扫描任务异常: {error}"))?
}

#[tauri::command]
pub(crate) fn set_system_startup_enabled(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, SystemAssistantManager>,
    id: String,
    enabled: bool,
) -> Result<StartupSnapshot, String> {
    let _guard = manager
        .write_lock
        .lock()
        .map_err(|_| "系统助手写入状态不可用".to_string())?;
    let layout = storage.layout()?;
    let snapshot = scan(&layout)?;
    let entry = snapshot
        .items
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "启动项已变化，请刷新后重试".to_string())?;
    if entry.enabled == enabled {
        return Ok(snapshot);
    }
    match entry.source_kind {
        StartupSourceKind::Registry => {
            #[cfg(target_os = "windows")]
            if enabled {
                enable_registry(&layout, entry)?
            } else {
                disable_registry(&layout, entry)?
            }
            #[cfg(not(target_os = "windows"))]
            return Err("开机启动管理目前仅支持 Windows".to_string());
        }
        StartupSourceKind::StartupFolder => set_folder_enabled(entry, enabled)?,
    }
    scan(&layout)
}

#[tauri::command]
pub(crate) fn reveal_system_startup_item(
    storage: tauri::State<'_, StorageManager>,
    id: String,
) -> Result<(), String> {
    let layout = storage.layout()?;
    let snapshot = scan(&layout)?;
    let entry = snapshot
        .items
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "启动项已变化，请刷新后重试".to_string())?;
    let path = entry
        .source_path
        .clone()
        .or_else(|| entry.target_path.as_ref().map(PathBuf::from))
        .filter(|path| path.exists())
        .ok_or_else(|| "该启动项没有可定位的本地文件".to_string())?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|error| format!("打开文件位置失败: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("开机启动管理目前仅支持 Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_source_specific() {
        assert_eq!(
            registry_id("hkcu-run", "Example"),
            registry_id("hkcu-run", "example")
        );
        assert_ne!(
            registry_id("hkcu-run", "Example"),
            registry_id("hklm-run64", "Example")
        );
    }

    #[test]
    fn quoted_command_extracts_existing_target() {
        let executable = std::env::current_exe().unwrap();
        let command = format!("\"{}\" --background", executable.display());
        assert_eq!(command_target(&command), Some(executable));
    }

    #[test]
    fn disabled_folder_name_restores_original_identity() {
        let path = PathBuf::from(r"C:\Startup\Example.lnk.dtkit-disabled");
        assert_eq!(
            original_folder_path(&path, true),
            PathBuf::from(r"C:\Startup\Example.lnk")
        );
        assert_eq!(startup_display_name(&path, true), "Example");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_scan_produces_consistent_summary_without_mutating_sources() {
        use crate::infrastructure::storage::{StorageLayout, StorageMode};

        let root =
            std::env::temp_dir().join(format!("dtkit-system-assistant-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let layout = StorageLayout::from_root(StorageMode::Standard, root.clone());
        let snapshot = scan(&layout).unwrap();
        assert_eq!(snapshot.total, snapshot.items.len());
        assert_eq!(snapshot.total, snapshot.enabled + snapshot.disabled);
        assert_eq!(snapshot.total, snapshot.user_items + snapshot.system_items);
        let _ = fs::remove_dir_all(root);
    }
}
