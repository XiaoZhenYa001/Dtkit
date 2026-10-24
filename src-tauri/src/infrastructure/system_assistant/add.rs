use super::*;

fn shortcut_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let stem = if name.to_ascii_lowercase().ends_with(".lnk") {
        &name[..name.len() - 4]
    } else {
        name
    };
    if stem.is_empty() || stem.encode_utf16().count() > 100 {
        return Err("显示名称应为 1–100 个字符".into());
    }
    crate::path_safety::validate_leaf_filename(stem)?;
    let result = format!("{stem}.lnk");
    crate::path_safety::validate_leaf_filename(&result)?;
    Ok(result)
}

fn normal_local_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|e| format!("无法确认本地路径: {e}"))?;
    let value = canonical.to_str().ok_or("路径包含无法表示的字符")?;
    let result = PathBuf::from(value.strip_prefix(r"\\?\").unwrap_or(value));
    if !is_local_path(&result) {
        return Err("请选择本地磁盘中的程序或目录".into());
    }
    Ok(result)
}

fn user_startup_directory() -> Result<PathBuf, String> {
    let directory = startup_directories()
        .into_iter()
        .find(|(scope, _, _)| *scope == StartupScope::User)
        .map(|(_, _, path)| path)
        .ok_or("无法读取当前用户的启动文件夹")?;
    if !ordinary_local_directory(&directory)? {
        return Err("启动文件夹不是可安全管理的本地目录".into());
    }
    // Resolve the existing ancestor before creating anything, so an ancestor
    // junction cannot redirect creation to a network share.
    let mut ancestor = directory.as_path();
    while !ancestor
        .try_exists()
        .map_err(|e| format!("无法检查启动目录: {e}"))?
    {
        ancestor = ancestor.parent().ok_or("启动目录无效")?;
    }
    normal_local_path(ancestor)?;
    fs::create_dir_all(&directory).map_err(|e| format!("无法创建启动文件夹: {e}"))?;
    if !ordinary_local_directory(&directory)? {
        return Err("启动文件夹在操作期间发生变化".into());
    }
    normal_local_path(&directory)?;
    Ok(directory)
}

#[cfg(target_os = "windows")]
fn write_shortcut(executable: &Path, destination: &Path, arguments: &str) -> Result<(), String> {
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
            return Err(format!("无法初始化快捷方式接口: {initialized:?}"));
        }
        let _guard = ComGuard(initialized.is_ok());
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("无法创建启动快捷方式: {e}"))?;
        let target = wide(executable.as_os_str());
        let args = wide(std::ffi::OsStr::new(arguments));
        let directory = wide(executable.parent().ok_or("程序目录无效")?.as_os_str());
        link.SetPath(PCWSTR(target.as_ptr()))
            .map_err(|e| e.to_string())?;
        link.SetArguments(PCWSTR(args.as_ptr()))
            .map_err(|e| e.to_string())?;
        link.SetWorkingDirectory(PCWSTR(directory.as_ptr()))
            .map_err(|e| e.to_string())?;
        link.SetIconLocation(PCWSTR(target.as_ptr()), 0)
            .map_err(|e| e.to_string())?;
        let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        let path = wide(destination.as_os_str());
        persist
            .Save(PCWSTR(path.as_ptr()), true)
            .map_err(|e| format!("保存启动快捷方式失败: {e}"))?;
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("写入启动快捷方式失败: {e}"))
}

#[cfg(target_os = "windows")]
fn create_startup_item(
    layout: &StorageLayout,
    path: &str,
    name: &str,
    arguments: &str,
) -> Result<(), String> {
    if arguments.contains('\0') || arguments.encode_utf16().count() > 4096 {
        return Err("启动参数过长或包含无效字符".into());
    }
    let filename = shortcut_name(name)?;
    let selected = PathBuf::from(path);
    if path.contains('\0')
        || !is_local_path(&selected)
        || !selected
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("请选择本地磁盘中的 .exe 程序".into());
    }
    let signature = file_fingerprint(&selected)?;
    let executable = normal_local_path(&selected)?;
    let store = read_store(layout)?;
    let directory = user_startup_directory()?;
    let destination = directory.join(filename);
    let id = folder_id(StartupScope::User, &destination);
    if store.folder_items.iter().any(|item| item.id == id) {
        return Err("该名称仍有恢复记录，请先恢复旧启动项或使用其他名称".into());
    }
    if destination
        .try_exists()
        .map_err(|e| format!("无法检查同名启动项: {e}"))?
    {
        return Err("已存在同名启动项，请使用其他名称".into());
    }
    let approval = folder_approval(
        StartupScope::User,
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("启动文件名无效")?,
    )?;
    if !approval_state(approval.as_ref())? {
        return Err("该名称已被 Windows 启动设置停用，请换一个名称或在系统设置中调整".into());
    }
    // Stage outside Startup: an interrupted write must never leave an extra
    // executable startup shortcut or an incomplete file in the login folder.
    let staging = directory
        .parent()
        .ok_or("启动文件夹位置无效")?
        .join(format!(".dtkit-startup-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|e| format!("无法创建临时快捷方式目录: {e}"))?;
    let temporary = staging.join("startup.lnk");
    let result = (|| {
        write_shortcut(&executable, &temporary, arguments)?;
        if file_fingerprint(&selected)? != signature {
            return Err("程序文件在操作期间发生变化，请重新选择".into());
        }
        move_file_without_overwrite(&temporary, &destination)
            .map_err(|e| format!("发布启动快捷方式失败（不会覆盖同名文件）: {e}"))
    })();
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_dir(&staging);
    result
}

#[tauri::command]
pub(crate) async fn add_system_startup_item(
    window: WebviewWindow,
    tool_id: String,
    path: String,
    name: String,
    arguments: Option<String>,
) -> Result<StartupSnapshot, String> {
    authorize(&window, &tool_id)?;
    let app = window.app_handle().clone();
    let _work = super::super::launch::keep_native_work(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<SystemAssistantManager>();
        let _guard = manager.migration_guard()?;
        authorize_module(&app, &tool_id)?;
        let layout = app.state::<StorageManager>().layout()?;
        #[cfg(target_os = "windows")]
        {
            create_startup_item(
                &layout,
                &path,
                &name,
                arguments.as_deref().unwrap_or_default(),
            )?;
            scan(&layout)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (layout, path, name, arguments);
            Err("添加启动项目前仅支持 Windows".into())
        }
    })
    .await
    .map_err(|e| format!("添加启动项任务异常: {e}"))?
}

#[tauri::command]
pub(crate) async fn open_system_startup_folder(
    window: WebviewWindow,
    tool_id: String,
) -> Result<(), String> {
    authorize(&window, &tool_id)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        authorize_module(&app, &tool_id)?;
        let directory = user_startup_directory()?;
        opener::open(directory).map_err(|e| format!("打开启动文件夹失败: {e}"))
    })
    .await
    .map_err(|e| format!("打开启动文件夹任务异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_cannot_escape_startup_or_use_device_names() {
        for name in [
            "",
            "../escape",
            "C:\\bad",
            "CON",
            "nul.txt",
            "bad.",
            "COM1",
            "a\0b",
        ] {
            assert!(shortcut_name(name).is_err(), "{name:?}");
        }
        assert_eq!(shortcut_name("中文 软件.LNK").unwrap(), "中文 软件.lnk");
        assert!(shortcut_name(&"a".repeat(101)).is_err());
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn shell_link_round_trips_unicode_target_without_executing_it() {
        let root =
            std::env::temp_dir().join(format!("dtkit-startup-link-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let exe = root.join("本地 程序.exe");
        fs::write(&exe, b"fixture, never executed").unwrap();
        let output = root.join("测试快捷方式.lnk");
        write_shortcut(&exe, &output, "--profile \"中文 用户\" --quiet").unwrap();
        assert_eq!(shortcut_target(&output).as_ref(), Some(&exe));
        fs::remove_file(output).unwrap();
        fs::remove_file(exe).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
