//! A tool launch does not create the main WebView or initialize unrelated services.
use super::quick_host::is_supported_tool_id;
use super::tool_modules::ToolModuleManager;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LaunchTarget {
    Main,
    Tool(String),
}

impl LaunchTarget {
    /// Arguments exclude the executable name. Never turn a malformed tool request into
    /// an accidental main-window launch, or accept a path/URL as a tool identifier.
    pub(crate) fn parse(arguments: &[String]) -> Result<Self, String> {
        match arguments {
            [] => Ok(Self::Main),
            [flag, tool_id] if flag == "--tool" && is_supported_tool_id(tool_id) => {
                Ok(Self::Tool(tool_id.clone()))
            }
            [argument] => argument
                .strip_prefix("--tool=")
                .filter(|tool_id| is_supported_tool_id(tool_id))
                .map(|tool_id| Self::Tool(tool_id.to_string()))
                .ok_or_else(|| "启动参数无效；请使用 --tool 工具标识".to_string()),
            _ => Err("启动参数无效；请使用 --tool 工具标识".to_string()),
        }
    }
}

#[derive(Default)]
pub(crate) struct LaunchRuntime {
    main_requested: AtomicBool,
    main_services_started: AtomicBool,
    next_sleep_token: AtomicU64,
    pending_sleep_token: AtomicU64,
    active_operations: Arc<AtomicUsize>,
}

impl LaunchRuntime {
    pub(crate) fn is_tool_only(&self) -> bool {
        !self.main_requested.load(Ordering::Acquire)
    }

    /// Returns true once, when unrelated app services actually become necessary.
    pub(crate) fn enter_main(&self) -> bool {
        self.main_requested.store(true, Ordering::Release);
        self.cancel_sleep();
        !self.main_services_started.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn request_sleep(&self) -> u64 {
        let token = self.next_sleep_token.fetch_add(1, Ordering::Relaxed) + 1;
        self.pending_sleep_token.store(token, Ordering::Release);
        token
    }

    pub(crate) fn finish_sleep(&self, token: u64) -> bool {
        token != 0
            && self
                .pending_sleep_token
                .compare_exchange(token, 0, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    pub(crate) fn cancel_sleep(&self) {
        self.pending_sleep_token.store(0, Ordering::Release);
    }

    pub(crate) fn has_active_operations(&self) -> bool {
        self.active_operations.load(Ordering::Acquire) > 0
    }
}

/// Keeps a requested write alive if its owner closes while the native future runs.
pub(crate) struct NativeWorkGuard {
    app: AppHandle,
    counter: Arc<AtomicUsize>,
}

impl Drop for NativeWorkGuard {
    fn drop(&mut self) {
        if self.counter.fetch_sub(1, Ordering::AcqRel) == 1 {
            tauri::async_runtime::spawn(finish_tool_only_if_idle(self.app.clone()));
        }
    }
}

pub(crate) fn keep_native_work(app: &AppHandle) -> NativeWorkGuard {
    let counter = app.state::<LaunchRuntime>().active_operations.clone();
    counter.fetch_add(1, Ordering::AcqRel);
    NativeWorkGuard {
        app: app.clone(),
        counter,
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct IdleState {
    pub(crate) has_webviews: bool,
    pub(crate) has_alarms: bool,
    pub(crate) has_jobs: bool,
    pub(crate) has_share: bool,
    pub(crate) has_mirrors: bool,
    pub(crate) has_maintenance: bool,
}

impl IdleState {
    pub(crate) fn can_exit_tool_only(self) -> bool {
        !(self.has_webviews
            || self.has_alarms
            || self.has_jobs
            || self.has_share
            || self.has_mirrors
            || self.has_maintenance)
    }
}

pub(crate) async fn finish_tool_only_if_idle(app: AppHandle) {
    if !app.state::<LaunchRuntime>().is_tool_only() {
        return;
    }
    let state = IdleState {
        has_webviews: !app.webview_windows().is_empty(),
        has_alarms: app
            .state::<crate::alarm_scheduler::AlarmScheduler>()
            .has_pending_work()
            .await,
        has_jobs: app.state::<super::jobs::JobManager>().active_count() > 0,
        has_share: app
            .state::<super::transfer_station::TransferStationManager>()
            .has_active_share()
            .await,
        has_mirrors: app
            .state::<super::region_mirror::RegionMirrorManager>()
            .has_active_mirrors(),
        has_maintenance: app.state::<super::cleanup::CleanupManager>().is_running()
            || app.state::<LaunchRuntime>().has_active_operations(),
    };
    if state.can_exit_tool_only()
        && app.state::<LaunchRuntime>().is_tool_only()
        && app.webview_windows().is_empty()
        && !app.state::<LaunchRuntime>().has_active_operations()
    {
        app.exit(0);
    }
}

fn launcher_destination(desktop: &Path, tool_id: &str) -> Result<PathBuf, String> {
    if !is_supported_tool_id(tool_id) {
        return Err("工具标识无效".to_string());
    }
    Ok(desktop.join(format!("DtKit - {tool_id}.lnk")))
}

#[cfg(windows)]
fn write_tool_launcher(executable: &Path, destination: &Path, tool_id: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let wide = |value: &std::ffi::OsStr| value.encode_wide().chain(Some(0)).collect::<Vec<_>>();
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialized.is_err() && initialized.0 != 0x80010106u32 as i32 {
            return Err(format!("初始化快捷方式接口失败: {initialized:?}"));
        }
        let _guard = ComGuard(initialized.is_ok());
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| format!("创建快捷方式失败: {error}"))?;
        let executable_wide = wide(executable.as_os_str());
        link.SetPath(PCWSTR(executable_wide.as_ptr()))
            .map_err(|error| error.to_string())?;
        let arguments = wide(std::ffi::OsStr::new(&format!("--tool {tool_id}")));
        link.SetArguments(PCWSTR(arguments.as_ptr()))
            .map_err(|error| error.to_string())?;
        if let Some(directory) = executable.parent() {
            let directory_wide = wide(directory.as_os_str());
            link.SetWorkingDirectory(PCWSTR(directory_wide.as_ptr()))
                .map_err(|error| error.to_string())?;
        }
        link.SetIconLocation(PCWSTR(executable_wide.as_ptr()), 0)
            .map_err(|error| error.to_string())?;
        let description = wide(std::ffi::OsStr::new("独立启动 DtKit 工具，不加载主界面"));
        link.SetDescription(PCWSTR(description.as_ptr()))
            .map_err(|error| error.to_string())?;
        let persistent: IPersistFile = link.cast().map_err(|error| error.to_string())?;
        // Write in the same directory then publish without replacement. This also
        // protects an existing shortcut if another process creates it concurrently.
        let temporary =
            destination.with_file_name(format!(".dtkit-launcher-{}.lnk", uuid::Uuid::new_v4()));
        let temporary_wide = wide(temporary.as_os_str());
        let result = persistent
            .Save(PCWSTR(temporary_wide.as_ptr()), true)
            .map_err(|error| format!("保存快捷方式失败: {error}"))
            .and_then(|_| publish_launcher(&temporary, destination));
        let _ = std::fs::remove_file(&temporary);
        result
    }
}

#[cfg(windows)]
fn publish_launcher(temporary: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::MoveFileW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let from = wide(temporary);
    let to = wide(destination);
    unsafe { MoveFileW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr())) }
        .map_err(|error| format!("创建快捷方式失败；同名文件不会被覆盖: {error}"))
}

#[tauri::command]
pub(crate) async fn create_tool_launcher(
    window: WebviewWindow,
    tool_id: String,
) -> Result<String, String> {
    if window.label() != "main"
        && !window
            .label()
            .starts_with(super::quick_host::QUICK_HOST_LABEL_PREFIX)
    {
        return Err("当前窗口不能创建工具快捷方式".to_string());
    }
    if !window.state::<ToolModuleManager>().is_enabled(&tool_id) {
        return Err("该工具模块已停用".to_string());
    }
    #[cfg(windows)]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let desktop = window
            .app_handle()
            .path()
            .desktop_dir()
            .map_err(|error| error.to_string())?;
        let destination = launcher_destination(&desktop, &tool_id)?;
        let display_path = destination.to_string_lossy().into_owned();
        tauri::async_runtime::spawn_blocking(move || {
            write_tool_launcher(&executable, &destination, &tool_id)
        })
        .await
        .map_err(|error| format!("创建快捷方式任务失败: {error}"))??;
        Ok(display_path)
    }
    #[cfg(not(windows))]
    {
        let _ = tool_id;
        Err("桌面工具快捷方式当前仅支持 Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_launch_never_falls_back_to_main_on_invalid_arguments() {
        assert_eq!(LaunchTarget::parse(&[]).unwrap(), LaunchTarget::Main);
        for arguments in [vec!["--tool", "html-preview"], vec!["--tool=html-preview"]] {
            let arguments = arguments.into_iter().map(String::from).collect::<Vec<_>>();
            assert_eq!(
                LaunchTarget::parse(&arguments).unwrap(),
                LaunchTarget::Tool("html-preview".into())
            );
        }
        for arguments in [
            vec!["--tool"],
            vec!["--tool", "../settings"],
            vec!["--tool="],
            vec!["--tool", "html-preview", "--tool", "json-formatter"],
            vec!["--unknown"],
        ] {
            assert!(LaunchTarget::parse(
                &arguments.into_iter().map(String::from).collect::<Vec<_>>()
            )
            .is_err());
        }
    }

    #[test]
    fn tool_only_exit_preserves_all_required_background_work() {
        assert!(IdleState::default().can_exit_tool_only());
        for state in [
            IdleState {
                has_webviews: true,
                ..Default::default()
            },
            IdleState {
                has_alarms: true,
                ..Default::default()
            },
            IdleState {
                has_jobs: true,
                ..Default::default()
            },
            IdleState {
                has_share: true,
                ..Default::default()
            },
            IdleState {
                has_mirrors: true,
                ..Default::default()
            },
            IdleState {
                has_maintenance: true,
                ..Default::default()
            },
        ] {
            assert!(!state.can_exit_tool_only());
        }
    }

    #[test]
    fn restored_main_invalidates_delayed_sleep_acknowledgements() {
        let runtime = LaunchRuntime::default();
        assert!(runtime.is_tool_only());
        let stale_token = runtime.request_sleep();
        let current_token = runtime.request_sleep();
        assert!(!runtime.finish_sleep(stale_token));
        assert!(runtime.finish_sleep(current_token));
        assert!(!runtime.finish_sleep(current_token));
        let token = runtime.request_sleep();
        assert!(runtime.enter_main());
        assert!(!runtime.finish_sleep(token));
        assert!(!runtime.is_tool_only());
        assert!(!runtime.enter_main());
    }

    #[test]
    fn launcher_names_cannot_escape_the_selected_desktop() {
        let desktop = Path::new("C:/Users/Test/Desktop");
        assert_eq!(
            launcher_destination(desktop, "html-preview").unwrap(),
            desktop.join("DtKit - html-preview.lnk")
        );
        assert!(launcher_destination(desktop, "../escape").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn native_shortcuts_support_spaces_and_do_not_replace_existing_files() {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::{Interface, PCWSTR};
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED, STGM_READ,
        };
        use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};
        let root =
            std::env::temp_dir().join(format!("dtkit-launcher-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("Program with spaces.exe");
        let shortcut = root.join("Tool with spaces.lnk");
        std::fs::write(&executable, b"test").unwrap();
        write_tool_launcher(&executable, &shortcut, "html-preview").unwrap();
        let first = std::fs::read(&shortcut).unwrap();
        assert!(first.len() > 76);
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            {
                let link: IShellLinkW =
                    CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
                let persistent: IPersistFile = link.cast().unwrap();
                let shortcut_wide = shortcut
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>();
                persistent
                    .Load(PCWSTR(shortcut_wide.as_ptr()), STGM_READ)
                    .unwrap();
                let mut arguments = [0u16; 256];
                link.GetArguments(&mut arguments).unwrap();
                let text = |buffer: &[u16]| {
                    String::from_utf16_lossy(
                        &buffer[..buffer.iter().position(|value| *value == 0).unwrap()],
                    )
                };
                assert_eq!(text(&arguments), "--tool html-preview");
                let mut program = [0u16; 32768];
                link.GetPath(&mut program, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                    .unwrap();
                assert_eq!(PathBuf::from(text(&program)), executable);
            }
            CoUninitialize();
        }
        assert!(write_tool_launcher(&executable, &shortcut, "json-formatter").is_err());
        assert_eq!(std::fs::read(&shortcut).unwrap(), first);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
