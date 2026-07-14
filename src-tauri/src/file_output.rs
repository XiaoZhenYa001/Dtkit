use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use crate::path_safety::validate_leaf_filename;

const MAX_QR_FILE_SIZE: usize = 50 * 1024 * 1024;
const ALLOWED_QR_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "svg"];

#[tauri::command]
pub(crate) fn write_qr_code(
    directory: String,
    filename: String,
    data: Vec<u8>,
) -> Result<String, String> {
    validate_leaf_filename(&filename)?;

    if !filename.starts_with("qrcode-") {
        return Err("二维码文件名格式无效".to_string());
    }

    let extension = Path::new(&filename)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "二维码文件缺少扩展名".to_string())?;

    if !ALLOWED_QR_EXTENSIONS.contains(&extension.as_str()) {
        return Err("不支持的二维码文件格式".to_string());
    }

    if data.is_empty() || data.len() > MAX_QR_FILE_SIZE {
        return Err("二维码文件为空或超过 50 MiB 限制".to_string());
    }

    let directory = Path::new(&directory);
    fs::create_dir_all(directory).map_err(|error| format!("创建保存目录失败: {error}"))?;

    let destination = directory.join(&filename);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| format!("创建二维码文件失败: {error}"))?;

    file.write_all(&data)
        .map_err(|error| format!("写入二维码文件失败: {error}"))?;

    Ok(destination.to_string_lossy().into_owned())
}
