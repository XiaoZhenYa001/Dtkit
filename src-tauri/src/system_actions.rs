use std::path::Path;
#[cfg(target_os = "windows")]
use std::process::Command;

const ALLOWED_PROGRAM_EXTENSIONS: &[&str] = &["exe", "com", "bat", "cmd", "ps1"];
const RELEASES_PAGE: &str = "https://github.com/XiaoZhenYa001/Dtkit/releases";

#[tauri::command]
pub(crate) fn open_release_page() -> Result<(), String> {
    opener::open(RELEASES_PAGE).map_err(|error| format!("打开发布页失败: {error}"))
}

#[tauri::command]
pub(crate) fn run_program(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err("所选程序不存在或不是文件".to_string());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "所选文件缺少扩展名".to_string())?;

    if !ALLOWED_PROGRAM_EXTENSIONS.contains(&extension.as_str()) {
        return Err("仅允许运行 exe、com、bat、cmd 或 ps1 文件".to_string());
    }

    opener::open(path).map_err(|error| format!("启动程序失败: {error}"))
}

#[tauri::command]
pub(crate) fn schedule_shutdown() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("shutdown")
            .args(["/s", "/t", "60"])
            .spawn()
            .map_err(|error| format!("设置延迟关机失败: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    Err("延迟关机目前仅支持 Windows".to_string())
}

#[tauri::command]
pub(crate) fn lock_screen() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32.exe")
            .arg("user32.dll,LockWorkStation")
            .spawn()
            .map_err(|error| format!("锁定屏幕失败: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    Err("锁定屏幕目前仅支持 Windows".to_string())
}
