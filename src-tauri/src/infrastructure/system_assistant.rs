use super::{
    storage::{StorageLayout, StorageManager},
    tool_modules::ToolModuleManager,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{Manager, WebviewWindow};

#[cfg(target_os = "windows")]
use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, KEY_WOW64_32KEY,
    KEY_WOW64_64KEY, REG_EXPAND_SZ, REG_SZ,
};
#[cfg(target_os = "windows")]
use winreg::{RegKey, RegValue};

const STORE_VERSION: u8 = 1;
const DISABLED_SUFFIX: &str = ".dtkit-disabled";
const DISABLED_DIRECTORY: &str = "DtKitDisabledStartup";
const BACKUP_FILE: &str = "startup-disabled.json";
const MAX_STORE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SOURCE_ITEMS: usize = 4096;

#[derive(Default)]
pub(crate) struct SystemAssistantManager(Mutex<()>);

impl SystemAssistantManager {
    pub(crate) fn migration_guard(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.0
            .lock()
            .map_err(|_| "启动项管理状态不可用".to_string())
    }
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
    managed: bool,
    requires_elevation: bool,
    disabled_reason: Option<String>,
    fingerprint: String,
    can_reveal: bool,
    can_reveal_source: bool,
    target_exists: bool,
    source_path: Option<PathBuf>,
    #[serde(skip)]
    source_id: String,
    #[serde(skip)]
    approval: Option<RawValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StartupSourceKind {
    Registry,
    StartupFolder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    managed: usize,
    read_only: usize,
    scanned_at: i64,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RawValue {
    kind: u32,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryBackupStore {
    version: u8,
    #[serde(default)]
    registry_items: Vec<RegistryBackup>,
    #[serde(default)]
    folder_items: Vec<FolderBackup>,
}

impl Default for RegistryBackupStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            registry_items: Vec::new(),
            folder_items: Vec::new(),
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
    #[serde(default)]
    approval: Option<RawValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RegistryValueKind {
    String,
    ExpandString,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderBackup {
    id: String,
    scope: StartupScope,
    original_path: PathBuf,
    stored_path: PathBuf,
    content_hash: String,
    disabled_at: i64,
    #[serde(default)]
    approval: Option<RawValue>,
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
    approval_group: Option<&'static str>,
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
            approval_group: Some("Run"),
        },
        RegistrySource {
            id: "hkcu-runonce",
            hive: RegistryHive::CurrentUser,
            path: RUN_ONCE,
            view: 0,
            label: "当前用户 · 注册表 RunOnce（一次性）",
            scope: StartupScope::User,
            approval_group: None,
        },
        RegistrySource {
            id: "hklm-run64",
            hive: RegistryHive::LocalMachine,
            path: RUN,
            view: KEY_WOW64_64KEY,
            label: "所有用户 · 64 位 Run",
            scope: StartupScope::System,
            approval_group: Some("Run"),
        },
        RegistrySource {
            id: "hklm-runonce64",
            hive: RegistryHive::LocalMachine,
            path: RUN_ONCE,
            view: KEY_WOW64_64KEY,
            label: "所有用户 · 64 位 RunOnce（一次性）",
            scope: StartupScope::System,
            approval_group: None,
        },
        RegistrySource {
            id: "hklm-run32",
            hive: RegistryHive::LocalMachine,
            path: RUN,
            view: KEY_WOW64_32KEY,
            label: "所有用户 · 32 位 Run",
            scope: StartupScope::System,
            approval_group: Some("Run32"),
        },
        RegistrySource {
            id: "hklm-runonce32",
            hive: RegistryHive::LocalMachine,
            path: RUN_ONCE,
            view: KEY_WOW64_32KEY,
            label: "所有用户 · 32 位 RunOnce（一次性）",
            scope: StartupScope::System,
            approval_group: None,
        },
    ]
}

fn store_path(layout: &StorageLayout) -> PathBuf {
    layout.kits.join("SystemAssistant").join(BACKUP_FILE)
}

fn read_store(layout: &StorageLayout) -> Result<RegistryBackupStore, String> {
    let path = store_path(layout);
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RegistryBackupStore::default())
        }
        Err(error) => return Err(format!("读取启动项恢复信息失败: {error}")),
    };
    if file
        .metadata()
        .map_err(|error| format!("读取恢复文件信息失败: {error}"))?
        .len()
        > MAX_STORE_BYTES as u64
    {
        return Err("启动项恢复信息超过 8 MiB 上限，未执行更改".to_string());
    }
    let mut bytes = Vec::new();
    file.take((MAX_STORE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取启动项恢复信息失败: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("启动项恢复信息超过 8 MiB 上限".to_string());
    }
    let store: RegistryBackupStore = serde_json::from_slice(&bytes)
        .map_err(|error| format!("启动项恢复信息损坏，请勿继续启停操作: {error}"))?;
    if store.version != STORE_VERSION {
        return Err(format!("暂不支持启动项恢复信息版本 {}", store.version));
    }
    validate_store(&store)?;
    Ok(store)
}

fn validate_store(store: &RegistryBackupStore) -> Result<(), String> {
    let mut ids = HashSet::new();
    for item in &store.registry_items {
        if item.id != registry_id(&item.source_id, &item.name)
            || item.name.is_empty()
            || item.name.contains('\0')
            || item.raw_bytes.len() > 64 * 1024
            || !ids.insert(item.id.clone())
        {
            return Err("启动项恢复记录无效，未执行更改".to_string());
        }
        #[cfg(target_os = "windows")]
        if registry_source(&item.source_id).is_none() {
            return Err("启动项恢复来源无效".to_string());
        }
        if decode_text(&item.raw_bytes).as_deref() != Some(item.command.as_str()) {
            return Err("启动项恢复记录的原始命令不一致".to_string());
        }
    }
    for item in &store.folder_items {
        if !valid_folder_backup(item) || !ids.insert(item.id.clone()) {
            return Err("启动文件恢复位置无效，未执行更改".to_string());
        }
    }
    Ok(())
}

fn write_store(layout: &StorageLayout, store: &RegistryBackupStore) -> Result<(), String> {
    validate_store(store)?;
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("序列化启动项恢复信息失败: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("启动项恢复信息将超过 8 MiB 上限，未执行更改".to_string());
    }
    let path = store_path(layout);
    fs::create_dir_all(path.parent().unwrap())
        .map_err(|error| format!("创建启动项数据目录失败: {error}"))?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("创建启动项恢复文件失败: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("写入启动项恢复信息失败: {error}"))?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|error| format!("提交启动项恢复信息失败: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn stable_id(namespace: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("{namespace}\0{}", value.to_lowercase()).as_bytes());
    format!("{namespace}-{}", hex::encode(&digest[..10]))
}

fn registry_id(source_id: &str, name: &str) -> String {
    stable_id("registry", &format!("{source_id}\0{name}"))
}
fn folder_id(scope: StartupScope, path: &Path) -> String {
    stable_id(
        "folder",
        &format!(
            "{}\0{}",
            if scope == StartupScope::User {
                "user"
            } else {
                "system"
            },
            path.display()
        ),
    )
}
fn fingerprint<T: Serialize>(value: &T) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).unwrap_or_default(),
    ))
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
        managed: items.iter().filter(|item| item.managed).count(),
        read_only: items.iter().filter(|item| !item.can_toggle).count(),
        scanned_at: Utc::now().timestamp_millis(),
        items,
        warnings,
    }
}

#[cfg(target_os = "windows")]
fn root_key(hive: RegistryHive) -> RegKey {
    RegKey::predef(match hive {
        RegistryHive::CurrentUser => HKEY_CURRENT_USER,
        RegistryHive::LocalMachine => HKEY_LOCAL_MACHINE,
    })
}
#[cfg(target_os = "windows")]
fn registry_source(id: &str) -> Option<RegistrySource> {
    registry_sources()
        .into_iter()
        .find(|source| source.id == id)
}

fn decode_text(bytes: &[u8]) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut wide = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    while wide.last() == Some(&0) {
        wide.pop();
    }
    let value = String::from_utf16(&wide).ok()?;
    if value.contains('\0') {
        return None;
    }
    Some(value)
}

#[cfg(target_os = "windows")]
fn raw_value(value: &RegValue) -> RawValue {
    RawValue {
        kind: value.vtype.clone() as u32,
        bytes: value.bytes.clone(),
    }
}
#[cfg(target_os = "windows")]
fn decode_registry_value(value: &RegValue) -> Option<(String, RegistryValueKind)> {
    decode_raw_command(&raw_value(value))
}

fn decode_raw_command(value: &RawValue) -> Option<(String, RegistryValueKind)> {
    let kind = match value.kind {
        1 => RegistryValueKind::String,
        2 => RegistryValueKind::ExpandString,
        _ => return None,
    };
    if value.bytes.len() > 64 * 1024 {
        return None;
    }
    Some((decode_text(&value.bytes)?, kind))
}

// StartupApproved is not a published write API. Read only the known binary states;
// all unfamiliar formats remain read-only and are managed through Windows settings.
fn approval_state(value: Option<&RawValue>) -> Result<bool, String> {
    let Some(value) = value else {
        return Ok(true);
    };
    if value.kind != 3 || value.bytes.len() != 12 {
        return Err("Windows 启动状态格式无法识别，请在系统启动设置中管理".to_string());
    }
    match u32::from_le_bytes(value.bytes[..4].try_into().unwrap()) {
        2 | 6 => Ok(true),
        3 | 7 => Ok(false),
        _ => Err("Windows 启动状态无法确认，请在系统启动设置中管理".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn read_approval(
    hive: RegistryHive,
    group: Option<&str>,
    name: &str,
) -> Result<Option<RawValue>, String> {
    let Some(group) = group else {
        return Ok(None);
    };
    let path =
        format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\{group}");
    let key = match root_key(hive).open_subkey_with_flags(&path, KEY_READ | KEY_WOW64_64KEY) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取 Windows 启动状态: {error}")),
    };
    match key.get_raw_value(name) {
        Ok(value) => Ok(Some(raw_value(&value))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取 Windows 启动状态: {error}")),
    }
}

fn set_target(entry: &mut StartupEntry, target: Option<PathBuf>) {
    let target = target.filter(|path| is_local_path(path) && path.is_file());
    entry.can_reveal = target.is_some();
    entry.target_exists = target.is_some();
    entry.target_path = target.map(|path| path.to_string_lossy().to_string());
    entry.can_reveal_source = entry
        .source_path
        .as_ref()
        .is_some_and(|path| is_local_path(path) && path.is_file());
    // A registry item has no disk source file; its executable is the only location.
}

fn approval_reason(approval: Result<bool, String>) -> (bool, Option<String>) {
    match approval {
        Ok(true) => (true, None),
        Ok(false) => (
            false,
            Some("已由 Windows 或其他软件关闭，请在系统启动设置中管理".to_string()),
        ),
        Err(error) => (false, Some(error)),
    }
}

#[cfg(target_os = "windows")]
fn scan_registry(
    store: &RegistryBackupStore,
    items: &mut Vec<StartupEntry>,
    warnings: &mut Vec<String>,
) {
    let mut seen = HashSet::new();
    let mut failed = HashSet::new();
    for source in registry_sources() {
        let key = match root_key(source.hive)
            .open_subkey_with_flags(source.path, KEY_READ | source.view)
        {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                warnings.push(format!("无法读取 {}: {error}", source.label));
                failed.insert(source.id);
                continue;
            }
        };
        for (index, result) in key.enum_values().take(MAX_SOURCE_ITEMS + 1).enumerate() {
            if index == MAX_SOURCE_ITEMS {
                warnings.push(format!("{} 条目超过扫描上限", source.label));
                failed.insert(source.id);
                break;
            }
            let (name, raw) = match result {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(format!("枚举 {} 失败: {error}", source.label));
                    failed.insert(source.id);
                    continue;
                }
            };
            if name.is_empty() {
                continue;
            }
            let id = registry_id(source.id, &name);
            seen.insert(id.clone());
            let Some((command, _)) = decode_registry_value(&raw) else {
                warnings.push(format!("{} 的 {} 不是可管理的文本命令", source.label, name));
                continue;
            };
            let approval_result = read_approval(source.hive, source.approval_group, &name);
            let approval = approval_result.as_ref().ok().cloned().flatten();
            let (enabled, mut reason) =
                approval_reason(approval_result.and_then(|value| approval_state(value.as_ref())));
            let previous = store.registry_items.iter().find(|backup| backup.id == id);
            if let Some(previous) = previous {
                if previous.raw_bytes != raw.bytes
                    || previous.value_kind
                        != (if raw.vtype == REG_SZ {
                            RegistryValueKind::String
                        } else {
                            RegistryValueKind::ExpandString
                        })
                {
                    reason = Some(
                        "同名启动项已被其他软件更新，保留的旧恢复记录不会覆盖新配置".to_string(),
                    );
                }
            }
            let mut entry = StartupEntry {
                id,
                name,
                command,
                target_path: None,
                source_kind: StartupSourceKind::Registry,
                source_label: source.label.to_string(),
                source_detail: format!(
                    "{}\\{}",
                    if source.scope == StartupScope::User {
                        "HKEY_CURRENT_USER"
                    } else {
                        "HKEY_LOCAL_MACHINE"
                    },
                    source.path
                ),
                scope: source.scope,
                enabled,
                can_toggle: reason.is_none(),
                managed: false,
                requires_elevation: source.scope == StartupScope::System,
                disabled_reason: reason,
                fingerprint: fingerprint(&(source.id, &raw_value(&raw), &approval)),
                can_reveal: false,
                can_reveal_source: false,
                target_exists: false,
                source_path: None,
                source_id: source.id.to_string(),
                approval,
            };
            let target = command_target(&entry.command);
            set_target(&mut entry, target);
            items.push(entry);
        }
    }
    for backup in &store.registry_items {
        if seen.contains(&backup.id) {
            continue;
        }
        let Some(source) = registry_source(&backup.source_id) else {
            continue;
        };
        let approval_result = read_approval(source.hive, source.approval_group, &backup.name);
        let approval = approval_result.as_ref().ok().cloned().flatten();
        let (_, mut reason) =
            approval_reason(approval_result.and_then(|value| approval_state(value.as_ref())));
        if approval != backup.approval {
            reason = Some("Windows 启动状态已被其他软件改变，请刷新并在系统设置中确认".to_string());
        }
        if failed.contains(source.id) {
            reason = Some("无法确认注册表当前状态，未开放恢复操作".to_string());
        }
        let mut entry = StartupEntry {
            id: backup.id.clone(),
            name: backup.name.clone(),
            command: backup.command.clone(),
            target_path: None,
            source_kind: StartupSourceKind::Registry,
            source_label: source.label.to_string(),
            source_detail: format!(
                "{}\\{} · 已由 DtKit 关闭",
                if source.scope == StartupScope::User {
                    "HKEY_CURRENT_USER"
                } else {
                    "HKEY_LOCAL_MACHINE"
                },
                source.path
            ),
            scope: source.scope,
            enabled: false,
            can_toggle: reason.is_none(),
            managed: true,
            requires_elevation: source.scope == StartupScope::System,
            disabled_reason: reason,
            fingerprint: fingerprint(&(
                source.id,
                &backup.raw_bytes,
                &backup.value_kind,
                &approval,
                "disabled",
            )),
            can_reveal: false,
            can_reveal_source: false,
            target_exists: false,
            source_path: None,
            source_id: source.id.to_string(),
            approval,
        };
        let target = command_target(&entry.command);
        set_target(&mut entry, target);
        items.push(entry);
    }
}

#[cfg(target_os = "windows")]
fn startup_directories() -> Vec<(StartupScope, &'static str, PathBuf)> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        FOLDERID_CommonStartup, FOLDERID_Startup, SHGetKnownFolderPath, KF_FLAG_DONT_VERIFY,
    };
    let mut directories = Vec::new();
    for (scope, label, id) in [
        (
            StartupScope::User,
            "当前用户 · 启动文件夹",
            FOLDERID_Startup,
        ),
        (
            StartupScope::System,
            "所有用户 · 启动文件夹",
            FOLDERID_CommonStartup,
        ),
    ] {
        unsafe {
            if let Ok(raw) = SHGetKnownFolderPath(&id, KF_FLAG_DONT_VERIFY, HANDLE::default()) {
                let path = raw.to_string().ok().map(PathBuf::from);
                CoTaskMemFree(Some(raw.0.cast()));
                if let Some(path) = path {
                    directories.push((scope, label, path));
                }
            }
        }
    }
    directories
}
#[cfg(not(target_os = "windows"))]
fn startup_directories() -> Vec<(StartupScope, &'static str, PathBuf)> {
    let mut directories = Vec::new();
    if let Some(path) = std::env::var_os("APPDATA") {
        directories.push((
            StartupScope::User,
            "当前用户 · 启动文件夹",
            PathBuf::from(path).join(r"Microsoft\Windows\Start Menu\Programs\Startup"),
        ));
    }
    if let Some(path) = std::env::var_os("PROGRAMDATA") {
        directories.push((
            StartupScope::System,
            "所有用户 · 启动文件夹",
            PathBuf::from(path).join(r"Microsoft\Windows\Start Menu\Programs\StartUp"),
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
    original_folder_path(path, disabled)
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("未命名启动项")
        .to_string()
}

fn disabled_folder_path(original: &Path) -> Option<PathBuf> {
    Some(
        original
            .parent()?
            .parent()?
            .join(DISABLED_DIRECTORY)
            .join(original.file_name()?),
    )
}

fn valid_folder_backup(record: &FolderBackup) -> bool {
    record.id == folder_id(record.scope, &record.original_path)
        && record.content_hash.len() == 64
        && record.content_hash.bytes().all(|ch| ch.is_ascii_hexdigit())
        && disabled_folder_path(&record.original_path).as_ref() == Some(&record.stored_path)
        && startup_directories().iter().any(|(scope, _, directory)| {
            *scope == record.scope && record.original_path.parent() == Some(directory.as_path())
        })
}

fn file_fingerprint(path: &Path) -> Result<String, String> {
    if !is_local_path(path) {
        return Err("远程或无法确认的启动文件位置未开放修改".to_string());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("读取启动文件信息失败: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("启动文件不是普通文件，未开放修改".to_string());
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("启动文件是重解析点，未开放修改".to_string());
        }
        Ok(fingerprint(&(
            metadata.len(),
            modified,
            metadata.creation_time(),
            metadata.file_attributes(),
        )))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(fingerprint(&(metadata.len(), modified)))
    }
}

fn content_hash(path: &Path) -> Result<String, String> {
    file_fingerprint(path)?;
    let mut file = fs::File::open(path).map_err(|error| format!("读取启动文件失败: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let len = file
            .read(&mut buffer)
            .map_err(|error| format!("读取启动文件失败: {error}"))?;
        if len == 0 {
            break;
        }
        digest.update(&buffer[..len]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn ordinary_local_directory(path: &Path) -> Result<bool, String> {
    if !is_local_path(path) {
        return Ok(false);
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("读取启动文件夹信息失败: {error}")),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(target_os = "windows")]
fn folder_approval(scope: StartupScope, name: &str) -> Result<Option<RawValue>, String> {
    read_approval(
        if scope == StartupScope::User {
            RegistryHive::CurrentUser
        } else {
            RegistryHive::LocalMachine
        },
        Some("StartupFolder"),
        name,
    )
}
#[cfg(not(target_os = "windows"))]
fn folder_approval(_scope: StartupScope, _name: &str) -> Result<Option<RawValue>, String> {
    Ok(None)
}

fn scan_startup_folders(
    store: &RegistryBackupStore,
    items: &mut Vec<StartupEntry>,
    warnings: &mut Vec<String>,
) {
    for (scope, label, directory) in startup_directories() {
        match ordinary_local_directory(&directory) {
            Ok(true) => {}
            Ok(false) => {
                warnings.push(format!(
                    "{label} 位于远程、重解析点或无法确认的磁盘，已跳过以避免扫描阻塞"
                ));
                continue;
            }
            Err(error) => {
                warnings.push(format!("{label}: {error}"));
                continue;
            }
        }
        let mut paths = Vec::new();
        match fs::read_dir(&directory) {
            Ok(entries) => {
                for (index, entry) in entries.take(MAX_SOURCE_ITEMS + 1).enumerate() {
                    if index == MAX_SOURCE_ITEMS {
                        warnings.push(format!("{label} 条目超过扫描上限"));
                        break;
                    }
                    match entry {
                        Ok(entry) if entry.file_type().is_ok_and(|kind| kind.is_file()) => {
                            paths.push(entry.path())
                        }
                        Ok(_) => {}
                        Err(error) => warnings.push(format!("枚举 {label} 失败: {error}")),
                    }
                }
                if paths.len() > MAX_SOURCE_ITEMS {
                    paths.truncate(MAX_SOURCE_ITEMS);
                    warnings.push(format!("{label} 条目超过扫描上限"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => warnings.push(format!("无法读取 {label}: {error}")),
        }
        let mut seen = HashSet::new();
        for path in paths {
            let legacy = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(DISABLED_SUFFIX));
            let original = original_folder_path(&path, legacy);
            if original
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("desktop.ini"))
            {
                continue;
            }
            let id = folder_id(scope, &original);
            if !seen.insert(id.clone()) {
                warnings.push(format!(
                    "{} 存在同名启用/停用文件，请在文件位置确认",
                    original.display()
                ));
                continue;
            }
            let record = store.folder_items.iter().find(|record| record.id == id);
            let mut entry =
                folder_entry(scope, label, &directory, &original, &path, legacy, record);
            if legacy && original.exists() {
                entry.can_toggle = false;
                entry.disabled_reason = Some("原位置已有同名文件，未开放恢复操作".to_string());
            }
            if record.is_some() && record.unwrap().stored_path.exists() && !legacy {
                entry.can_toggle = false;
                entry.disabled_reason =
                    Some("已保留的恢复文件与新启动文件同名，请在文件位置确认".to_string());
            }
            items.push(entry);
        }
        for record in store
            .folder_items
            .iter()
            .filter(|record| record.scope == scope)
        {
            if seen.contains(&record.id) {
                continue;
            }
            let mut entry = folder_entry(
                scope,
                label,
                &directory,
                &record.original_path,
                &record.stored_path,
                true,
                Some(record),
            );
            if !record.stored_path.is_file() {
                entry.can_toggle = false;
                entry.disabled_reason = Some("保留的启动文件已不存在，未开放恢复操作".to_string());
            }
            items.push(entry);
        }
    }
}

fn folder_entry(
    scope: StartupScope,
    label: &str,
    directory: &Path,
    original: &Path,
    current: &Path,
    disabled: bool,
    record: Option<&FolderBackup>,
) -> StartupEntry {
    let name = original
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let approval_result = folder_approval(scope, name);
    let approval = approval_result.as_ref().ok().cloned().flatten();
    let (approved, mut reason) =
        approval_reason(approval_result.and_then(|value| approval_state(value.as_ref())));
    let signature = file_fingerprint(current);
    if let Err(error) = &signature {
        reason = Some(error.clone());
    }
    if let Some(record) = record {
        if disabled && record.approval != approval {
            reason = Some("Windows 启动状态已被其他软件改变，请在系统设置中确认".to_string());
        }
    }
    let mut entry = StartupEntry {
        id: folder_id(scope, original),
        name: startup_display_name(original, false),
        command: original.to_string_lossy().to_string(),
        target_path: None,
        source_kind: StartupSourceKind::StartupFolder,
        source_label: label.to_string(),
        source_detail: directory.to_string_lossy().to_string(),
        scope,
        enabled: !disabled && approved,
        can_toggle: reason.is_none(),
        managed: disabled,
        requires_elevation: scope == StartupScope::System,
        disabled_reason: reason,
        fingerprint: fingerprint(&(original, current, signature.ok(), &approval, disabled)),
        can_reveal: false,
        can_reveal_source: false,
        target_exists: false,
        source_path: Some(current.to_path_buf()),
        source_id: if scope == StartupScope::User {
            "user-startup-folder"
        } else {
            "system-startup-folder"
        }
        .to_string(),
        approval,
    };
    let target = folder_target(current, original);
    set_target(&mut entry, target);
    entry
}

#[cfg(target_os = "windows")]
fn scan(layout: &StorageLayout) -> Result<StartupSnapshot, String> {
    let store = read_store(layout)?;
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    scan_registry(&store, &mut items, &mut warnings);
    scan_startup_folders(&store, &mut items, &mut warnings);
    warnings.truncate(100);
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

fn is_local_path(path: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::path::{Component, Prefix};
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDriveTypeW;
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return false;
        };
        let Prefix::Disk(letter) = prefix.kind() else {
            return false;
        };
        if components.next() != Some(Component::RootDir) {
            return false;
        }
        // The drive-type query uses only the root and does not contact a mapped share.
        let root = [letter as u16, ':' as u16, '\\' as u16, 0];
        matches!(unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) }, 2 | 3 | 6)
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.is_absolute()
    }
}

fn resolve_local_file(value: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(value.trim().trim_matches('"'));
    // Do not probe remote shares during an on-demand startup scan.
    if direct.as_os_str().is_empty() {
        return None;
    }
    if direct.is_absolute() {
        return (is_local_path(&direct) && direct.is_file()).then_some(direct);
    }
    if direct.components().count() != 1 {
        return None;
    }
    let extensions = if direct.extension().is_some() {
        vec![""]
    } else {
        vec!["", ".exe", ".com", ".bat", ".cmd"]
    };
    let paths = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&paths) {
        if !is_local_path(&directory) {
            continue;
        }
        for extension in &extensions {
            let resolved = directory.join(format!("{}{extension}", direct.display()));
            if resolved.is_file() {
                return Some(resolved);
            }
        }
    }
    None
}

fn command_target(command: &str) -> Option<PathBuf> {
    let expanded = expand_percent_variables(command.trim());
    if let Some(quoted) = expanded.strip_prefix('"') {
        return resolve_local_file(&quoted[..quoted.find('"')?]);
    }
    let lower = expanded.to_ascii_lowercase();
    let mut ends = Vec::new();
    for suffix in [".exe", ".com", ".bat", ".cmd", ".lnk"] {
        for (index, _) in lower.match_indices(suffix) {
            let end = index + suffix.len();
            if lower
                .as_bytes()
                .get(end)
                .is_none_or(|ch| ch.is_ascii_whitespace() || *ch == b'"')
            {
                ends.push(end);
            }
        }
    }
    ends.sort_unstable();
    for end in ends {
        if let Some(path) = resolve_local_file(expanded[..end].trim()) {
            return Some(path);
        }
    }
    resolve_local_file(expanded.split_whitespace().next().unwrap_or_default())
}

fn folder_target(current: &Path, original: &Path) -> Option<PathBuf> {
    if original
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
    {
        return shortcut_target(current);
    }
    if original
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["exe", "com", "bat", "cmd", "ps1", "vbs", "js"]
                .iter()
                .any(|kind| extension.eq_ignore_ascii_case(kind))
        })
    {
        return (is_local_path(current) && current.is_file()).then(|| current.to_path_buf());
    }
    None
}

#[cfg(target_os = "windows")]
fn shortcut_target(path: &Path) -> Option<PathBuf> {
    if !is_local_path(path) {
        return None;
    }
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() && initialized.0 != 0x80010106u32 as i32 {
            return None;
        }
        let _guard = ComGuard(initialized.is_ok());
        let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persistent: IPersistFile = shell.cast().ok()?;
        let wide = path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        persistent.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
        let mut buffer = [0u16; 32768];
        // Never Resolve(): that can search networks, display dialogs, or rewrite the link.
        shell
            .GetPath(&mut buffer, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .ok()?;
        let end = buffer.iter().position(|value| *value == 0)?;
        resolve_local_file(&expand_percent_variables(&String::from_utf16_lossy(
            &buffer[..end],
        )))
    }
}
#[cfg(not(target_os = "windows"))]
fn shortcut_target(_path: &Path) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "windows")]
fn reveal_local_file(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialized.is_err() && initialized.0 != 0x80010106u32 as i32 {
            return Err(format!("文件定位服务初始化失败: {initialized:?}"));
        }
        let _guard = ComGuard(initialized.is_ok());
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let pidl = ILCreateFromPathW(PCWSTR(wide.as_ptr()));
        if pidl.is_null() {
            return Err("无法解析文件在资源管理器中的位置，请刷新后重试".to_string());
        }
        // With zero child PIDLs, the file PIDL opens its parent and selects the file.
        let result = SHOpenFolderAndSelectItems(pidl, None, 0);
        ILFree(Some(pidl));
        result.map_err(|error| format!("打开文件位置失败: {error}"))
    }
}

#[cfg(target_os = "windows")]
fn optional_registry_value(key: &RegKey, name: &str) -> Result<Option<RegValue>, String> {
    match key.get_raw_value(name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取启动项当前值失败: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn disable_registry(layout: &StorageLayout, entry: &StartupEntry) -> Result<(), String> {
    let source = registry_source(&entry.source_id).ok_or_else(|| "启动项来源已失效".to_string())?;
    let key = root_key(source.hive)
        .open_subkey_with_flags(source.path, KEY_READ | KEY_SET_VALUE | source.view)
        .map_err(|error| permission_message("打开", source, error))?;
    disable_registry_using(
        layout,
        entry,
        &mut NativeStartupValue {
            key,
            source,
            name: entry.name.clone(),
        },
    )
}

trait StartupValue {
    fn current(&mut self) -> Result<Option<RawValue>, String>;
    fn approval(&mut self) -> Result<Option<RawValue>, String>;
    fn remove(&mut self) -> Result<(), String>;
    fn restore(&mut self, value: &RawValue) -> Result<(), String>;
}

#[cfg(target_os = "windows")]
struct NativeStartupValue {
    key: RegKey,
    source: RegistrySource,
    name: String,
}

#[cfg(target_os = "windows")]
impl StartupValue for NativeStartupValue {
    fn current(&mut self) -> Result<Option<RawValue>, String> {
        Ok(optional_registry_value(&self.key, &self.name)?
            .as_ref()
            .map(raw_value))
    }
    fn approval(&mut self) -> Result<Option<RawValue>, String> {
        read_approval(self.source.hive, self.source.approval_group, &self.name)
    }
    fn remove(&mut self) -> Result<(), String> {
        self.key
            .delete_value(&self.name)
            .map_err(|error| permission_message("关闭", self.source, error))
    }
    fn restore(&mut self, value: &RawValue) -> Result<(), String> {
        let raw = RegValue {
            bytes: value.bytes.clone(),
            vtype: match value.kind {
                1 => REG_SZ,
                2 => REG_EXPAND_SZ,
                _ => return Err("恢复命令类型无效".to_string()),
            },
        };
        self.key
            .set_raw_value(&self.name, &raw)
            .map_err(|error| permission_message("恢复", self.source, error))
    }
}

fn disable_registry_using(
    layout: &StorageLayout,
    entry: &StartupEntry,
    value: &mut impl StartupValue,
) -> Result<(), String> {
    let raw = value
        .current()?
        .ok_or_else(|| "启动项已被删除，请刷新后重试".to_string())?;
    let approval = value.approval()?;
    if fingerprint(&(entry.source_id.as_str(), &raw, &approval)) != entry.fingerprint {
        return Err("启动项已被其他软件修改，请刷新后重试".to_string());
    }
    if !approval_state(approval.as_ref())? {
        return Err("启动项已由 Windows 或其他软件关闭，未覆盖其状态".to_string());
    }
    let (command, value_kind) =
        decode_raw_command(&raw).ok_or_else(|| "只支持管理文本类型的注册表启动项".to_string())?;
    let mut store = read_store(layout)?;
    if let Some(old) = store.registry_items.iter().find(|item| item.id == entry.id) {
        if old.raw_bytes != raw.bytes || old.value_kind != value_kind {
            return Err("已保留同名项的恢复记录，未覆盖它".to_string());
        }
    }
    store.registry_items.retain(|item| item.id != entry.id);
    store.registry_items.push(RegistryBackup {
        id: entry.id.clone(),
        source_id: entry.source_id.clone(),
        name: entry.name.clone(),
        command,
        value_kind,
        raw_bytes: raw.bytes.clone(),
        disabled_at: Utc::now().timestamp_millis(),
        approval: approval.clone(),
    });
    write_store(layout, &store)?;
    // Keep the durable recovery record after interruption or a failed registry write.
    if value.current()? != Some(raw) || value.approval()? != approval {
        return Err("启动项在操作期间发生变化，已保留恢复信息且未关闭".to_string());
    }
    value.remove()
}

#[cfg(target_os = "windows")]
fn enable_registry(layout: &StorageLayout, entry: &StartupEntry) -> Result<(), String> {
    let source = registry_source(&entry.source_id).ok_or_else(|| "启动项来源已失效".to_string())?;
    // A missing Run key can be recreated, but never overwrite an existing value.
    let (key, _) = root_key(source.hive)
        .create_subkey_with_flags(source.path, KEY_READ | KEY_SET_VALUE | source.view)
        .map_err(|error| permission_message("打开", source, error))?;
    enable_registry_using(
        layout,
        entry,
        &mut NativeStartupValue {
            key,
            source,
            name: entry.name.clone(),
        },
    )
}

fn enable_registry_using(
    layout: &StorageLayout,
    entry: &StartupEntry,
    value: &mut impl StartupValue,
) -> Result<(), String> {
    let mut store = read_store(layout)?;
    let backup = store
        .registry_items
        .iter()
        .find(|item| item.id == entry.id)
        .cloned()
        .ok_or_else(|| "找不到启动项的恢复信息".to_string())?;
    if value.current()?.is_some() {
        return Err("原位置已有同名启动项，未覆盖新配置".to_string());
    }
    if value.approval()? != backup.approval {
        return Err("Windows 启动状态已发生变化，未执行恢复".to_string());
    }
    let raw = RawValue {
        bytes: backup.raw_bytes,
        kind: match backup.value_kind {
            RegistryValueKind::String => 1,
            RegistryValueKind::ExpandString => 2,
        },
    };
    if value.current()?.is_some() {
        return Err("原位置在恢复期间新增了同名启动项，未覆盖新配置".to_string());
    }
    value.restore(&raw)?;
    store.registry_items.retain(|item| item.id != entry.id);
    // Do not delete a successfully restored value merely because journal cleanup fails.
    write_store(layout, &store)
        .map_err(|error| format!("启动项已恢复，但清理恢复记录失败，请刷新确认状态: {error}"))
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

fn set_folder_enabled(
    layout: &StorageLayout,
    entry: &StartupEntry,
    enabled: bool,
) -> Result<(), String> {
    let current = entry
        .source_path
        .as_ref()
        .ok_or_else(|| "启动文件路径已失效".to_string())?;
    let mut store = read_store(layout)?;
    let record = store
        .folder_items
        .iter()
        .find(|item| item.id == entry.id)
        .cloned();
    let original = if let Some(record) = &record {
        record.original_path.clone()
    } else {
        original_folder_path(current, enabled)
    };
    if !startup_directories().iter().any(|(scope, _, directory)| {
        *scope == entry.scope && original.parent() == Some(directory.as_path())
    }) {
        return Err("启动文件来源无效".to_string());
    }
    let destination = if enabled {
        original.clone()
    } else {
        disabled_folder_path(&original).ok_or_else(|| "启动文件保留位置无效".to_string())?
    };
    if !ordinary_local_directory(
        current
            .parent()
            .ok_or_else(|| "启动文件路径无效".to_string())?,
    )? || !ordinary_local_directory(
        destination
            .parent()
            .ok_or_else(|| "启动文件目标路径无效".to_string())?,
    )? {
        return Err("启动文件夹或保留目录不是普通本地目录，未移动文件".to_string());
    }
    if destination.exists() {
        return Err("目标位置已有同名启动文件，未覆盖任何文件".to_string());
    }
    let signature = file_fingerprint(current)?;
    if fingerprint(&(
        &original,
        current,
        Some(signature.clone()),
        &entry.approval,
        !entry.enabled,
    )) != entry.fingerprint
    {
        return Err("启动文件已发生变化，请刷新后重试".to_string());
    }
    let hash = content_hash(current)?;
    if enabled {
        if let Some(record) = &record {
            if record.content_hash != hash {
                return Err("保留的启动文件内容已被其他软件改变，未执行恢复".to_string());
            }
        }
    } else {
        store.folder_items.retain(|item| item.id != entry.id);
        store.folder_items.push(FolderBackup {
            id: entry.id.clone(),
            scope: entry.scope,
            original_path: original.clone(),
            stored_path: destination.clone(),
            content_hash: hash.clone(),
            disabled_at: Utc::now().timestamp_millis(),
            approval: entry.approval.clone(),
        });
        write_store(layout, &store)?;
        fs::create_dir_all(destination.parent().unwrap())
            .map_err(|error| format!("创建启动文件保留目录失败: {error}"))?;
    }
    let approval = folder_approval(
        entry.scope,
        original
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
    )?;
    if file_fingerprint(current)? != signature || approval != entry.approval {
        return Err("启动文件或 Windows 状态在操作期间发生变化，未移动文件".to_string());
    }
    move_file_without_overwrite(current, &destination).map_err(|error| {
        if entry.requires_elevation && error.kind() == std::io::ErrorKind::PermissionDenied {
            "管理所有用户的启动文件夹需要管理员权限".to_string()
        } else {
            format!("移动启动文件失败: {error}")
        }
    })?;
    if enabled {
        store.folder_items.retain(|item| item.id != entry.id);
        write_store(layout, &store).map_err(|error| {
            format!("启动文件已恢复，但清理恢复记录失败，请刷新确认状态: {error}")
        })?;
    }
    Ok(())
}

fn move_file_without_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::MoveFileW;
        let from = source
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let to = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        // MoveFileW rejects an existing destination atomically; fs::rename may replace it.
        unsafe { MoveFileW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr())) }.map_err(|error| {
            std::io::Error::from_raw_os_error((error.code().0 as u32 & 0xffff) as i32)
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Scanning is Windows-only; retain non-overwrite semantics for isolated tests.
        fs::hard_link(source, destination)?;
        fs::remove_file(source)
    }
}

fn authorize(window: &WebviewWindow, tool_id: &str) -> Result<(), String> {
    if window.label() != "main" && !window.label().starts_with("quick-host-") {
        return Err("当前窗口不能管理启动项".to_string());
    }
    authorize_module(window.app_handle(), tool_id)
}
fn authorize_module(app: &tauri::AppHandle, tool_id: &str) -> Result<(), String> {
    if !matches!(tool_id, "system-assistant" | "startup-manager") {
        return Err("启动项工具来源无效".to_string());
    }
    if !app.state::<ToolModuleManager>().is_enabled(tool_id) {
        return Err("启动项管理工具已关闭".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn scan_system_startup_items(
    window: WebviewWindow,
    tool_id: String,
) -> Result<StartupSnapshot, String> {
    authorize(&window, &tool_id)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<SystemAssistantManager>();
        let _guard = manager.migration_guard()?;
        authorize_module(&app, &tool_id)?;
        let layout = app.state::<StorageManager>().layout()?;
        scan(&layout)
    })
    .await
    .map_err(|error| format!("启动项扫描任务异常: {error}"))?
}

#[tauri::command]
pub(crate) async fn set_system_startup_enabled(
    window: WebviewWindow,
    tool_id: String,
    id: String,
    enabled: bool,
    expected_fingerprint: String,
) -> Result<StartupSnapshot, String> {
    authorize(&window, &tool_id)?;
    let app = window.app_handle().clone();
    let _work = super::launch::keep_native_work(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<SystemAssistantManager>();
        let _guard = manager.migration_guard()?;
        authorize_module(&app, &tool_id)?;
        let layout = app.state::<StorageManager>().layout()?;
        let snapshot = scan(&layout)?;
        let entry = snapshot
            .items
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "启动项已变化，请刷新后重试".to_string())?;
        if entry.fingerprint != expected_fingerprint {
            return Err("启动项已被其他软件修改，请刷新后重试".to_string());
        }
        if !entry.can_toggle {
            return Err(entry
                .disabled_reason
                .clone()
                .unwrap_or_else(|| "该启动项暂不支持更改".to_string()));
        }
        if entry.enabled == enabled {
            return Ok(snapshot);
        }
        match entry.source_kind {
            StartupSourceKind::Registry => {
                #[cfg(target_os = "windows")]
                if enabled {
                    enable_registry(&layout, entry)?;
                } else {
                    disable_registry(&layout, entry)?;
                }
                #[cfg(not(target_os = "windows"))]
                return Err("开机启动管理目前仅支持 Windows".to_string());
            }
            StartupSourceKind::StartupFolder => set_folder_enabled(&layout, entry, enabled)?,
        }
        scan(&layout)
    })
    .await
    .map_err(|error| format!("启动项操作任务异常: {error}"))?
}

#[tauri::command]
pub(crate) async fn reveal_system_startup_item(
    window: WebviewWindow,
    tool_id: String,
    id: String,
    target: Option<String>,
) -> Result<(), String> {
    authorize(&window, &tool_id)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<SystemAssistantManager>();
        let _guard = manager.migration_guard()?;
        authorize_module(&app, &tool_id)?;
        let snapshot = scan(&app.state::<StorageManager>().layout()?)?;
        let entry = snapshot
            .items
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "启动项已变化，请刷新后重试".to_string())?;
        let path = match target.as_deref().unwrap_or("program") {
            "program" => entry.target_path.as_ref().map(PathBuf::from),
            "source" => entry.source_path.clone(),
            _ => return Err("文件定位类型无效".to_string()),
        }
        .filter(|path| is_local_path(path) && path.is_file())
        .ok_or_else(|| "该启动项没有可定位的本地文件".to_string())?;
        #[cfg(target_os = "windows")]
        {
            reveal_local_file(&path)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = path;
            Err("开机启动管理目前仅支持 Windows".to_string())
        }
    })
    .await
    .map_err(|error| format!("文件定位任务异常: {error}"))?
}

#[tauri::command]
pub(crate) async fn open_system_startup_settings(
    window: WebviewWindow,
    tool_id: String,
) -> Result<(), String> {
    authorize(&window, &tool_id)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        authorize_module(&app, &tool_id)?;
        #[cfg(target_os = "windows")]
        {
            opener::open("ms-settings:startupapps")
                .map_err(|error| format!("打开 Windows 启动设置失败: {error}"))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err("开机启动管理目前仅支持 Windows".to_string())
        }
    })
    .await
    .map_err(|error| format!("启动设置任务异常: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::storage::StorageMode;

    fn temporary_layout() -> (StorageLayout, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("dtkit-startup-test-{}", uuid::Uuid::new_v4()));
        (
            StorageLayout::from_root(StorageMode::Standard, root.clone()),
            root,
        )
    }

    fn text_bytes(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect()
    }
    fn backup() -> RegistryBackup {
        RegistryBackup {
            id: registry_id("hkcu-run", "Example"),
            source_id: "hkcu-run".to_string(),
            name: "Example".to_string(),
            command: r"C:\Example.exe".to_string(),
            value_kind: RegistryValueKind::String,
            raw_bytes: text_bytes(r"C:\Example.exe"),
            disabled_at: 1,
            approval: None,
        }
    }

    #[derive(Default)]
    struct FakeStartupValue {
        raw: Option<RawValue>,
        approval: Option<RawValue>,
        reads: usize,
        change_on_second_read: Option<RawValue>,
        remove_error: bool,
        restore_error: bool,
        journal_to_observe: Option<PathBuf>,
        break_cleanup: Option<PathBuf>,
        writes: usize,
    }

    impl StartupValue for FakeStartupValue {
        fn current(&mut self) -> Result<Option<RawValue>, String> {
            self.reads += 1;
            if self.reads == 2 {
                if let Some(value) = self.change_on_second_read.take() {
                    self.raw = Some(value);
                }
            }
            Ok(self.raw.clone())
        }
        fn approval(&mut self) -> Result<Option<RawValue>, String> {
            Ok(self.approval.clone())
        }
        fn remove(&mut self) -> Result<(), String> {
            // Mutation must observe a committed recovery record, not a temporary file.
            if let Some(path) = &self.journal_to_observe {
                let store: RegistryBackupStore =
                    serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                assert_eq!(store.registry_items.len(), 1);
            }
            self.writes += 1;
            if self.remove_error {
                return Err("simulated registry permission failure".to_string());
            }
            self.raw = None;
            Ok(())
        }
        fn restore(&mut self, value: &RawValue) -> Result<(), String> {
            self.writes += 1;
            if self.restore_error {
                return Err("simulated registry restore failure".to_string());
            }
            self.raw = Some(value.clone());
            if let Some(path) = &self.break_cleanup {
                fs::remove_file(path).unwrap();
                fs::create_dir(path).unwrap();
            }
            Ok(())
        }
    }

    fn transaction_entry(raw: &RawValue) -> StartupEntry {
        let item = backup();
        StartupEntry {
            id: item.id,
            name: item.name,
            command: item.command,
            target_path: None,
            source_kind: StartupSourceKind::Registry,
            source_label: "test".to_string(),
            source_detail: "test".to_string(),
            scope: StartupScope::User,
            enabled: true,
            can_toggle: true,
            managed: false,
            requires_elevation: false,
            disabled_reason: None,
            fingerprint: fingerprint(&("hkcu-run", raw, None::<RawValue>)),
            can_reveal: false,
            can_reveal_source: false,
            target_exists: false,
            source_path: None,
            source_id: "hkcu-run".to_string(),
            approval: None,
        }
    }

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
        assert_eq!(
            command_target(&format!("\"{}\" --background", executable.display())),
            Some(executable)
        );
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
    #[test]
    fn windows_approval_states_are_conservative() {
        assert_eq!(approval_state(None), Ok(true));
        for (state, enabled) in [(2u32, true), (3, false), (6, true), (7, false)] {
            let mut bytes = vec![0; 12];
            bytes[..4].copy_from_slice(&state.to_le_bytes());
            assert_eq!(
                approval_state(Some(&RawValue { kind: 3, bytes })),
                Ok(enabled)
            );
        }
        assert!(approval_state(Some(&RawValue {
            kind: 3,
            bytes: vec![0; 12]
        }))
        .is_err());
        assert!(approval_state(Some(&RawValue {
            kind: 1,
            bytes: vec![2; 12]
        }))
        .is_err());
        assert!(approval_state(Some(&RawValue {
            kind: 3,
            bytes: vec![2; 4]
        }))
        .is_err());
    }
    #[test]
    fn legacy_backup_store_is_compatible() {
        let item = backup();
        let json = serde_json::json!({"version":1,"registryItems":[item]});
        let store: RegistryBackupStore = serde_json::from_value(json).unwrap();
        assert!(store.folder_items.is_empty());
        validate_store(&store).unwrap();
    }
    #[test]
    fn raw_command_and_duplicate_records_are_validated() {
        let mut store = RegistryBackupStore::default();
        store.registry_items.push(backup());
        validate_store(&store).unwrap();
        store.registry_items[0].command = "Other command".to_string();
        assert!(validate_store(&store).is_err());
        store.registry_items[0] = backup();
        store.registry_items.push(backup());
        assert!(validate_store(&store).is_err());
    }
    #[test]
    fn store_is_replaced_atomically_and_oversize_read_is_rejected() {
        let (layout, root) = temporary_layout();
        let mut store = RegistryBackupStore::default();
        store.registry_items.push(backup());
        write_store(&layout, &store).unwrap();
        assert_eq!(read_store(&layout).unwrap().registry_items.len(), 1);
        write_store(&layout, &RegistryBackupStore::default()).unwrap();
        assert!(read_store(&layout).unwrap().registry_items.is_empty());
        let file = fs::File::create(store_path(&layout)).unwrap();
        file.set_len((MAX_STORE_BYTES + 1) as u64).unwrap();
        assert!(read_store(&layout).unwrap_err().contains("8 MiB"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changed_raw_value_or_approval_changes_fingerprint() {
        let a = RawValue {
            kind: 1,
            bytes: text_bytes("a.exe"),
        };
        let b = RawValue {
            kind: 2,
            bytes: text_bytes("a.exe"),
        };
        assert_ne!(
            fingerprint(&("hkcu-run", &a, None::<RawValue>)),
            fingerprint(&("hkcu-run", &b, None::<RawValue>))
        );
        assert_ne!(
            fingerprint(&("hkcu-run", &a, None::<RawValue>)),
            fingerprint(&(
                "hkcu-run",
                &a,
                Some(RawValue {
                    kind: 3,
                    bytes: vec![3; 12]
                })
            ))
        );
    }
    #[test]
    fn new_folder_storage_is_outside_startup_directory() {
        let path = PathBuf::from(r"C:\Programs\Startup\App.lnk");
        assert_eq!(
            disabled_folder_path(&path),
            Some(PathBuf::from(r"C:\Programs\DtKitDisabledStartup\App.lnk"))
        );
    }
    #[test]
    fn file_signature_and_hash_detect_edits_without_loading_whole_file() {
        let (_, root) = temporary_layout();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("item.lnk");
        fs::write(&path, b"original").unwrap();
        let before = file_fingerprint(&path).unwrap();
        let hash = content_hash(&path).unwrap();
        fs::write(&path, b"changed-longer").unwrap();
        assert_ne!(before, file_fingerprint(&path).unwrap());
        assert_ne!(hash, content_hash(&path).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn registry_disable_commits_recovery_before_mutation_and_restores_exact_bytes() {
        let (layout, root) = temporary_layout();
        // Preserve REG_EXPAND_SZ and its original UTF-16 terminators verbatim.
        let mut bytes = text_bytes(r"%LOCALAPPDATA%\Example.exe");
        bytes.extend([0, 0]);
        let original = RawValue { kind: 2, bytes };
        let entry = transaction_entry(&original);
        let mut value = FakeStartupValue {
            raw: Some(original.clone()),
            journal_to_observe: Some(store_path(&layout)),
            ..Default::default()
        };
        disable_registry_using(&layout, &entry, &mut value).unwrap();
        assert!(value.raw.is_none());
        let store = read_store(&layout).unwrap();
        assert_eq!(store.registry_items[0].raw_bytes, original.bytes);
        assert_eq!(
            store.registry_items[0].value_kind,
            RegistryValueKind::ExpandString
        );
        enable_registry_using(&layout, &entry, &mut value).unwrap();
        assert_eq!(value.raw, Some(original));
        assert!(read_store(&layout).unwrap().registry_items.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_recovery_file_prevents_registry_mutation() {
        let (layout, root) = temporary_layout();
        let path = store_path(&layout);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"broken journal").unwrap();
        let original = RawValue {
            kind: 1,
            bytes: text_bytes(r"C:\Example.exe"),
        };
        let entry = transaction_entry(&original);
        let mut value = FakeStartupValue {
            raw: Some(original.clone()),
            ..Default::default()
        };
        assert!(disable_registry_using(&layout, &entry, &mut value).is_err());
        assert_eq!(value.raw, Some(original));
        assert_eq!(value.writes, 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_registry_disable_keeps_durable_recovery_for_retry() {
        let (layout, root) = temporary_layout();
        let original = RawValue {
            kind: 1,
            bytes: text_bytes(r"C:\Example.exe"),
        };
        let entry = transaction_entry(&original);
        let mut value = FakeStartupValue {
            raw: Some(original.clone()),
            remove_error: true,
            ..Default::default()
        };
        assert!(disable_registry_using(&layout, &entry, &mut value).is_err());
        assert_eq!(value.raw, Some(original));
        assert_eq!(read_store(&layout).unwrap().registry_items.len(), 1);
        value.remove_error = false;
        disable_registry_using(&layout, &entry, &mut value).unwrap();
        assert!(value.raw.is_none());
        assert_eq!(read_store(&layout).unwrap().registry_items.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changed_registry_value_after_journaling_is_not_deleted() {
        let (layout, root) = temporary_layout();
        let original = RawValue {
            kind: 1,
            bytes: text_bytes(r"C:\Example.exe"),
        };
        let entry = transaction_entry(&original);
        let changed = RawValue {
            kind: 1,
            bytes: text_bytes(r"C:\New.exe"),
        };
        let mut value = FakeStartupValue {
            raw: Some(original.clone()),
            change_on_second_read: Some(changed.clone()),
            ..Default::default()
        };
        assert!(disable_registry_using(&layout, &entry, &mut value)
            .unwrap_err()
            .contains("发生变化"));
        assert_eq!(value.raw, Some(changed));
        assert_eq!(value.writes, 0);
        assert_eq!(
            read_store(&layout).unwrap().registry_items[0].raw_bytes,
            original.bytes
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restoring_rejects_same_name_values_and_external_approval_changes() {
        let (layout, root) = temporary_layout();
        let mut store = RegistryBackupStore::default();
        store.registry_items.push(backup());
        write_store(&layout, &store).unwrap();
        let raw = RawValue {
            kind: 1,
            bytes: text_bytes(r"C:\New.exe"),
        };
        let entry = transaction_entry(&raw);
        let mut value = FakeStartupValue {
            raw: Some(raw.clone()),
            ..Default::default()
        };
        assert!(enable_registry_using(&layout, &entry, &mut value)
            .unwrap_err()
            .contains("同名"));
        assert_eq!(value.raw, Some(raw.clone()));
        assert_eq!(value.writes, 0);
        value.raw = None;
        value.approval = Some(RawValue {
            kind: 3,
            bytes: vec![3; 12],
        });
        assert!(enable_registry_using(&layout, &entry, &mut value)
            .unwrap_err()
            .contains("Windows"));
        assert_eq!(value.writes, 0);
        value.approval = None;
        value.reads = 0;
        value.change_on_second_read = Some(raw.clone());
        assert!(enable_registry_using(&layout, &entry, &mut value)
            .unwrap_err()
            .contains("恢复期间"));
        assert_eq!(value.raw, Some(raw));
        assert_eq!(value.writes, 0);
        assert_eq!(read_store(&layout).unwrap().registry_items.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restoring_write_failure_retains_record_and_cleanup_failure_retains_restored_value() {
        let (layout, root) = temporary_layout();
        let mut store = RegistryBackupStore::default();
        store.registry_items.push(backup());
        write_store(&layout, &store).unwrap();
        let original = RawValue {
            kind: 1,
            bytes: text_bytes(r"C:\Example.exe"),
        };
        let entry = transaction_entry(&original);
        let mut value = FakeStartupValue {
            restore_error: true,
            ..Default::default()
        };
        assert!(enable_registry_using(&layout, &entry, &mut value).is_err());
        assert!(value.raw.is_none());
        assert_eq!(read_store(&layout).unwrap().registry_items.len(), 1);
        value.restore_error = false;
        value.break_cleanup = Some(store_path(&layout));
        assert!(enable_registry_using(&layout, &entry, &mut value)
            .unwrap_err()
            .contains("已恢复"));
        assert_eq!(value.raw, Some(original));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oversized_new_journal_is_rejected_before_replacing_existing_record() {
        let (layout, root) = temporary_layout();
        let mut store = RegistryBackupStore::default();
        store.registry_items.push(backup());
        write_store(&layout, &store).unwrap();
        let previous = fs::read(store_path(&layout)).unwrap();
        let mut oversized = RegistryBackupStore::default();
        for index in 0..100 {
            let name = format!("item-{index}");
            let command = "x".repeat(30000);
            oversized.registry_items.push(RegistryBackup {
                id: registry_id("hkcu-run", &name),
                source_id: "hkcu-run".to_string(),
                name,
                raw_bytes: text_bytes(&command),
                command,
                value_kind: RegistryValueKind::String,
                disabled_at: 1,
                approval: None,
            });
        }
        assert!(write_store(&layout, &oversized)
            .unwrap_err()
            .contains("8 MiB"));
        assert_eq!(fs::read(store_path(&layout)).unwrap(), previous);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn isolated_file_move_rejects_existing_destination_and_preserves_unicode_paths() {
        let (_, root) = temporary_layout();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("启动 文件,原.lnk");
        let destination = root.join("关闭 文件,存.lnk");
        fs::write(&source, b"original source").unwrap();
        fs::write(&destination, b"another file").unwrap();
        assert!(move_file_without_overwrite(&source, &destination).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"original source");
        assert_eq!(fs::read(&destination).unwrap(), b"another file");
        fs::remove_file(&destination).unwrap();
        move_file_without_overwrite(&source, &destination).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"original source");
        move_file_without_overwrite(&destination, &source).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"original source");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn externally_disabled_registry_entry_is_not_removed_or_journaled() {
        let (layout, root) = temporary_layout();
        let raw = RawValue {
            kind: 1,
            bytes: text_bytes(r"C:\Example.exe"),
        };
        let mut bytes = vec![0; 12];
        bytes[..4].copy_from_slice(&3u32.to_le_bytes());
        let approval = Some(RawValue { kind: 3, bytes });
        let mut entry = transaction_entry(&raw);
        entry.fingerprint = fingerprint(&("hkcu-run", &raw, &approval));
        let mut value = FakeStartupValue {
            raw: Some(raw.clone()),
            approval,
            ..Default::default()
        };
        assert!(disable_registry_using(&layout, &entry, &mut value)
            .unwrap_err()
            .contains("其他软件关闭"));
        assert_eq!(value.writes, 0);
        assert_eq!(value.raw, Some(raw));
        assert!(!store_path(&layout).exists());
        if root.exists() {
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn remote_and_device_paths_are_rejected_without_file_probes() {
        for value in [
            r"\\server\share\app.exe",
            r#"  "\\server\share\app.exe"  "#,
            r"\\?\UNC\server\share\app.exe",
            r"\\.\C:\app.exe",
        ] {
            assert!(resolve_local_file(value).is_none());
        }
    }
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "read-only native startup registry diagnostic"]
    fn windows_scan_produces_consistent_summary_without_mutating_sources() {
        let (layout, root) = temporary_layout();
        let started = std::time::Instant::now();
        let snapshot = scan(&layout).unwrap();
        assert_eq!(snapshot.total, snapshot.items.len());
        assert_eq!(snapshot.total, snapshot.enabled + snapshot.disabled);
        assert_eq!(snapshot.total, snapshot.user_items + snapshot.system_items);
        println!("startup read-only scan: total={} enabled={} disabled={} readOnly={} warnings={} elapsedMs={}", snapshot.total, snapshot.enabled, snapshot.disabled, snapshot.read_only, snapshot.warnings.len(), started.elapsed().as_millis());
        for entry in &snapshot.items {
            assert!(!entry.fingerprint.is_empty());
            assert_eq!(entry.can_reveal, entry.target_path.is_some());
        }
        if root.exists() {
            fs::remove_dir_all(root).unwrap();
        }
    }
}
