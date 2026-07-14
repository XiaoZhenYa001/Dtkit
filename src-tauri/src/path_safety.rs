use std::ffi::OsStr;
use std::path::{Component, Path};

/// Validates a single file-name component without allowing directory traversal.
pub(crate) fn validate_leaf_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() || filename.trim() != filename {
        return Err("文件名不能为空，也不能以空格开头或结尾".to_string());
    }

    if filename.encode_utf16().count() > 255 {
        return Err("文件名过长".to_string());
    }

    let path = Path::new(filename);
    let mut components = path.components();
    let is_single_normal_component = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && path.file_name() == Some(OsStr::new(filename));

    if !is_single_normal_component {
        return Err("文件名不能包含目录或路径跳转".to_string());
    }

    if filename
        .chars()
        .any(|character| character.is_control() || r#"<>:\/|?*"#.contains(character))
    {
        return Err("文件名包含 Windows 不支持的字符".to_string());
    }

    if filename.ends_with('.') {
        return Err("文件名不能以句点结尾".to_string());
    }

    let stem = filename
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let is_reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .and_then(|value| value.parse::<u8>().ok())
            .is_some_and(|number| (1..=9).contains(&number))
        || stem
            .strip_prefix("LPT")
            .and_then(|value| value.parse::<u8>().ok())
            .is_some_and(|number| (1..=9).contains(&number));

    if is_reserved {
        return Err("文件名使用了 Windows 保留名称".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_leaf_filename;

    #[test]
    fn accepts_normal_file_names() {
        assert!(validate_leaf_filename("archive-2026.07.zip").is_ok());
        assert!(validate_leaf_filename("二维码.png").is_ok());
    }

    #[test]
    fn rejects_paths_and_traversal() {
        for filename in [
            "../escape.exe",
            r"..\escape.exe",
            r"C:\escape.exe",
            "/tmp/escape",
        ] {
            assert!(validate_leaf_filename(filename).is_err(), "{filename}");
        }
    }

    #[test]
    fn rejects_windows_reserved_names_and_characters() {
        for filename in ["CON", "con.txt", "LPT1.log", "bad:name.txt", "trailing."] {
            assert!(validate_leaf_filename(filename).is_err(), "{filename}");
        }
    }
}
