use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Manager};

const PORTABLE_MARKER: &str = "portable.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StorageMode {
    Standard,
    Portable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageLayout {
    pub(crate) mode: StorageMode,
    pub(crate) root: PathBuf,
    pub(crate) config: PathBuf,
    pub(crate) cache: PathBuf,
    pub(crate) logs: PathBuf,
    pub(crate) temp_transfer: PathBuf,
    pub(crate) jobs: PathBuf,
    pub(crate) recovery: PathBuf,
    pub(crate) writable: bool,
    pub(crate) warning: Option<String>,
}

impl StorageLayout {
    pub(crate) fn from_root(mode: StorageMode, root: PathBuf) -> Self {
        Self {
            mode,
            config: root.join("config"),
            cache: root.join("cache"),
            logs: root.join("logs"),
            temp_transfer: root.join("temp-transfer"),
            jobs: root.join("jobs"),
            recovery: root.join("recovery"),
            root,
            writable: false,
            warning: None,
        }
    }

    pub(crate) fn managed_directories(&self) -> [&Path; 6] {
        [
            &self.config,
            &self.cache,
            &self.logs,
            &self.temp_transfer,
            &self.jobs,
            &self.recovery,
        ]
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageUsage {
    pub(crate) cache_bytes: u64,
    pub(crate) log_bytes: u64,
    pub(crate) temp_transfer_bytes: u64,
    pub(crate) job_bytes: u64,
    pub(crate) recovery_bytes: u64,
}

#[derive(Default)]
pub(crate) struct StorageManager(RwLock<Option<StorageLayout>>);

impl StorageManager {
    pub(crate) fn initialize(&self, app: &AppHandle) -> Result<StorageLayout, String> {
        let executable =
            std::env::current_exe().map_err(|error| format!("无法确定程序路径: {error}"))?;
        let standard_root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法确定应用数据目录: {error}"))?;
        let layout = prepare_layout(&executable, standard_root)?;
        *self
            .0
            .write()
            .map_err(|_| "存储管理器状态不可用".to_string())? = Some(layout.clone());
        Ok(layout)
    }

    pub(crate) fn layout(&self) -> Result<StorageLayout, String> {
        self.0
            .read()
            .map_err(|_| "存储管理器状态不可用".to_string())?
            .clone()
            .ok_or_else(|| "存储管理器尚未初始化".to_string())
    }

    pub(crate) fn config_file(&self, name: &str) -> Result<PathBuf, String> {
        if !is_safe_file_name(name) {
            return Err("配置文件名不安全".to_string());
        }
        Ok(self.layout()?.config.join(name))
    }

    pub(crate) fn usage(&self) -> Result<StorageUsage, String> {
        let layout = self.layout()?;
        Ok(StorageUsage {
            cache_bytes: directory_size(&layout.cache)?,
            log_bytes: directory_size(&layout.logs)?,
            temp_transfer_bytes: directory_size(&layout.temp_transfer)?,
            job_bytes: directory_size(&layout.jobs)?,
            recovery_bytes: directory_size(&layout.recovery)?,
        })
    }
}

fn prepare_layout(executable: &Path, standard_root: PathBuf) -> Result<StorageLayout, String> {
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "程序路径缺少父目录".to_string())?;
    let portable = executable_dir.join(PORTABLE_MARKER).is_file();
    let mode = if portable {
        StorageMode::Portable
    } else {
        StorageMode::Standard
    };
    let root = if portable {
        executable_dir.join("data")
    } else {
        standard_root
    };

    let mut layout = StorageLayout::from_root(mode, root);
    let mut warnings = Vec::new();
    if let Err(error) = fs::create_dir_all(&layout.root) {
        warnings.push(format!("创建数据目录失败: {error}"));
    }
    for directory in layout.managed_directories() {
        if let Err(error) = fs::create_dir_all(directory) {
            warnings.push(format!(
                "创建受管目录失败（{}）: {error}",
                directory.display()
            ));
        }
    }
    layout.writable = verify_writable(&layout.root);
    if !layout.writable {
        warnings.push(format!("数据目录不可写: {}", layout.root.display()));
    }
    layout.warning = (!warnings.is_empty()).then(|| warnings.join("；"));
    Ok(layout)
}

fn verify_writable(root: &Path) -> bool {
    let probe = root.join(format!(".dtkit-write-probe-{}", std::process::id()));
    let result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|mut file| file.write_all(b"dtkit"));
    let _ = fs::remove_file(&probe);
    result.is_ok()
}

fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        && !name.starts_with('.')
        && !name.contains("..")
}

fn directory_size(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }

    let mut total = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("读取目录失败（{}）: {error}", directory.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
            let metadata = entry
                .path()
                .symlink_metadata()
                .map_err(|error| format!("读取文件信息失败: {error}"))?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

#[tauri::command]
pub(crate) fn get_storage_layout(
    manager: tauri::State<'_, StorageManager>,
) -> Result<StorageLayout, String> {
    manager.layout()
}

#[tauri::command]
pub(crate) fn get_storage_usage(
    manager: tauri::State<'_, StorageManager>,
) -> Result<StorageUsage, String> {
    manager.usage()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dtkit-storage-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn portable_marker_moves_all_managed_paths_next_to_executable() {
        let root = test_root("portable");
        let executable_dir = root.join("bin");
        fs::create_dir_all(&executable_dir).unwrap();
        fs::write(executable_dir.join(PORTABLE_MARKER), b"{}").unwrap();
        let executable = executable_dir.join("DtKit.exe");

        let layout = prepare_layout(&executable, root.join("standard")).unwrap();
        assert_eq!(layout.mode, StorageMode::Portable);
        assert_eq!(layout.root, executable_dir.join("data"));
        assert!(layout
            .managed_directories()
            .iter()
            .all(|path| path.is_dir()));
        assert!(layout.writable);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn standard_mode_uses_the_application_data_root() {
        let root = test_root("standard");
        let executable_dir = root.join("bin");
        fs::create_dir_all(&executable_dir).unwrap();
        let standard_root = root.join("app-data");

        let layout =
            prepare_layout(&executable_dir.join("DtKit.exe"), standard_root.clone()).unwrap();
        assert_eq!(layout.mode, StorageMode::Standard);
        assert_eq!(layout.root, standard_root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsafe_config_names_are_rejected() {
        assert!(is_safe_file_name("shortcuts.json"));
        assert!(!is_safe_file_name("../shortcuts.json"));
        assert!(!is_safe_file_name(".hidden"));
        assert!(!is_safe_file_name("a/b.json"));
    }

    #[test]
    fn usage_skips_symbolic_links_and_counts_regular_files() {
        let root = test_root("usage");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("a.bin"), vec![0_u8; 5]).unwrap();
        fs::write(root.join("nested").join("b.bin"), vec![0_u8; 7]).unwrap();
        assert_eq!(directory_size(&root).unwrap(), 12);
        fs::remove_dir_all(root).unwrap();
    }
}
