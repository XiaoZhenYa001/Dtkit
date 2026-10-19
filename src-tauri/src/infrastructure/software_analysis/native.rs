use super::{catalog::Catalog, paths, Software, SoftwareSnapshot};
use std::path::Path;
use std::time::{Duration, Instant};
use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};
use winreg::RegKey;

const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const MAX_REGISTRATIONS_PER_VIEW: usize = 4096;
const ENUMERATION_BUDGET: Duration = Duration::from_secs(12);

fn text(key: &RegKey, name: &str) -> Option<String> {
    let value: String = key.get_value(name).ok()?;
    let value = value.trim().trim_end_matches('\0').trim();
    let max_len = match name {
        "InstallLocation" | "DisplayIcon" => 4096,
        "DisplayVersion" => 128,
        "InstallDate" => 64,
        _ => 512,
    };
    if value.is_empty() || value.len() > max_len || value.chars().any(char::is_control) {
        None
    } else {
        Some(value.to_string())
    }
}

fn expand_environment(input: &str) -> Option<String> {
    let mut output = String::new();
    let mut remaining = input;
    while let Some(start) = remaining.find('%') {
        output.push_str(&remaining[..start]);
        let tail = &remaining[start + 1..];
        let end = tail.find('%')?;
        let variable = std::env::var(&tail[..end]).ok()?;
        if output.len() + variable.len() > 32767 {
            return None;
        }
        output.push_str(&variable);
        remaining = &tail[end + 1..];
    }
    output.push_str(remaining);
    (output.len() <= 32767).then_some(output)
}

fn location(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value);
    expand_environment(value).map(|value| value.replace('/', "\\"))
}

fn icon_directory(value: &str) -> Option<String> {
    let value = value.trim();
    let executable = if let Some(quoted) = value.strip_prefix('"') {
        quoted.split_once('"')?.0
    } else if let Some((path, suffix)) = value.rsplit_once(',') {
        if suffix.trim().parse::<i32>().is_ok() {
            path
        } else {
            value
        }
    } else {
        value
    };
    let executable = location(executable)?;
    if !executable.to_ascii_lowercase().ends_with(".exe") {
        return None;
    }
    let parent = Path::new(&executable).parent()?.to_str()?.to_string();
    paths::windows_policy(&parent).ok()?;
    let normal = format!("{}\\", parent.to_lowercase());
    if [r"\installer\", r"\package cache\", r"\temp\", r"\cache\"]
        .iter()
        .any(|part| normal.contains(part))
    {
        return None;
    }
    Some(parent)
}

fn software(key: &RegKey, system: bool, bits: u32) -> Option<Software> {
    if key.get_value::<u32, _>("SystemComponent").ok() == Some(1)
        || text(key, "ParentKeyName").is_some()
    {
        return None;
    }
    let name = text(key, "DisplayName")?;
    let registered = text(key, "InstallLocation").and_then(|value| location(&value));
    let inferred = registered.is_none();
    let install_location =
        registered.or_else(|| text(key, "DisplayIcon").and_then(|value| icon_directory(&value)));
    let path_error = install_location
        .as_deref()
        .map(paths::windows_policy)
        .transpose()
        .err();
    let can_analyze = install_location.is_some() && path_error.is_none();
    let reason = if install_location.is_none() {
        Some("未登记可识别的安装目录，可手动选择软件文件夹".into())
    } else if let Some(error) = path_error {
        Some(error)
    } else if inferred {
        Some("安装目录由 DisplayIcon 路径推测，扫描前请确认目录归属".into())
    } else {
        None
    };
    // Registry EstimatedSize is KiB; explicit zero remains distinguishable from unknown.
    let estimated_bytes = key
        .get_value::<u32, _>("EstimatedSize")
        .ok()
        .map(|value| u64::from(value) * 1024);
    Some(Software {
        id: String::new(),
        name,
        version: text(key, "DisplayVersion"),
        publisher: text(key, "Publisher"),
        install_location,
        estimated_bytes,
        install_date: text(key, "InstallDate"),
        scope: if system { "system" } else { "user" }.into(),
        source: format!(
            "{} {bits} 位卸载注册表",
            if system { "HKLM" } else { "HKCU" }
        ),
        can_analyze,
        reason,
    })
}

pub(super) fn enumerate() -> Result<SoftwareSnapshot, String> {
    let started = Instant::now();
    let mut catalog = Catalog::default();
    let mut warnings = vec!["登记大小由软件安装程序提供；扫描大小按需计算，二者可能不同".into()];
    let mut unreadable = 0;
    let mut opened = 0;
    'views: for system in [false, true] {
        for bits in [64, 32] {
            let hive = RegKey::predef(if system {
                HKEY_LOCAL_MACHINE
            } else {
                HKEY_CURRENT_USER
            });
            let view = if bits == 64 {
                KEY_WOW64_64KEY
            } else {
                KEY_WOW64_32KEY
            };
            let root = match hive.open_subkey_with_flags(UNINSTALL, KEY_READ | view) {
                Ok(root) => {
                    opened += 1;
                    root
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    warnings.push(format!(
                        "无法读取 {} {bits} 位软件登记：{error}",
                        if system { "HKLM" } else { "HKCU" }
                    ));
                    continue;
                }
            };
            for (index, name) in root.enum_keys().enumerate() {
                if index >= MAX_REGISTRATIONS_PER_VIEW {
                    warnings.push("单个注册表视图达到 4096 项预算，软件列表可能不完整".into());
                    break;
                }
                if started.elapsed() >= ENUMERATION_BUDGET {
                    warnings.push("软件列表读取达到 12 秒预算，当前列表可能不完整".into());
                    break 'views;
                }
                let name = match name {
                    Ok(name) if name.len() <= 512 => name,
                    _ => {
                        unreadable += 1;
                        continue;
                    }
                };
                match root.open_subkey_with_flags(&name, KEY_READ | view) {
                    Ok(key) => {
                        if let Some(item) = software(&key, system, bits) {
                            catalog.insert(item);
                        }
                    }
                    Err(_) => unreadable += 1,
                }
            }
        }
    }
    if opened == 0 && warnings.len() > 1 {
        return Err("无法读取软件卸载登记，请检查注册表读取权限".into());
    }
    if unreadable > 0 {
        warnings.push(format!(
            "有 {unreadable} 项登记无法读取，当前列表可能不完整"
        ));
    }
    if catalog.truncated {
        warnings.push("软件列表达到 4096 项上限，已截断".into());
    }
    Ok(SoftwareSnapshot {
        items: catalog.finish(),
        scanned_at: chrono::Utc::now().timestamp_millis(),
        warnings,
        cached: false,
    })
}

pub(super) fn reveal(path: &Path) -> Result<(), String> {
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
            return Err(format!("文件位置定位初始化失败：{initialized:?}"));
        }
        let _com = ComGuard(initialized.is_ok());
        let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let pidl = ILCreateFromPathW(PCWSTR(wide.as_ptr()));
        if pidl.is_null() {
            return Err("无法在资源管理器中定位此路径".into());
        }
        let result = SHOpenFolderAndSelectItems(pidl, None, 0);
        ILFree(Some(pidl));
        result.map_err(|error| format!("打开软件位置失败：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_icon_is_only_a_conservative_path_hint() {
        assert_eq!(
            icon_directory(r#""C:\Program Files\Example\app.exe",0"#),
            Some(r"C:\Program Files\Example".into())
        );
        assert!(icon_directory(r"C:\Windows\System32\msiexec.exe,0").is_none());
        assert!(icon_directory(r"C:\ProgramData\Package Cache\abc\setup.exe,0").is_none());
        assert!(icon_directory(r"\\server\share\app.exe").is_none());
        assert!(icon_directory(r"C:\Program Files\app.exe").is_none());
    }
}
