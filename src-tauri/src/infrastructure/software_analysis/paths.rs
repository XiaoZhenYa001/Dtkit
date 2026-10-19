use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};

fn normalized(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

// Purely lexical: used by registry enumeration without touching each install directory.
pub(super) fn windows_policy(input: &str) -> Result<(), String> {
    if input.is_empty() || input.len() > 32767 || input.chars().any(char::is_control) {
        return Err("目录路径无效或过长".into());
    }
    let path = input.replace('/', "\\");
    let bytes = path.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return Err("只支持本机磁盘上的绝对目录，不扫描网络或设备路径".into());
    }
    if path[2..].contains(':') {
        return Err("不支持设备或数据流路径".into());
    }
    let parts: Vec<_> = path[3..]
        .split('\\')
        .filter(|part| !part.is_empty())
        .collect();
    if parts
        .iter()
        .any(|part| *part == "." || *part == ".." || part.ends_with(['.', ' ']))
    {
        return Err("请选择规范的绝对目录路径".into());
    }
    if parts.is_empty() {
        return Err("不能扫描整个磁盘，请选择具体软件目录".into());
    }
    let value = normalized(&path);
    let tail = &value[3..];
    if matches!(
        tail,
        "program files" | "program files (x86)" | "programdata" | "users"
    ) || tail == "windows"
        || tail.starts_with("windows\\")
        || (tail.starts_with("users\\") && parts.len() == 2)
        || (tail.starts_with("users\\")
            && parts.len() == 3
            && parts[2].eq_ignore_ascii_case("appdata"))
        || (tail.starts_with("users\\")
            && parts.len() == 4
            && parts[2].eq_ignore_ascii_case("appdata")
            && matches!(
                parts[3].to_ascii_lowercase().as_str(),
                "local" | "roaming" | "locallow"
            ))
    {
        return Err("这是系统或用户共享目录，请选择具体软件子目录".into());
    }
    if matches!(
        tail,
        "program files\\common files" | "program files (x86)\\common files"
    ) || (tail.starts_with("users\\")
        && parts.len() == 5
        && parts[2].eq_ignore_ascii_case("appdata")
        && parts[3].eq_ignore_ascii_case("local")
        && parts[4].eq_ignore_ascii_case("programs"))
    {
        return Err("这是多个软件共用的父目录，请选择具体软件子目录".into());
    }
    for key in [
        "USERPROFILE",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMW6432",
        "PROGRAMDATA",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "PUBLIC",
    ] {
        if std::env::var(key).is_ok_and(|parent| normalized(&parent) == value) {
            return Err("这是共享父目录，请选择具体软件子目录".into());
        }
    }
    if let Ok(windows) = std::env::var("WINDIR") {
        let windows = normalized(&windows);
        if value == windows || value.starts_with(&(windows + "\\")) {
            return Err("不扫描 Windows 系统目录".into());
        }
    }
    Ok(())
}

pub(super) fn validate_lexical(input: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return windows_policy(input);
    #[cfg(not(target_os = "windows"))]
    {
        let path = Path::new(input);
        if input.is_empty()
            || input.len() > 32767
            || input.chars().any(char::is_control)
            || !path.is_absolute()
            || path.parent().is_none()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return Err("请选择本机上的具体软件绝对目录".into());
        }
        Ok(())
    }
}

pub(super) fn is_reparse(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT also includes junctions/cloud placeholders.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(target_os = "windows"))]
    false
}

#[cfg(target_os = "windows")]
fn validate_drive(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    let Component::Prefix(prefix) = path.components().next().ok_or("目录没有磁盘")? else {
        return Err("目录没有磁盘".into());
    };
    let root = format!("{}\\", prefix.as_os_str().to_string_lossy());
    let wide: Vec<_> = std::ffi::OsStr::new(&root)
        .encode_wide()
        .chain(Some(0))
        .collect();
    match unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } {
        0 | 1 => Err("磁盘不可用".into()),
        4 => Err("不扫描网络映射磁盘".into()),
        _ => Ok(()),
    }
}

pub(super) fn validate_location(input: &str) -> Result<PathBuf, String> {
    validate_lexical(input)?;
    let path = Path::new(input);
    #[cfg(target_os = "windows")]
    validate_drive(path)?;
    // Inspect ancestors before canonicalization: do not silently follow a junction
    // into an unrelated tree (or a network share), including a linked root itself.
    let mut levels = 0;
    for ancestor in path.ancestors() {
        levels += 1;
        if levels > 128 {
            return Err("目录层级过深".into());
        }
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|error| format!("无法访问路径 {}：{error}", ancestor.display()))?;
        if is_reparse(&metadata) {
            return Err("不扫描或定位符号链接、目录联接及重解析点".into());
        }
    }
    let canonical = fs::canonicalize(path).map_err(|error| format!("无法解析目录：{error}"))?;
    #[cfg(target_os = "windows")]
    {
        let text = canonical.to_string_lossy();
        let normal = text.strip_prefix(r"\\?\").unwrap_or(&text);
        windows_policy(normal)?;
    }
    Ok(canonical)
}

pub(super) fn validate_root(input: &str) -> Result<PathBuf, String> {
    let root = validate_location(input)?;
    if !fs::metadata(&root)
        .map_err(|error| format!("无法读取目录信息：{error}"))?
        .is_dir()
    {
        return Err("请选择软件文件夹，不能扫描单个文件".into());
    }
    Ok(root)
}

pub(super) fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}
