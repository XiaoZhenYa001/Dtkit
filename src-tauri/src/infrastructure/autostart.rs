//! Current-user logon registration. Reading status never changes Windows policy.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};

const RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const OWNER_PATH: &str = r"Software\DtKit\AutostartOwners";
const APPROVAL_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const AUTOSTART_ARGUMENT: &str = "--autostart";
static REGISTRATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutostartStatus {
    available: bool,
    enabled: bool,
    registered: bool,
    warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Value {
    kind: u32,
    bytes: Vec<u8>,
}

impl Value {
    fn string(value: &str) -> Self {
        Self {
            kind: 1,
            bytes: value.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect(),
        }
    }

    fn text(&self) -> Option<String> {
        if self.kind != 1 || self.bytes.len() % 2 != 0 || self.bytes.len() > 64 * 1024 {
            return None;
        }
        let mut wide = self.bytes.chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
        if wide.last() == Some(&0) { wide.pop(); }
        if wide.contains(&0) { return None; }
        String::from_utf16(&wide).ok()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slot { Run, Owner, Approval }

trait RegistrationStore {
    fn read(&self, slot: Slot) -> Result<Option<Value>, String>;
    fn write(&self, slot: Slot, value: Option<&Value>) -> Result<(), String>;
}

fn registration_name(identifier: &str) -> Result<String, String> {
    if identifier.is_empty() || identifier.len() > 128
        || !identifier.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) {
        return Err("应用标识无效，无法管理开机自动启动".into());
    }
    Ok(format!("DtKit.{identifier}"))
}

fn startup_command(executable: &str) -> Result<String, String> {
    if executable.is_empty() || executable.chars().any(|character| character == '"' || character.is_control())
        || executable.ends_with(['\\', '/']) {
        return Err("程序路径包含不能用于开机自动启动的字符".into());
    }
    let command = format!("\"{executable}\" {AUTOSTART_ARGUMENT}");
    // Run's documented limit applies to its command line, including quotes and arguments.
    if command.encode_utf16().count() > 260 {
        return Err("程序路径过长，开机启动命令超过 Windows 的 260 字符限制；请将程序移至较短路径".into());
    }
    Ok(command)
}

fn generated_command(value: &str) -> bool {
    value.strip_prefix('"').and_then(|value| value.strip_suffix("\" --autostart"))
        .is_some_and(|path| startup_command(path).as_deref() == Ok(value))
}

fn owned(run: &Value, owner: Option<&Value>, expected: &str) -> bool {
    let Some(command) = run.text() else { return false; };
    command == expected || (generated_command(&command)
        && owner.and_then(Value::text).as_deref() == Some(command.as_str()))
}

fn approval(value: Option<Value>) -> Result<bool, String> {
    let Some(value) = value else { return Ok(true); };
    // This is intentionally read-only: StartupApproved is not a supported write API.
    if value.kind != 3 || value.bytes.len() != 12 {
        return Err("Windows 启动状态格式无法识别，请在系统的“启动应用”中核对".into());
    }
    match u32::from_le_bytes(value.bytes[..4].try_into().unwrap()) {
        2 | 6 => Ok(true),
        3 | 7 => Ok(false),
        _ => Err("无法确认 Windows 是否允许此启动项，请在系统的“启动应用”中核对".into()),
    }
}

fn status(store: &impl RegistrationStore, expected: &str) -> Result<AutostartStatus, String> {
    let run = store.read(Slot::Run)?;
    let owner = store.read(Slot::Owner)?;
    let Some(run) = run else {
        return Ok(AutostartStatus { available: true, enabled: false, registered: false, warning: None });
    };
    if !owned(&run, owner.as_ref(), expected) {
        return Ok(AutostartStatus { available: false, enabled: false, registered: false,
            warning: Some("同名开机启动项包含其他内容，为避免覆盖，DtKit 未更改它；请在 Windows 启动设置中核对".into()) });
    }
    let current_path = run.text().as_deref() == Some(expected);
    let allowed = approval(store.read(Slot::Approval)?);
    let mut warnings = Vec::new();
    if !current_path { warnings.push("程序位置已改变，请重新开启以更新开机启动路径".to_string()); }
    match &allowed {
        Ok(false) => warnings.push("已登记，但被 Windows 的“启动应用”禁用；请在 Windows 设置中重新启用".into()),
        Err(message) => warnings.push(message.clone()),
        _ => {}
    }
    Ok(AutostartStatus { available: true, enabled: current_path && allowed == Ok(true), registered: true,
        warning: (!warnings.is_empty()).then(|| warnings.join("；")) })
}

fn set_enabled(store: &impl RegistrationStore, expected: &str, enabled: bool) -> Result<AutostartStatus, String> {
    let previous_run = store.read(Slot::Run)?;
    let previous_owner = store.read(Slot::Owner)?;
    if previous_run.as_ref().is_some_and(|run| !owned(run, previous_owner.as_ref(), expected)) {
        return Err("同名启动项已被其他内容占用，未覆盖或删除它，请重新读取状态".into());
    }
    if !enabled {
        if previous_run.is_some() { store.write(Slot::Run, None)?; }
        let cleanup = store.write(Slot::Owner, None);
        let mut result = status(store, expected)?;
        if let Err(error) = cleanup {
            result.warning = Some(format!("开机启动已关闭，但登记记录未能清理：{error}"));
        }
        return Ok(result);
    }
    let applied = Value::string(expected);
    store.write(Slot::Run, Some(&applied))?;
    if let Err(error) = store.write(Slot::Owner, Some(&applied)) {
        // Never roll back somebody else's later change to this value.
        let rollback = if store.read(Slot::Run)? == Some(applied) {
            store.write(Slot::Run, previous_run.as_ref())
        } else { Err("登记在保存期间发生变化".into()) };
        return Err(match rollback {
            Ok(()) => format!("保存开机启动登记失败，已恢复原状态：{error}"),
            Err(rollback) => format!("保存开机启动登记失败：{error}；回滚未完成，请重新读取状态：{rollback}"),
        });
    }
    status(store, expected)
}

fn current_status(store: &impl RegistrationStore, command: &Result<String, String>) -> Result<AutostartStatus, String> {
    let mut state = status(store, command.as_deref().unwrap_or(""))?;
    if let Err(error) = command {
        state.available = false;
        state.enabled = false;
        state.warning = Some(match state.warning.take() {
            Some(warning) => format!("{warning}；{error}"),
            None => error.clone(),
        });
    }
    Ok(state)
}

fn update_current_registration(
    store: &impl RegistrationStore,
    command: &Result<String, String>,
    enabled: bool,
) -> Result<AutostartStatus, String> {
    if enabled {
        set_enabled(store, command.as_deref().map_err(Clone::clone)?, true)
    } else {
        // An old owned entry can still be removed after the executable moves
        // to a path too long for a new Windows Run command.
        set_enabled(store, command.as_deref().unwrap_or(""), false)?;
        current_status(store, command)
    }
}

#[cfg(windows)]
struct WindowsStore {
    paths: [String; 3],
    name: String,
}

#[cfg(windows)]
impl RegistrationStore for WindowsStore {
    fn read(&self, slot: Slot) -> Result<Option<Value>, String> {
        use winreg::{enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_WOW64_64KEY}, RegKey};
        let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(&self.paths[slot as usize], KEY_QUERY_VALUE | KEY_WOW64_64KEY) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("读取开机启动登记失败：{error}")),
        };
        match key.get_raw_value(&self.name) {
            Ok(value) => Ok(Some(Value { kind: value.vtype as u32, bytes: value.bytes })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("读取开机启动值失败：{error}")),
        }
    }

    fn write(&self, slot: Slot, value: Option<&Value>) -> Result<(), String> {
        use winreg::{enums::{HKEY_CURRENT_USER, KEY_SET_VALUE, KEY_WOW64_64KEY, REG_SZ}, RegKey, RegValue};
        if slot == Slot::Approval { return Err("不能修改 Windows 启动应用策略".into()); }
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let key = if value.is_some() {
            root.create_subkey_with_flags(&self.paths[slot as usize], KEY_SET_VALUE | KEY_WOW64_64KEY).map(|value| value.0)
        } else {
            root.open_subkey_with_flags(&self.paths[slot as usize], KEY_SET_VALUE | KEY_WOW64_64KEY)
        };
        let key = match key {
            Ok(key) => key,
            Err(error) if value.is_none() && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("打开开机启动登记失败：{error}")),
        };
        let result = match value {
            Some(value) => key.set_raw_value(&self.name, &RegValue { vtype: REG_SZ, bytes: value.bytes.clone() }),
            None => key.delete_value(&self.name),
        };
        match result {
            Ok(()) => Ok(()),
            Err(error) if value.is_none() && error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("保存开机启动登记失败：{error}")),
        }
    }
}

#[cfg(windows)]
fn context(window: &WebviewWindow) -> Result<(WindowsStore, Result<String, String>), String> {
    let executable = std::env::current_exe().map_err(|error| format!("无法读取程序路径：{error}"))?;
    let command = executable.to_str().ok_or_else(|| "程序路径不能转换为 Unicode".to_string())
        .and_then(startup_command);
    Ok((WindowsStore { paths: [RUN_PATH.into(), OWNER_PATH.into(), APPROVAL_PATH.into()],
        name: registration_name(&window.app_handle().config().identifier)? }, command))
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("只有主设置窗口可以管理开机自动启动".into()); }
    Ok(())
}

#[tauri::command]
pub(crate) async fn get_autostart_status(window: WebviewWindow) -> Result<AutostartStatus, String> {
    authorize(&window)?;
    #[cfg(windows)]
    {
        let (store, command) = context(&window)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = REGISTRATION_LOCK.lock().map_err(|_| "开机启动状态锁不可用")?;
            current_status(&store, &command)
        }).await.map_err(|error| format!("读取开机启动任务失败：{error}"))?
    }
    #[cfg(not(windows))]
    { Ok(AutostartStatus { available: false, enabled: false, registered: false,
        warning: Some("开机自动启动目前仅支持 Windows".into()) }) }
}

#[tauri::command]
pub(crate) async fn set_autostart_enabled(window: WebviewWindow, enabled: bool) -> Result<AutostartStatus, String> {
    authorize(&window)?;
    #[cfg(windows)]
    {
        let _work = super::launch::keep_native_work(window.app_handle());
        let (store, command) = context(&window)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = REGISTRATION_LOCK.lock().map_err(|_| "开机启动状态锁不可用")?;
            update_current_registration(&store, &command, enabled)
        }).await.map_err(|error| format!("保存开机启动任务失败：{error}"))?
    }
    #[cfg(not(windows))]
    { let _ = enabled; Err("开机自动启动目前仅支持 Windows".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct MemoryStore {
        values: RefCell<[Option<Value>; 3]>,
        fail_owner: RefCell<bool>,
    }
    impl RegistrationStore for MemoryStore {
        fn read(&self, slot: Slot) -> Result<Option<Value>, String> { Ok(self.values.borrow()[slot as usize].clone()) }
        fn write(&self, slot: Slot, value: Option<&Value>) -> Result<(), String> {
            assert_ne!(slot, Slot::Approval);
            if slot == Slot::Owner && *self.fail_owner.borrow() { return Err("fixture owner failure".into()); }
            self.values.borrow_mut()[slot as usize] = value.cloned(); Ok(())
        }
    }
    fn command() -> String { startup_command(r"C:\Program Files\桌面工具\DtKit.exe").unwrap() }
    fn approval_value(state: u32) -> Value { Value { kind: 3, bytes: state.to_le_bytes().into_iter().chain([0; 8]).collect() } }

    #[test]
    fn command_quotes_unicode_paths_and_counts_the_complete_utf16_command() {
        assert_eq!(command(), "\"C:\\Program Files\\桌面工具\\DtKit.exe\" --autostart");
        for path in ["", "C:\\bad\".exe", "C:\\bad\n.exe", "C:\\bad\0.exe", "C:\\folder\\"] { assert!(startup_command(path).is_err()); }
        let prefix = r"C:\";
        let suffix = ".exe";
        let overhead = startup_command(&format!("{prefix}{suffix}")).unwrap().encode_utf16().count();
        assert!(startup_command(&format!("{prefix}{}{suffix}", "a".repeat(260-overhead))).is_ok());
        assert!(startup_command(&format!("{prefix}{}{suffix}", "a".repeat(261-overhead))).is_err());
        assert!(startup_command(&format!("{prefix}{}{suffix}", "😀".repeat(130))).is_err());
    }

    #[test]
    fn identifiers_isolate_installed_and_test_applications() {
        assert_ne!(registration_name("com.administrator.dtkit").unwrap(), registration_name("com.administrator.dtkit.native-smoke").unwrap());
        for identifier in ["", "../escape", "bad\\key", "bad\0value"] { assert!(registration_name(identifier).is_err()); }
    }

    #[test]
    fn registration_is_idempotent_and_unregistration_preserves_other_slots() {
        let store = MemoryStore::default(); let command = command();
        assert!(!status(&store,&command).unwrap().registered);
        assert!(set_enabled(&store,&command,true).unwrap().enabled);
        assert!(set_enabled(&store,&command,true).unwrap().enabled);
        store.values.borrow_mut()[Slot::Approval as usize] = Some(approval_value(2));
        assert!(!set_enabled(&store,&command,false).unwrap().registered);
        assert!(store.values.borrow()[Slot::Approval as usize].is_some());
        assert!(!set_enabled(&store,&command,false).unwrap().enabled);
    }

    #[test]
    fn windows_disabled_or_unknown_approval_is_never_bypassed() {
        let store=MemoryStore::default();let command=command();
        for state in [3,7,99] {
            let value=approval_value(state);
            store.values.borrow_mut()[Slot::Approval as usize]=Some(value.clone());
            let result=set_enabled(&store,&command,true).unwrap();
            assert!(result.available && result.registered && !result.enabled && result.warning.is_some());
            assert_eq!(store.values.borrow()[Slot::Approval as usize],Some(value));
        }
        store.values.borrow_mut()[Slot::Approval as usize]=Some(Value::string("unexpected"));
        assert!(!status(&store,&command).unwrap().enabled);
        for state in [2,6] {
            store.values.borrow_mut()[Slot::Approval as usize]=Some(approval_value(state));
            assert!(status(&store,&command).unwrap().enabled);
        }
    }

    #[test]
    fn foreign_values_are_neither_overwritten_nor_deleted() {
        let store=MemoryStore::default();let command=command();
        let foreign=Value::string("not the DtKit command");
        store.values.borrow_mut()[Slot::Run as usize]=Some(foreign.clone());
        assert!(!status(&store,&command).unwrap().available);
        for enabled in [true,false] { assert!(set_enabled(&store,&command,enabled).is_err()); }
        assert_eq!(store.values.borrow()[Slot::Run as usize],Some(foreign));
    }

    #[test]
    fn a_recorded_old_location_can_be_updated_or_removed() {
        let store=MemoryStore::default();let old=startup_command(r"C:\Old\DtKit.exe").unwrap();
        set_enabled(&store,&old,true).unwrap();
        let moved=status(&store,&command()).unwrap();
        assert!(moved.available && moved.registered && !moved.enabled && moved.warning.is_some());
        assert!(set_enabled(&store,&command(),true).unwrap().enabled);
        assert!(!set_enabled(&store,&old,false).unwrap().registered);
    }

    #[test]
    fn an_invalid_new_path_does_not_trap_an_old_owned_registration() {
        let store = MemoryStore::default();
        let old = startup_command(r"C:\Old\DtKit.exe").unwrap();
        set_enabled(&store, &old, true).unwrap();
        let invalid = Err("程序路径过长，无法开启开机启动".to_string());
        let state = current_status(&store, &invalid).unwrap();
        assert!(!state.available && !state.enabled && state.registered);
        assert!(state.warning.unwrap().contains("程序路径过长"));
        assert!(update_current_registration(&store, &invalid, true).is_err());
        let removed = update_current_registration(&store, &invalid, false).unwrap();
        assert!(!removed.available && !removed.registered);
        assert!(removed.warning.unwrap().contains("程序路径过长"));
        assert!(store.read(Slot::Run).unwrap().is_none());
    }

    #[test]
    fn failed_owner_write_rolls_back_the_registration() {
        let store=MemoryStore::default();let command=command();
        *store.fail_owner.borrow_mut()=true;
        assert!(set_enabled(&store,&command,true).is_err());
        assert!(!status(&store,&command).unwrap().registered);
        *store.fail_owner.borrow_mut()=false;
        let old=startup_command(r"C:\Old\DtKit.exe").unwrap();
        set_enabled(&store,&old,true).unwrap();
        *store.fail_owner.borrow_mut()=true;
        assert!(set_enabled(&store,&command,true).is_err());
        assert_eq!(store.read(Slot::Run).unwrap(),Some(Value::string(&old)));
    }

    #[test]
    fn malformed_registry_strings_are_not_trusted_as_ownership() {
        for value in [Value {kind:1,bytes:vec![0]},Value {kind:1,bytes:vec![0,216]},Value::string("one\0two"),Value {kind:3,bytes:vec![]}] { assert!(value.text().is_none()); }
        let store=MemoryStore::default();
        store.values.borrow_mut()[Slot::Run as usize]=Some(Value{kind:3,bytes:vec![]});
        assert!(!status(&store,&command()).unwrap().available);
    }

    #[cfg(windows)]
    #[test]
    fn native_registry_round_trip_uses_only_a_temporary_non_startup_branch() {
        use winreg::{enums::{HKEY_CURRENT_USER,KEY_ALL_ACCESS,REG_BINARY},RegKey,RegValue};
        let root=RegKey::predef(HKEY_CURRENT_USER);
        let branch=format!(r"Software\DtKitTests\{}",uuid::Uuid::new_v4());
        struct Cleanup(String);
        impl Drop for Cleanup { fn drop(&mut self) { let _=RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.0); } }
        let _cleanup=Cleanup(branch.clone());
        let store=WindowsStore {paths:[format!(r"{branch}\Run"),format!(r"{branch}\Owner"),format!(r"{branch}\Approval")],name:registration_name("native.fixture").unwrap()};
        assert!(store.paths.iter().all(|path|path.starts_with(&format!("{branch}\\"))));
        assert!(set_enabled(&store,&command(),true).unwrap().enabled);
        let (approval,_)=root.create_subkey_with_flags(&store.paths[Slot::Approval as usize],KEY_ALL_ACCESS).unwrap();
        let bytes=approval_value(3).bytes;
        approval.set_raw_value(&store.name,&RegValue{vtype:REG_BINARY,bytes:bytes.clone()}).unwrap();
        let blocked=set_enabled(&store,&command(),true).unwrap();
        assert!(blocked.registered && !blocked.enabled);
        assert_eq!(approval.get_raw_value(&store.name).unwrap().bytes,bytes);
        assert!(!set_enabled(&store,&command(),false).unwrap().registered);
        let (run,_)=root.create_subkey(&store.paths[Slot::Run as usize]).unwrap();
        run.set_value("Unrelated",&"preserve this fixture").unwrap();
        set_enabled(&store,&command(),true).unwrap();set_enabled(&store,&command(),false).unwrap();
        assert_eq!(run.get_value::<String,_>("Unrelated").unwrap(),"preserve this fixture");
    }
}
