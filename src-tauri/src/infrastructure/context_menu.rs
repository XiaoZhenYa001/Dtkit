use super::{storage::StorageManager, tool_modules::ToolModuleManager};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tauri::{Manager, WebviewWindow};

#[cfg(target_os = "windows")]
mod native;

const JOURNAL_VERSION: u8 = 1;
const MAX_JOURNAL_BYTES: usize = 8 * 1024 * 1024;
const BLOCKED_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Blocked";

#[derive(Default)]
pub(crate) struct ContextMenuManager(Mutex<()>);
impl ContextMenuManager {
    pub(crate) fn migration_guard(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.0
            .lock()
            .map_err(|_| "右键菜单管理状态不可用".to_owned())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Location {
    system: bool,
    view: u32,
    path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RawValue {
    kind: u32,
    bytes: Vec<u8>,
}
impl RawValue {
    fn text(value: &str) -> Self {
        Self {
            kind: 1,
            bytes: value
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    location: Location,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextMenuEntry {
    id: String,
    name: String,
    categories: Vec<String>,
    kind: String,
    scope: String,
    enabled: bool,
    can_toggle: bool,
    managed: bool,
    requires_elevation: bool,
    registry_path: String,
    command: String,
    detail: String,
    disabled_reason: Option<String>,
    clsid: Option<String>,
    fingerprint: String,
    #[serde(skip)]
    registration: String,
    #[serde(skip)]
    marker: Option<Marker>,
    #[serde(skip)]
    marker_value: Option<RawValue>,
    #[serde(skip)]
    sources: Vec<Location>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextMenuSnapshot {
    items: Vec<ContextMenuEntry>,
    total: usize,
    enabled: usize,
    disabled: usize,
    read_only: usize,
    scanned_at: i64,
    warnings: Vec<String>,
    extension: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    entry: ContextMenuEntry,
    sources: Vec<Location>,
    registration: String,
    marker: Marker,
    before: Option<RawValue>,
    applied: RawValue,
    restoring: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Journal {
    version: u8,
    records: Vec<Record>,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            version: JOURNAL_VERSION,
            records: Vec::new(),
        }
    }
}

fn normalize_extension(value: Option<String>) -> Result<Option<String>, String> {
    let value = value.unwrap_or_default().trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    let value = if value.starts_with('.') {
        value
    } else {
        format!(".{value}")
    };
    if !(2..=32).contains(&value.len())
        || !value.as_bytes()[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
    {
        return Err("请输入有效的单个文件扩展名，例如 .pdf 或 .txt".into());
    }
    Ok(Some(value))
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn stable_id(location: &Location) -> String {
    hash(
        format!(
            "{}:{}:{}",
            location.system,
            location.view,
            location.path.to_lowercase()
        )
        .as_bytes(),
    )
}
fn fingerprint(entry: &ContextMenuEntry) -> String {
    hash(
        serde_json::to_vec(&(
            &entry.registration,
            &entry.marker_value,
            entry.enabled,
            entry.can_toggle,
            entry.managed,
            &entry.disabled_reason,
        ))
        .unwrap_or_default()
        .as_slice(),
    )
}

fn apply_record(entry: &mut ContextMenuEntry, record: &Record, owned_registration: Option<String>) {
    if entry.marker_value == Some(record.applied.clone()) {
        entry.managed = true;
        if let Some(registration) = owned_registration {
            // An expanded scan may discover additional uses of the same CLSID.
            // Restore checks the original registrations and COM server; changing
            // the scan scope alone must not invalidate the recovery record.
            entry.registration = registration;
            entry.sources = record.sources.clone();
        }
        if entry.registration != record.registration {
            entry.can_toggle = false;
            entry.disabled_reason =
                Some("菜单注册自关闭后发生变化，保留恢复记录，仅支持查看".into());
        }
    } else if entry.marker_value != record.before {
        entry.can_toggle = false;
        entry.disabled_reason = Some("关闭标记已被其他软件更改，仅支持查看".into());
    }
}

fn read_journal(path: &Path) -> Result<Journal, String> {
    let mut bytes = Vec::new();
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Journal::default()),
        Err(error) => return Err(format!("读取菜单恢复记录失败：{error}")),
    };
    file.take(MAX_JOURNAL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取菜单恢复记录失败：{e}"))?;
    if bytes.len() > MAX_JOURNAL_BYTES {
        return Err("菜单恢复记录过大，未进行更改".into());
    }
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|e| format!("菜单恢复记录损坏，已停止更改以保留恢复信息：{e}"))?;
    if journal.version != JOURNAL_VERSION || journal.records.len() > 4096 {
        return Err("不支持的菜单恢复记录格式".into());
    }
    let mut ids = BTreeSet::new();
    for record in &journal.records {
        if !ids.insert(&record.entry.id)
            || record.registration.is_empty()
            || record.before.is_some()
            || !valid_marker(record)
        {
            return Err("菜单恢复记录不完整，未进行更改".into());
        }
    }
    Ok(journal)
}

fn valid_marker(record: &Record) -> bool {
    let marker = &record.marker;
    if record.entry.kind == "extension" {
        let clsid = canonical_clsid(&marker.name);
        !marker.location.system
            && marker.location.view == 64
            && marker.location.path == BLOCKED_PATH
            && clsid.as_deref() == Some(marker.name.as_str())
            && record.entry.id == format!("extension:{}", marker.name)
            && record.applied == RawValue::text("DtKit")
    } else {
        record.entry.kind == "verb"
            && marker.name == "LegacyDisable"
            && marker
                .location
                .path
                .to_lowercase()
                .starts_with("software\\classes\\")
            && marker.location.path.to_lowercase().contains("\\shell\\")
            && !marker.location.path.contains("..")
            && matches!(marker.location.view, 32 | 64)
            && record.entry.id == stable_id(&marker.location)
            && record.applied == RawValue::text("")
            && record.sources == vec![marker.location.clone()]
    }
}

fn persist_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    let parent = path.parent().ok_or("菜单恢复记录路径无效")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建菜单恢复目录失败：{e}"))?;
    let bytes =
        serde_json::to_vec_pretty(journal).map_err(|e| format!("编码菜单恢复记录失败：{e}"))?;
    if bytes.len() > MAX_JOURNAL_BYTES {
        return Err("菜单恢复记录超过 8 MiB，未进行更改".into());
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("写入菜单恢复记录失败：{e}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("保存菜单恢复记录失败：{e}"))?;
        // rename replaces atomically on Windows as well; no remove/rename gap.
        fs::rename(&temporary, path).map_err(|e| format!("提交菜单恢复记录失败：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn canonical_clsid(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value.trim())
        .ok()
        .map(|id| format!("{{{}}}", id.hyphenated().to_string().to_uppercase()))
}

trait MarkerIo {
    fn read(&self, marker: &Marker) -> Result<Option<RawValue>, String>;
    fn write(&self, marker: &Marker, value: Option<&RawValue>) -> Result<(), String>;
    fn verify_registration(&self, _entry: &ContextMenuEntry) -> Result<(), String> {
        Ok(())
    }
}

fn change_marker(
    io: &impl MarkerIo,
    journal: &mut Journal,
    entry: &ContextMenuEntry,
    enabled: bool,
    mut persist: impl FnMut(&Journal) -> Result<(), String>,
) -> Result<(), String> {
    let marker = entry.marker.as_ref().ok_or("该项目仅供查看")?;
    if io.read(marker)? != entry.marker_value {
        return Err("菜单状态在操作前发生变化，请重新扫描".into());
    }
    if enabled {
        let index = journal
            .records
            .iter()
            .position(|r| r.entry.id == entry.id)
            .ok_or("没有 DtKit 的恢复记录")?;
        let record = journal.records[index].clone();
        if record.registration != entry.registration
            || io.read(marker)? != Some(record.applied.clone())
        {
            return Err("菜单注册或关闭标记已被其他软件更改，未覆盖现有设置".into());
        }
        journal.records[index].restoring = true;
        persist(journal)?;
        io.verify_registration(entry)?;
        if io.read(marker)? != Some(record.applied.clone()) {
            return Err("恢复前的关闭标记已变化，请重新扫描".into());
        }
        io.write(marker, record.before.as_ref())?;
        journal.records.remove(index);
        persist(journal)
            .map_err(|e| format!("菜单已恢复，清理恢复记录失败；重新扫描可查看实际状态：{e}"))
    } else {
        if io.read(marker)?.is_some() {
            return Err("此项目已有其他关闭标记，未覆盖现有设置".into());
        }
        let record = Record {
            entry: entry.clone(),
            sources: entry.sources.clone(),
            registration: entry.registration.clone(),
            marker: marker.clone(),
            before: entry.marker_value.clone(),
            applied: RawValue::text(if entry.kind == "extension" {
                "DtKit"
            } else {
                ""
            }),
            restoring: false,
        };
        journal.records.retain(|r| r.entry.id != entry.id);
        if journal.records.len() >= 4096 {
            return Err("菜单恢复记录已达上限".into());
        }
        journal.records.push(record.clone());
        persist(journal)?;
        io.verify_registration(entry)?;
        if io.read(marker)? != record.before {
            return Err("关闭前的菜单状态已变化，请重新扫描".into());
        }
        // A failed or interrupted write retains its durable record. Reads derive
        // the actual state from the marker rather than assuming the write succeeded.
        io.write(marker, Some(&record.applied))
    }
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" && !window.label().starts_with("quick-host-") {
        return Err("此窗口不能管理右键菜单".into());
    }
    if !window
        .state::<ToolModuleManager>()
        .is_enabled("context-menu")
    {
        return Err("右键菜单管理工具已停用".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn scan_context_menu_items(
    window: WebviewWindow,
    extension: Option<String>,
) -> Result<ContextMenuSnapshot, String> {
    authorize(&window)?;
    let extension = normalize_extension(extension)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<ContextMenuManager>();
        let _guard = manager.migration_guard()?;
        let path = app
            .state::<StorageManager>()
            .layout()?
            .kits
            .join("ContextMenu")
            .join("journal.json");
        scan(&path, extension)
    })
    .await
    .map_err(|e| format!("菜单扫描任务异常：{e}"))?
}

#[tauri::command]
pub(crate) async fn set_context_menu_enabled(
    window: WebviewWindow,
    id: String,
    enabled: bool,
    expected_fingerprint: String,
    extension: Option<String>,
) -> Result<ContextMenuSnapshot, String> {
    authorize(&window)?;
    let extension = normalize_extension(extension)?;
    let app = window.app_handle().clone();
    let _work = super::launch::keep_native_work(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<ContextMenuManager>();
        let _guard = manager.migration_guard()?;
        if !app.state::<ToolModuleManager>().is_enabled("context-menu") {
            return Err("右键菜单管理工具已停用".into());
        }
        let path = app
            .state::<StorageManager>()
            .layout()?
            .kits
            .join("ContextMenu")
            .join("journal.json");
        let snapshot = scan(&path, extension.clone())?;
        let entry = snapshot
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or("菜单项已变化，请重新扫描")?;
        if entry.fingerprint != expected_fingerprint {
            return Err("菜单项已被更改，请重新扫描后重试".into());
        }
        if !entry.can_toggle {
            return Err(entry
                .disabled_reason
                .clone()
                .unwrap_or_else(|| "此项目仅供查看".into()));
        }
        if entry.enabled == enabled {
            return Ok(snapshot);
        }
        #[cfg(target_os = "windows")]
        change_marker(
            &native::WindowsRegistry,
            &mut read_journal(&path)?,
            entry,
            enabled,
            |journal| persist_journal(&path, journal),
        )?;
        #[cfg(not(target_os = "windows"))]
        return Err("此工具仅支持 Windows".into());
        #[allow(unreachable_code)]
        scan(&path, extension)
    })
    .await
    .map_err(|e| format!("菜单更改任务异常：{e}"))?
}

fn scan(path: &Path, extension: Option<String>) -> Result<ContextMenuSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        native::scan(&read_journal(path)?, extension)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, extension);
        Err("此工具仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;

    #[derive(Default)]
    struct FakeRegistry {
        value: RefCell<Option<RawValue>>,
        writes: Cell<usize>,
        fail_write: Cell<bool>,
        fail_verify: Cell<bool>,
    }
    impl MarkerIo for FakeRegistry {
        fn verify_registration(&self, _: &ContextMenuEntry) -> Result<(), String> {
            if self.fail_verify.get() {
                Err("injected concurrent registration change".into())
            } else {
                Ok(())
            }
        }
        fn read(&self, _: &Marker) -> Result<Option<RawValue>, String> {
            Ok(self.value.borrow().clone())
        }
        fn write(&self, _: &Marker, value: Option<&RawValue>) -> Result<(), String> {
            self.writes.set(self.writes.get() + 1);
            if self.fail_write.get() {
                return Err("injected registry failure".into());
            }
            *self.value.borrow_mut() = value.cloned();
            Ok(())
        }
    }
    fn entry() -> ContextMenuEntry {
        let location = Location {
            system: false,
            view: 64,
            path: r"Software\Classes\DtKit.Test\shell\Example".into(),
        };
        ContextMenuEntry {
            id: stable_id(&location),
            name: "Example".into(),
            categories: vec!["fileTypes".into()],
            kind: "verb".into(),
            scope: "user".into(),
            enabled: true,
            can_toggle: true,
            managed: false,
            requires_elevation: false,
            registry_path: location.path.clone(),
            command: "example.exe %1".into(),
            detail: String::new(),
            disabled_reason: None,
            clsid: None,
            fingerprint: "snapshot".into(),
            registration: "registration-v1".into(),
            marker: Some(Marker {
                location: location.clone(),
                name: "LegacyDisable".into(),
            }),
            marker_value: None,
            sources: vec![location],
        }
    }
    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("dtkit-context-test-{}", uuid::Uuid::new_v4())))
        }
        fn path(&self) -> PathBuf {
            self.0.join("journal.json")
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn extensions_reject_registry_paths_and_match_frontend_normalization() {
        assert_eq!(
            normalize_extension(Some(" PDF ".into())).unwrap(),
            Some(".pdf".into())
        );
        assert_eq!(normalize_extension(Some(" ".into())).unwrap(), None);
        for invalid in [".", ".tar.gz", "../pdf", r"x\shell", ".你好", "*", ".a b"] {
            assert!(normalize_extension(Some(invalid.into())).is_err());
        }
        assert!(normalize_extension(Some(format!(".{}", "a".repeat(32)))).is_err());
    }

    #[test]
    fn journal_must_commit_before_registry_write_and_failures_preserve_markers() {
        let registry = FakeRegistry::default();
        let mut journal = Journal::default();
        assert!(
            change_marker(&registry, &mut journal, &entry(), false, |_| Err(
                "disk full".into()
            ))
            .is_err()
        );
        assert_eq!(registry.writes.get(), 0);
        assert_eq!(*registry.value.borrow(), None);
        let durable = RefCell::new(Journal::default());
        registry.fail_write.set(true);
        assert!(
            change_marker(&registry, &mut journal, &entry(), false, |next| {
                assert_eq!(registry.writes.get(), 0);
                *durable.borrow_mut() = next.clone();
                Ok(())
            })
            .is_err()
        );
        assert_eq!(durable.borrow().records.len(), 1);
        assert_eq!(*registry.value.borrow(), None);
    }

    #[test]
    fn interrupted_disable_recovers_exact_marker_and_restore_round_trips() {
        let registry = FakeRegistry::default();
        let directory = TestDir::new();
        let mut journal = Journal::default();
        let mut entry = entry();
        change_marker(&registry, &mut journal, &entry, false, |next| {
            persist_journal(&directory.path(), next)
        })
        .unwrap();
        // Reload the durable pre-write journal, as after process termination.
        let mut recovered = read_journal(&directory.path()).unwrap();
        assert_eq!(recovered.records.len(), 1);
        entry.enabled = false;
        entry.managed = true;
        entry.marker_value = registry.value.borrow().clone();
        change_marker(&registry, &mut recovered, &entry, true, |next| {
            persist_journal(&directory.path(), next)
        })
        .unwrap();
        assert_eq!(*registry.value.borrow(), None);
        assert!(read_journal(&directory.path()).unwrap().records.is_empty());
    }

    #[test]
    fn failed_restore_write_keeps_recovery_and_cleanup_failure_does_not_re_disable() {
        let registry = FakeRegistry::default();
        let mut journal = Journal::default();
        let mut entry = entry();
        change_marker(&registry, &mut journal, &entry, false, |_| Ok(())).unwrap();
        entry.marker_value = registry.value.borrow().clone();
        entry.enabled = false;
        entry.managed = true;
        registry.fail_write.set(true);
        assert!(change_marker(&registry, &mut journal, &entry, true, |_| Ok(())).is_err());
        assert_eq!(journal.records.len(), 1);
        assert_eq!(*registry.value.borrow(), Some(RawValue::text("")));
        registry.fail_write.set(false);
        let persists = Cell::new(0);
        assert!(change_marker(&registry, &mut journal, &entry, true, |_| {
            persists.set(persists.get() + 1);
            if persists.get() == 2 {
                Err("cleanup disk full".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(*registry.value.borrow(), None);
    }

    #[test]
    fn changed_registration_or_marker_is_not_overwritten() {
        let registry = FakeRegistry::default();
        let mut journal = Journal::default();
        let mut entry = entry();
        change_marker(&registry, &mut journal, &entry, false, |_| Ok(())).unwrap();
        entry.marker_value = registry.value.borrow().clone();
        entry.enabled = false;
        entry.managed = true;
        entry.registration = "application-updated".into();
        assert!(
            change_marker(&registry, &mut journal, &entry, true, |_| panic!(
                "must not persist conflict"
            ))
            .is_err()
        );
        entry.registration = "registration-v1".into();
        *registry.value.borrow_mut() = Some(RawValue {
            kind: 4,
            bytes: vec![1, 0, 0, 0],
        });
        assert!(
            change_marker(&registry, &mut journal, &entry, true, |_| panic!(
                "must not persist conflict"
            ))
            .is_err()
        );
        assert_eq!(registry.writes.get(), 1);
    }

    #[test]
    fn registration_change_during_journal_commit_prevents_disable_and_restore_writes() {
        let registry = FakeRegistry::default();
        let mut journal = Journal::default();
        let mut item = entry();
        assert!(change_marker(&registry, &mut journal, &item, false, |_| {
            registry.fail_verify.set(true);
            Ok(())
        })
        .is_err());
        assert_eq!(registry.writes.get(), 0);
        registry.fail_verify.set(false);
        change_marker(&registry, &mut journal, &item, false, |_| Ok(())).unwrap();
        item.marker_value = registry.value.borrow().clone();
        assert!(change_marker(&registry, &mut journal, &item, true, |_| {
            registry.fail_verify.set(true);
            Ok(())
        })
        .is_err());
        assert_eq!(registry.writes.get(), 1);
        assert_eq!(*registry.value.borrow(), Some(RawValue::text("")));
        assert_eq!(journal.records.len(), 1);
    }

    #[test]
    fn external_marker_is_never_claimed_and_prewrite_race_is_detected() {
        let registry = FakeRegistry::default();
        let mut journal = Journal::default();
        *registry.value.borrow_mut() = Some(RawValue::text("external"));
        let mut item = entry();
        item.marker_value = registry.value.borrow().clone();
        assert!(
            change_marker(&registry, &mut journal, &item, false, |_| panic!(
                "do not own external state"
            ))
            .is_err()
        );
        *registry.value.borrow_mut() = None;
        assert!(
            change_marker(&registry, &mut journal, &entry(), false, |_| {
                *registry.value.borrow_mut() = Some(RawValue::text("concurrent external change"));
                Ok(())
            })
            .is_err()
        );
        assert_eq!(registry.writes.get(), 0);
    }

    #[test]
    fn discovering_more_clsid_uses_does_not_invalidate_original_restore_sources() {
        let registry = FakeRegistry::default();
        let mut journal = Journal::default();
        let mut original = entry();
        original.kind = "extension".into();
        change_marker(&registry, &mut journal, &original, false, |_| Ok(())).unwrap();
        let record = journal.records[0].clone();
        let mut expanded = original.clone();
        expanded.marker_value = registry.value.borrow().clone();
        expanded.enabled = false;
        expanded.sources.push(Location {
            system: true,
            view: 64,
            path: r"Software\Classes\PDF\shellex\ContextMenuHandlers\Example".into(),
        });
        expanded.categories.push("files".into());
        expanded.registration = "expanded-scan-source-set".into();
        apply_record(&mut expanded, &record, Some("registration-v1".into()));
        assert!(expanded.can_toggle && expanded.managed);
        assert_eq!(expanded.categories.len(), 2);
        assert_eq!(expanded.sources, original.sources);
        change_marker(&registry, &mut journal, &expanded, true, |_| Ok(())).unwrap();
        assert_eq!(*registry.value.borrow(), None);
        apply_record(
            &mut expanded,
            &record,
            Some("original-source-was-edited".into()),
        );
        assert!(!expanded.can_toggle);
    }

    #[test]
    fn oversized_journal_aborts_before_any_registry_mutation() {
        let directory = TestDir::new();
        let registry = FakeRegistry::default();
        let mut journal = Journal::default();
        let mut item = entry();
        item.detail = "x".repeat(MAX_JOURNAL_BYTES);
        assert!(
            change_marker(&registry, &mut journal, &item, false, |next| {
                persist_journal(&directory.path(), next)
            })
            .is_err()
        );
        assert_eq!(registry.writes.get(), 0);
        assert!(!directory.path().exists());
    }

    #[test]
    fn corrupt_journal_and_invalid_targets_are_not_silently_reset() {
        let directory = TestDir::new();
        fs::create_dir_all(&directory.0).unwrap();
        fs::write(directory.path(), b"damaged").unwrap();
        assert!(read_journal(&directory.path()).is_err());
        let registry = FakeRegistry::default();
        let mut journal = Journal::default();
        change_marker(&registry, &mut journal, &entry(), false, |_| Ok(())).unwrap();
        journal.records[0].marker.name = "command".into();
        persist_journal(&directory.path(), &journal).unwrap();
        assert!(read_journal(&directory.path()).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "Explicit read-only diagnostic against the host Windows registry"]
    fn native_scan_read_only_diagnostic() {
        let now = std::time::Instant::now();
        let result = native::scan(&Journal::default(), Some(".txt".into())).unwrap();
        assert_eq!(result.total, result.enabled + result.disabled);
        assert_eq!(
            result.total,
            result
                .items
                .iter()
                .map(|item| &item.id)
                .collect::<BTreeSet<_>>()
                .len()
        );
        assert!(result.items.iter().all(|item| !item.fingerprint.is_empty()));
        println!(
            "Read-only registry scan: total={}, enabled={}, readOnly={}, warnings={}, elapsed={:?}",
            result.total,
            result.enabled,
            result.read_only,
            result.warnings.len(),
            now.elapsed()
        );
    }
}
