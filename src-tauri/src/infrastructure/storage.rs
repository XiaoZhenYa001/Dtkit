use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Manager};

const PORTABLE_MARKER: &str = "portable.json";
const ROOT_POINTER_FILE: &str = "storage-root.json";

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
    pub(crate) downloads: PathBuf,
    pub(crate) kits: PathBuf,
    pub(crate) whiteboards: PathBuf,
    pub(crate) passwords: PathBuf,
    pub(crate) backups: PathBuf,
    pub(crate) trash: PathBuf,
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
            downloads: root.join("Downloads"),
            kits: root.join("Kits"),
            whiteboards: root.join("Kits").join("Whiteboards"),
            passwords: root.join("Kits").join("Passwords"),
            backups: root.join("Backups"),
            trash: root.join("Trash"),
            config: root.join("Config"),
            cache: root.join("Cache"),
            logs: root.join("Logs"),
            temp_transfer: root.join("Kits").join("TransferStation"),
            jobs: root.join("Kits").join("Jobs"),
            recovery: root.join("Trash").join("Recovery"),
            root,
            writable: false,
            warning: None,
        }
    }

    pub(crate) fn managed_directories(&self) -> [&Path; 12] {
        [
            &self.downloads,
            &self.kits,
            &self.whiteboards,
            &self.passwords,
            &self.backups,
            &self.trash,
            &self.config,
            &self.cache,
            &self.logs,
            &self.temp_transfer,
            &self.jobs,
            &self.recovery,
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPointer {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageMigrationResult {
    layout: StorageLayout,
    files_copied: u64,
    bytes_copied: u64,
    previous_root: PathBuf,
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
pub(crate) struct StorageManager {
    layout: RwLock<Option<StorageLayout>>,
    bootstrap_file: RwLock<Option<PathBuf>>,
}

impl StorageManager {
    pub(crate) fn initialize(&self, app: &AppHandle) -> Result<StorageLayout, String> {
        let executable =
            std::env::current_exe().map_err(|error| format!("无法确定程序路径: {error}"))?;
        let standard_root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法确定应用数据目录: {error}"))?;
        let local_root = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("无法确定本地配置目录: {error}"))?;
        let bootstrap_file = bootstrap_file(&executable, &local_root)?;
        let layout = prepare_configured_layout(&executable, standard_root, &bootstrap_file)?;
        *self
            .layout
            .write()
            .map_err(|_| "存储管理器状态不可用".to_string())? = Some(layout.clone());
        *self
            .bootstrap_file
            .write()
            .map_err(|_| "存储管理器状态不可用".to_string())? = Some(bootstrap_file);
        Ok(layout)
    }

    pub(crate) fn layout(&self) -> Result<StorageLayout, String> {
        let layout = self
            .layout
            .read()
            .map_err(|_| "存储管理器状态不可用".to_string())?
            .clone()
            .ok_or_else(|| "存储管理器尚未初始化".to_string())?;
        if !layout.root.is_dir() {
            return Err(layout
                .warning
                .clone()
                .unwrap_or_else(|| format!("DtKit 数据根目录不可用: {}", layout.root.display())));
        }
        Ok(layout)
    }

    fn status_layout(&self) -> Result<StorageLayout, String> {
        self.layout
            .read()
            .map_err(|_| "存储管理器状态不可用".to_string())?
            .clone()
            .ok_or_else(|| "存储管理器尚未初始化".to_string())
    }

    fn bootstrap_file(&self) -> Result<PathBuf, String> {
        self.bootstrap_file
            .read()
            .map_err(|_| "存储管理器状态不可用".to_string())?
            .clone()
            .ok_or_else(|| "存储根目录配置尚未初始化".to_string())
    }

    fn replace_layout(&self, layout: StorageLayout) -> Result<(), String> {
        *self
            .layout
            .write()
            .map_err(|_| "存储管理器状态不可用".to_string())? = Some(layout);
        Ok(())
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

fn bootstrap_file(executable: &Path, local_root: &Path) -> Result<PathBuf, String> {
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "程序路径缺少父目录".to_string())?;
    Ok(if executable_dir.join(PORTABLE_MARKER).is_file() {
        executable_dir.join(ROOT_POINTER_FILE)
    } else {
        local_root.join("Bootstrap").join(ROOT_POINTER_FILE)
    })
}

fn prepare_configured_layout(
    executable: &Path,
    standard_root: PathBuf,
    bootstrap_file: &Path,
) -> Result<StorageLayout, String> {
    if bootstrap_file.is_file() {
        let pointer: RootPointer = serde_json::from_slice(
            &fs::read(bootstrap_file)
                .map_err(|error| format!("读取数据根目录配置失败: {error}"))?,
        )
        .map_err(|error| format!("数据根目录配置无效: {error}"))?;
        let executable_dir = executable
            .parent()
            .ok_or_else(|| "程序路径缺少父目录".to_string())?;
        let mode = if executable_dir.join(PORTABLE_MARKER).is_file() {
            StorageMode::Portable
        } else {
            StorageMode::Standard
        };
        let mut layout = StorageLayout::from_root(mode, pointer.root);
        if !layout.root.is_dir() {
            layout.warning = Some(format!("DtKit 数据根目录不可用: {}", layout.root.display()));
            return Ok(layout);
        }
        layout.writable = verify_writable(&layout.root);
        if !layout.writable {
            layout.warning = Some(format!("DtKit 数据根目录为只读: {}", layout.root.display()));
        } else {
            prepare_managed_directories(&layout)?;
            adopt_legacy_directories(&layout)?;
        }
        return Ok(layout);
    }
    prepare_layout(executable, standard_root)
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
    if let Err(error) = prepare_managed_directories(&layout) {
        warnings.push(error);
    }
    if let Err(error) = adopt_legacy_directories(&layout) {
        warnings.push(error);
    }
    layout.writable = verify_writable(&layout.root);
    if !layout.writable {
        warnings.push(format!("数据目录不可写: {}", layout.root.display()));
    }
    layout.warning = (!warnings.is_empty()).then(|| warnings.join("；"));
    Ok(layout)
}

fn prepare_managed_directories(layout: &StorageLayout) -> Result<(), String> {
    for directory in layout.managed_directories() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("创建受管目录失败（{}）: {error}", directory.display()))?;
    }
    Ok(())
}

fn adopt_legacy_directories(layout: &StorageLayout) -> Result<(), String> {
    let mappings = [
        (layout.root.join("config"), layout.config.clone()),
        (layout.root.join("cache"), layout.cache.clone()),
        (layout.root.join("logs"), layout.logs.clone()),
        (
            layout.root.join("temp-transfer"),
            layout.temp_transfer.clone(),
        ),
        (layout.root.join("jobs"), layout.jobs.clone()),
        (layout.root.join("recovery"), layout.recovery.clone()),
    ];
    for (legacy, current) in mappings {
        let same_directory = legacy == current
            || (legacy.exists()
                && current.exists()
                && fs::canonicalize(&legacy).ok() == fs::canonicalize(&current).ok());
        if !legacy.is_dir() || same_directory {
            continue;
        }
        for entry in fs::read_dir(&legacy)
            .map_err(|error| format!("读取旧数据目录失败（{}）: {error}", legacy.display()))?
        {
            let entry = entry.map_err(|error| format!("读取旧数据目录项失败: {error}"))?;
            let destination = current.join(entry.file_name());
            if destination.exists() {
                continue;
            }
            fs::rename(entry.path(), &destination).map_err(|error| {
                format!("迁移旧数据失败（{}）: {error}", entry.path().display())
            })?;
        }
        let _ = fs::remove_dir(&legacy);
    }
    Ok(())
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

fn validate_migration_target(source: &Path, target: &Path) -> Result<(), String> {
    if !target.is_absolute() || target.parent().is_none() {
        return Err("请选择一个完整且安全的 DtKit 数据根目录".to_string());
    }
    if source == target || target.starts_with(source) || source.starts_with(target) {
        return Err("新旧数据目录不能相同，也不能互相包含".to_string());
    }
    if target.exists() {
        if !target.is_dir() {
            return Err("目标路径不是文件夹".to_string());
        }
        if fs::read_dir(target)
            .map_err(|error| format!("读取目标目录失败: {error}"))?
            .next()
            .is_some()
        {
            return Err("目标目录必须为空，避免覆盖已有文件".to_string());
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, target: &Path) -> Result<(u64, u64), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建迁移目录失败: {error}"))?;
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((from, to)) = pending.pop() {
        for entry in fs::read_dir(&from)
            .map_err(|error| format!("读取迁移源目录失败（{}）: {error}", from.display()))?
        {
            let entry = entry.map_err(|error| format!("读取迁移目录项失败: {error}"))?;
            let metadata = entry
                .path()
                .symlink_metadata()
                .map_err(|error| format!("读取迁移文件信息失败: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "数据根目录包含不安全的符号链接: {}",
                    entry.path().display()
                ));
            }
            let destination = to.join(entry.file_name());
            if metadata.is_dir() {
                fs::create_dir_all(&destination)
                    .map_err(|error| format!("创建迁移子目录失败: {error}"))?;
                pending.push((entry.path(), destination));
            } else if metadata.is_file() {
                if destination.exists() {
                    return Err(format!(
                        "迁移遇到同名文件，未执行覆盖: {}",
                        destination.display()
                    ));
                }
                let source_path = entry.path();
                fs::copy(&source_path, &destination).map_err(|error| {
                    format!("复制文件失败（{}）: {error}", entry.path().display())
                })?;
                verify_copied_file(&source_path, &destination)?;
                files = files.saturating_add(1);
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok((files, bytes))
}

fn file_sha256(path: &Path) -> Result<[u8; 32], String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path)
        .map_err(|error| format!("打开迁移校验文件失败（{}）: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取迁移校验文件失败（{}）: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

fn verify_copied_file(source: &Path, destination: &Path) -> Result<(), String> {
    if file_sha256(source)? != file_sha256(destination)? {
        return Err(format!(
            "迁移文件完整性校验失败，未切换数据目录: {}",
            source.display()
        ));
    }
    Ok(())
}

fn write_root_pointer(path: &Path, root: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "根目录配置缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建启动配置目录失败: {error}"))?;
    let temporary = parent.join(format!(".{ROOT_POINTER_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let payload = serde_json::to_vec_pretty(&RootPointer {
        root: root.to_path_buf(),
    })
    .map_err(|error| format!("序列化根目录配置失败: {error}"))?;
    fs::write(&temporary, payload).map_err(|error| format!("写入根目录配置失败: {error}"))?;
    let backup = parent.join(format!(".{ROOT_POINTER_FILE}.backup"));
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|error| format!("备份旧根目录配置失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!("提交根目录配置失败: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn migrate_layout(
    current: &StorageLayout,
    bootstrap_file: &Path,
    target: PathBuf,
    legacy_download_root: Option<PathBuf>,
) -> Result<StorageMigrationResult, String> {
    if !current.root.is_dir() {
        return Err("当前数据根目录不可用，无法安全迁移".to_string());
    }
    validate_migration_target(&current.root, &target)?;
    let parent = target
        .parent()
        .ok_or_else(|| "目标目录缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建目标父目录失败: {error}"))?;
    let staging = parent.join(format!(".dtkit-migration-{}", uuid::Uuid::new_v4()));
    let migration = (|| {
        let (mut files_copied, mut bytes_copied) = copy_tree(&current.root, &staging)?;
        if let Some(legacy) = legacy_download_root {
            let same_as_managed = legacy.exists()
                && current.downloads.exists()
                && fs::canonicalize(&legacy).ok() == fs::canonicalize(&current.downloads).ok();
            if !same_as_managed {
                if !legacy.is_dir() {
                    return Err(format!(
                        "旧下载目录不可用，已停止迁移以避免遗漏文件: {}",
                        legacy.display()
                    ));
                }
                let (legacy_files, legacy_bytes) = copy_tree(&legacy, &staging.join("Downloads"))?;
                files_copied = files_copied.saturating_add(legacy_files);
                bytes_copied = bytes_copied.saturating_add(legacy_bytes);
            }
        }
        let staged_bytes = directory_size(&staging)?;
        if staged_bytes != bytes_copied {
            return Err("迁移校验失败：目标文件大小与源数据不一致".to_string());
        }
        if target.exists() {
            fs::remove_dir(&target).map_err(|error| format!("准备空目标目录失败: {error}"))?;
        }
        fs::rename(&staging, &target).map_err(|error| format!("提交迁移目录失败: {error}"))?;
        let mut layout = StorageLayout::from_root(current.mode, target);
        layout.writable = verify_writable(&layout.root);
        if !layout.writable {
            let _ = fs::remove_dir_all(&layout.root);
            return Err("迁移后的数据根目录不可写，已拒绝切换".to_string());
        }
        if let Err(error) = write_root_pointer(bootstrap_file, &layout.root) {
            let _ = fs::remove_dir_all(&layout.root);
            return Err(error);
        }
        Ok(StorageMigrationResult {
            layout,
            files_copied,
            bytes_copied,
            previous_root: current.root.clone(),
        })
    })();
    if migration.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    migration
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
    manager.status_layout()
}

#[tauri::command]
pub(crate) fn get_storage_usage(
    manager: tauri::State<'_, StorageManager>,
) -> Result<StorageUsage, String> {
    manager.usage()
}

#[tauri::command]
pub(crate) async fn migrate_storage_root(
    app: AppHandle,
    target_root: String,
    legacy_download_root: Option<String>,
) -> Result<StorageMigrationResult, String> {
    if app.state::<super::jobs::JobManager>().active_count() > 0 {
        return Err("请等待当前文件任务完成后再迁移文件目录".to_string());
    }
    if app
        .state::<super::transfer_station::TransferStationManager>()
        .has_active_share()
        .await
    {
        return Err("请先停止局域网文件分享，再迁移文件目录".to_string());
    }
    if app
        .state::<super::quick_host::QuickHostManager>()
        .has_active_content()
    {
        return Err("请先关闭快捷工具窗口，再迁移文件目录".to_string());
    }
    let manager = app.state::<StorageManager>();
    let current = manager.layout()?;
    let bootstrap_file = manager.bootstrap_file()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        migrate_layout(
            &current,
            &bootstrap_file,
            PathBuf::from(target_root),
            legacy_download_root.map(PathBuf::from),
        )
    })
    .await
    .map_err(|error| format!("迁移任务异常结束: {error}"))??;
    app.state::<StorageManager>()
        .replace_layout(result.layout.clone())?;
    app.state::<super::passwords::PasswordVaultManager>()
        .reset_for_storage_change();
    Ok(result)
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

    #[test]
    fn managed_layout_keeps_tool_data_under_one_predictable_root() {
        let root = test_root("hierarchy");
        let layout = StorageLayout::from_root(StorageMode::Standard, root.clone());
        assert_eq!(layout.downloads, root.join("Downloads"));
        assert_eq!(layout.whiteboards, root.join("Kits").join("Whiteboards"));
        assert_eq!(layout.passwords, root.join("Kits").join("Passwords"));
        assert_eq!(
            layout.temp_transfer,
            root.join("Kits").join("TransferStation")
        );
        assert_eq!(layout.recovery, root.join("Trash").join("Recovery"));
    }

    #[test]
    fn migration_copies_and_verifies_data_before_switching_the_pointer() {
        let sandbox = test_root("migration");
        let source = sandbox.join("old-root");
        let executable_dir = sandbox.join("bin");
        fs::create_dir_all(&executable_dir).unwrap();
        let current = prepare_layout(&executable_dir.join("DtKit.exe"), source).unwrap();
        fs::write(current.config.join("shortcuts.json"), b"shortcut-data").unwrap();
        fs::write(current.whiteboards.join("index.json"), b"board-index").unwrap();
        let legacy_downloads = sandbox.join("legacy-downloads");
        fs::create_dir_all(&legacy_downloads).unwrap();
        fs::write(legacy_downloads.join("existing.zip"), b"download-data").unwrap();
        let bootstrap = sandbox.join("bootstrap").join(ROOT_POINTER_FILE);
        let target = sandbox.join("DtKit");

        let result =
            migrate_layout(&current, &bootstrap, target.clone(), Some(legacy_downloads)).unwrap();
        assert_eq!(result.layout.root, target);
        assert_eq!(
            fs::read(result.layout.config.join("shortcuts.json")).unwrap(),
            b"shortcut-data"
        );
        assert_eq!(
            fs::read(result.layout.whiteboards.join("index.json")).unwrap(),
            b"board-index"
        );
        assert_eq!(
            fs::read(result.layout.downloads.join("existing.zip")).unwrap(),
            b"download-data"
        );
        let pointer: RootPointer = serde_json::from_slice(&fs::read(bootstrap).unwrap()).unwrap();
        assert_eq!(pointer.root, result.layout.root);
        assert!(current.root.is_dir(), "旧目录必须保留到新目录完成验证之后");
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[test]
    fn migration_rejects_nested_or_non_empty_targets() {
        let sandbox = test_root("migration-boundaries");
        let source = sandbox.join("source");
        fs::create_dir_all(source.join("nested")).unwrap();
        assert!(validate_migration_target(&source, &source.join("nested")).is_err());
        let occupied = sandbox.join("occupied");
        fs::create_dir_all(&occupied).unwrap();
        fs::write(occupied.join("keep.txt"), b"keep").unwrap();
        assert!(validate_migration_target(&source, &occupied).is_err());
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[test]
    fn unavailable_configured_root_is_reported_without_recreating_it() {
        let sandbox = test_root("missing-root");
        let executable_dir = sandbox.join("bin");
        fs::create_dir_all(&executable_dir).unwrap();
        let missing = sandbox.join("detached-drive").join("DtKit");
        let bootstrap = sandbox.join("bootstrap").join(ROOT_POINTER_FILE);
        write_root_pointer(&bootstrap, &missing).unwrap();

        let layout = prepare_configured_layout(
            &executable_dir.join("DtKit.exe"),
            sandbox.join("default-root"),
            &bootstrap,
        )
        .unwrap();
        assert!(!layout.writable);
        assert!(layout.warning.as_deref().unwrap().contains("不可用"));
        assert!(!missing.exists());
        fs::remove_dir_all(sandbox).unwrap();
    }
}
