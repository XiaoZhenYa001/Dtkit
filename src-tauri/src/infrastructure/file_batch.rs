use super::jobs::{JobManager, JobTicket};
use super::resources::ResourceGovernor;
use super::storage::StorageManager;
use crate::path_safety::validate_leaf_filename;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const MAX_BATCH_FILES: usize = 500;
const MAX_BATCH_SCAN_ENTRIES: usize = 20_000;
const MAX_BATCH_SCAN_DEPTH: usize = 32;
const MAX_BATCH_SCAN_DURATION: Duration = Duration::from_secs(3);
const MAX_CACHED_BATCH_EVENTS: usize = 100;
static BATCH_EVENTS: OnceLock<Mutex<VecDeque<FileBatchEvent>>> = OnceLock::new();

#[cfg(windows)]
fn is_link_like(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_like(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BatchOperation {
    Rename,
    Copy,
    Move,
    Delete,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBatchRequest {
    sources: Vec<String>,
    operation: BatchOperation,
    #[serde(default)]
    destination: Option<String>,
    #[serde(default)]
    name_pattern: Option<String>,
    #[serde(default = "default_start_index")]
    start_index: u32,
    #[serde(default)]
    rename_options: RenameOptions,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    permanent: bool,
    #[serde(default)]
    client_id: Option<String>,
}

fn default_start_index() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RenameCaseMode {
    Keep,
    Lower,
    Upper,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RenameOptions {
    trim_whitespace: bool,
    remove_start: u16,
    remove_end: u16,
    find: String,
    replace: String,
    case_mode: RenameCaseMode,
    extension_case: RenameCaseMode,
    number_padding: u8,
    number_step: u32,
}

impl Default for RenameOptions {
    fn default() -> Self {
        Self {
            trim_whitespace: false,
            remove_start: 0,
            remove_end: 0,
            find: String::new(),
            replace: String::new(),
            case_mode: RenameCaseMode::Keep,
            extension_case: RenameCaseMode::Keep,
            number_padding: 1,
            number_step: 1,
        }
    }
}

impl RenameOptions {
    fn validate(&self) -> Result<(), String> {
        if self.remove_start > 160 || self.remove_end > 160 {
            return Err("首尾删除字符数须为 0–160 之间的整数".into());
        }
        if self.find.chars().count() > 160 || self.replace.chars().count() > 160 {
            return Err("查找和替换内容不能超过 160 个字符".into());
        }
        if !(1..=8).contains(&self.number_padding) {
            return Err("序号位数须为 1–8 之间的整数".into());
        }
        if !(1..=10000).contains(&self.number_step) {
            return Err("序号步长须为 1–10000 之间的整数".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBatchPreviewItem {
    source: String,
    target: Option<String>,
    name: String,
    size: u64,
    conflict: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBatchPreview {
    operation: BatchOperation,
    items: Vec<FileBatchPreviewItem>,
    skipped: usize,
    total_bytes: u64,
    has_conflicts: bool,
    permanent: bool,
}

#[derive(Debug, Clone)]
struct PreparedItem {
    source: PathBuf,
    target: Option<PathBuf>,
    size: u64,
    conflict: Option<String>,
}

#[derive(Debug)]
struct PreparedBatch {
    operation: BatchOperation,
    items: Vec<PreparedItem>,
    skipped: usize,
    permanent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBatchStartResult {
    job_id: String,
    file_count: usize,
    total_bytes: u64,
    preview: FileBatchPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileBatchExecutionResult {
    processed: usize,
    total: usize,
    bytes_processed: u64,
    cancelled: bool,
    recovery_batch_id: Option<String>,
    preview: FileBatchPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBatchEvent {
    job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    status: String,
    progress: f32,
    result: Option<FileBatchExecutionResult>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryEntry {
    original: PathBuf,
    stored: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryManifest {
    batch_id: String,
    created_at: i64,
    entries: Vec<RecoveryEntry>,
}

fn write_recovery_manifest(root: &Path, manifest: &RecoveryManifest) -> Result<(), String> {
    use std::io::Write;
    let temporary = root.join(format!(".manifest-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // This only replaces DtKit's own recovery metadata, never a user file.
        fs::rename(&temporary, root.join("manifest.json"))
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("写入恢复清单失败: {error}"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBatchRestoreResult {
    batch_id: String,
    restored: usize,
    skipped: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBatchSources {
    sources: Vec<String>,
    skipped: u64,
    truncated: bool,
    warnings: Vec<String>,
}

#[derive(Clone, Copy)]
struct SourceScanLimits {
    files: usize,
    entries: usize,
    depth: usize,
    duration: Duration,
}

impl Default for SourceScanLimits {
    fn default() -> Self {
        Self {
            files: MAX_BATCH_FILES,
            entries: MAX_BATCH_SCAN_ENTRIES,
            depth: MAX_BATCH_SCAN_DEPTH,
            duration: MAX_BATCH_SCAN_DURATION,
        }
    }
}

impl FileBatchSources {
    fn warn(&mut self, warning: String) {
        if self.warnings.len() < 20 && !self.warnings.contains(&warning) {
            self.warnings.push(warning);
        }
    }

    fn truncate(&mut self, warning: String) {
        self.truncated = true;
        if self.warnings.len() == 20 && !self.warnings.contains(&warning) {
            self.warnings.pop();
        }
        self.warn(warning);
    }
}

fn collect_sources_from_directory(
    directory: &str,
    recursive: bool,
    limits: SourceScanLimits,
) -> Result<FileBatchSources, String> {
    let metadata = fs::symlink_metadata(directory).map_err(|_| "导入文件夹不存在".to_string())?;
    if !metadata.is_dir() || is_link_like(&metadata) {
        return Err("导入路径必须是普通文件夹，不能是符号链接或目录联接".into());
    }
    let root =
        fs::canonicalize(directory).map_err(|error| format!("读取导入文件夹失败: {error}"))?;
    let mut result = FileBatchSources {
        sources: Vec::new(),
        skipped: 0,
        truncated: false,
        warnings: Vec::new(),
    };
    let started = Instant::now();
    let mut scanned = 0usize;
    let mut pending = VecDeque::from([(root, 0usize)]);
    let mut seen = HashSet::new();
    'directories: while let Some((folder, depth)) = pending.pop_front() {
        if started.elapsed() >= limits.duration {
            result.truncate(
                "扫描达到时间上限，已保留当前导入结果，请缩小文件夹范围后继续导入".into(),
            );
            break;
        }
        match fs::symlink_metadata(&folder) {
            Ok(metadata) if metadata.is_dir() && !is_link_like(&metadata) => (),
            _ => {
                result.skipped += 1;
                result.warn(format!(
                    "已跳过无法访问或变为链接的文件夹: {}",
                    folder.display()
                ));
                continue;
            }
        };
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) => {
                if depth == 0 {
                    return Err(format!("读取导入文件夹失败: {error}"));
                }
                result.skipped += 1;
                result.warn(format!("无法读取文件夹 {}: {error}", folder.display()));
                continue;
            }
        };
        // Sort only this bounded directory snapshot, never collect an entire tree.
        let mut paths = Vec::new();
        let mut budget_exhausted = false;
        for entry in entries {
            if scanned >= limits.entries {
                result.truncate(format!(
                    "扫描达到 {} 个目录条目的上限，请缩小文件夹范围后继续导入",
                    limits.entries
                ));
                budget_exhausted = true;
                break;
            }
            if started.elapsed() >= limits.duration {
                result.truncate(
                    "扫描达到时间上限，已保留当前导入结果，请缩小文件夹范围后继续导入".into(),
                );
                budget_exhausted = true;
                break;
            }
            scanned += 1;
            match entry {
                Ok(entry) => paths.push(entry.path()),
                Err(error) => {
                    result.skipped += 1;
                    result.warn(format!("无法读取部分目录条目: {error}"));
                }
            }
        }
        paths.sort_by_cached_key(|path| (path_key(path), path.to_string_lossy().into_owned()));
        for path in paths {
            if started.elapsed() >= limits.duration {
                result.truncate(
                    "扫描达到时间上限，已保留当前导入结果，请缩小文件夹范围后继续导入".into(),
                );
                break 'directories;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    result.skipped += 1;
                    result.warn(format!("无法读取文件 {}: {error}", path.display()));
                    continue;
                }
            };
            if is_link_like(&metadata) {
                result.skipped += 1;
            } else if metadata.is_file() {
                if result.sources.len() >= limits.files {
                    result.truncate(format!(
                        "一次最多导入 {} 个文件，请缩小文件夹范围后继续导入",
                        limits.files
                    ));
                    break 'directories;
                }
                match fs::canonicalize(&path) {
                    Ok(source) if seen.insert(path_key(&source)) => {
                        result.sources.push(source.to_string_lossy().into_owned());
                    }
                    Ok(_) => result.skipped += 1,
                    Err(error) => {
                        result.skipped += 1;
                        result.warn(format!("无法读取文件 {}: {error}", path.display()));
                    }
                }
            } else if metadata.is_dir() && recursive {
                if depth >= limits.depth {
                    result.skipped += 1;
                    result.truncate(format!(
                        "已跳过超过 {} 层的子文件夹，请单独导入这些文件夹",
                        limits.depth
                    ));
                } else {
                    pending.push_back((path, depth + 1));
                }
            } else {
                result.skipped += 1;
            }
        }
        if budget_exhausted {
            break;
        }
    }
    result
        .sources
        .sort_by_cached_key(|source| (path_key(Path::new(source)), source.clone()));
    Ok(result)
}

#[tauri::command]
pub(crate) async fn collect_file_batch_sources(
    directory: String,
    recursive: Option<bool>,
) -> Result<FileBatchSources, String> {
    tauri::async_runtime::spawn_blocking(move || {
        collect_sources_from_directory(
            &directory,
            recursive.unwrap_or(false),
            SourceScanLimits::default(),
        )
    })
    .await
    .map_err(|error| format!("导入文件夹失败: {error}"))?
}

fn normalize_extensions(values: &[String]) -> Result<HashSet<String>, String> {
    if values.len() > 20 {
        return Err("扩展名筛选条件过多".to_string());
    }
    values
        .iter()
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.len() > 16
                || !value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
            {
                Err(format!("扩展名无效: {value}"))
            } else {
                Ok(value)
            }
        })
        .collect()
}

fn render_name(
    pattern: &str,
    source: &Path,
    index: u32,
    options: &RenameOptions,
) -> Result<String, String> {
    options.validate()?;
    if pattern.is_empty() || pattern.chars().count() > 160 {
        return Err("重命名模板不能为空且不能超过 160 个字符".to_string());
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let stem = if options.trim_whitespace {
        stem.trim()
    } else {
        stem
    };
    let characters: Vec<char> = stem.chars().collect();
    let start = usize::from(options.remove_start).min(characters.len());
    let end = characters
        .len()
        .saturating_sub(usize::from(options.remove_end));
    let stem: String = characters[start..end.max(start)].iter().collect();
    let mut stem = if options.find.is_empty() {
        stem
    } else {
        stem.replace(&options.find, &options.replace)
    };
    stem = match options.case_mode {
        RenameCaseMode::Keep => stem,
        RenameCaseMode::Lower => stem.to_lowercase(),
        RenameCaseMode::Upper => stem.to_uppercase(),
    };
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let extension = match options.extension_case {
        RenameCaseMode::Keep => extension.to_string(),
        RenameCaseMode::Lower => extension.to_lowercase(),
        RenameCaseMode::Upper => extension.to_uppercase(),
    };
    let folder = source
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let dot_extension = if extension.is_empty() {
        String::new()
    } else {
        format!(".{extension}")
    };
    let number = format!("{:0width$}", index, width = options.number_padding as usize);
    let replacements = [
        ("{name}", stem.as_str()),
        ("{ext}", extension.as_str()),
        ("{dotext}", dot_extension.as_str()),
        ("{n}", number.as_str()),
        ("{folder}", folder),
    ];
    let mut remaining = pattern;
    let mut name = String::with_capacity(pattern.len() + stem.len());
    while !remaining.is_empty() {
        if let Some((token, value)) = replacements
            .iter()
            .find(|(token, _)| remaining.starts_with(token))
        {
            name.push_str(value);
            remaining = &remaining[token.len()..];
        } else {
            let character = remaining.chars().next().unwrap();
            name.push(character);
            remaining = &remaining[character.len_utf8()..];
        }
    }
    validate_leaf_filename(&name)?;
    Ok(name)
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn is_case_only_rename(source: &Path, target: &Path) -> bool {
    cfg!(windows)
        && source.file_name() != target.file_name()
        && fs::canonicalize(source)
            .ok()
            .zip(fs::canonicalize(target).ok())
            .is_some_and(|(source, target)| source == target)
}

fn prepare_batch(request: &FileBatchRequest) -> Result<PreparedBatch, String> {
    if request.sources.is_empty() {
        return Err("请至少选择一个文件".to_string());
    }
    if request.sources.len() > MAX_BATCH_FILES {
        return Err(format!("一次最多处理 {MAX_BATCH_FILES} 个文件"));
    }
    if request.operation != BatchOperation::Delete && request.permanent {
        return Err("只有删除操作可以启用彻底删除".to_string());
    }
    if request.operation == BatchOperation::Rename {
        request.rename_options.validate()?;
    }
    let extensions = normalize_extensions(&request.extensions)?;
    let destination = match request.operation {
        BatchOperation::Copy | BatchOperation::Move => {
            let raw = request
                .destination
                .as_deref()
                .ok_or_else(|| "请选择目标文件夹".to_string())?;
            let raw_metadata =
                fs::symlink_metadata(raw).map_err(|_| "目标文件夹不存在".to_string())?;
            if !raw_metadata.is_dir() || is_link_like(&raw_metadata) {
                return Err("目标文件夹不能是符号链接或目录联接".to_string());
            }
            let path = fs::canonicalize(raw).map_err(|_| "目标文件夹不存在".to_string())?;
            if !path.is_dir() {
                return Err("目标路径不是文件夹".to_string());
            }
            Some(path)
        }
        _ => None,
    };
    let pattern = request
        .name_pattern
        .as_deref()
        .unwrap_or("{name}_{n}{dotext}");
    let mut source_keys = HashSet::new();
    let mut target_keys = HashSet::new();
    let mut items = Vec::new();
    let mut skipped = 0;

    for raw_source in &request.sources {
        let raw_metadata =
            fs::symlink_metadata(raw_source).map_err(|_| format!("文件不存在: {raw_source}"))?;
        if !raw_metadata.is_file() || is_link_like(&raw_metadata) {
            skipped += 1;
            continue;
        }
        let source =
            fs::canonicalize(raw_source).map_err(|_| format!("文件不存在: {raw_source}"))?;
        let metadata =
            fs::symlink_metadata(&source).map_err(|error| format!("读取文件信息失败: {error}"))?;
        if !metadata.is_file() || is_link_like(&metadata) {
            skipped += 1;
            continue;
        }
        let source_key = path_key(&source);
        if !source_keys.insert(source_key.clone()) {
            skipped += 1;
            continue;
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !extensions.is_empty() && !extensions.contains(&extension) {
            skipped += 1;
            continue;
        }
        let target = match request.operation {
            BatchOperation::Rename => {
                let item_index = (items.len() as u32)
                    .checked_mul(request.rename_options.number_step)
                    .and_then(|offset| request.start_index.checked_add(offset))
                    .ok_or_else(|| "文件序号超出有效范围".to_string())?;
                Some(source.with_file_name(render_name(
                    pattern,
                    &source,
                    item_index,
                    &request.rename_options,
                )?))
            }
            BatchOperation::Copy | BatchOperation::Move => Some(
                destination
                    .as_ref()
                    .unwrap()
                    .join(source.file_name().unwrap()),
            ),
            BatchOperation::Delete => None,
        };
        let mut conflict = None;
        if let Some(target) = &target {
            let target_key = path_key(target);
            let changes_case =
                request.operation == BatchOperation::Rename && is_case_only_rename(&source, target);
            if target_key == source_key
                && request.operation == BatchOperation::Rename
                && !changes_case
            {
                conflict = Some("新文件名与原文件名相同".to_string());
            } else if target.exists() && !changes_case {
                conflict = Some("目标文件已存在，不会覆盖".to_string());
            } else if !target_keys.insert(target_key) {
                conflict = Some("多个文件会产生相同目标名称".to_string());
            }
        }
        items.push(PreparedItem {
            source,
            target,
            size: metadata.len(),
            conflict,
        });
    }
    if items.is_empty() {
        return Err("筛选后没有可处理的文件".to_string());
    }
    Ok(PreparedBatch {
        operation: request.operation,
        items,
        skipped,
        permanent: request.permanent,
    })
}

fn public_preview(prepared: &PreparedBatch) -> FileBatchPreview {
    FileBatchPreview {
        operation: prepared.operation,
        skipped: prepared.skipped,
        total_bytes: prepared.items.iter().map(|item| item.size).sum(),
        has_conflicts: prepared.items.iter().any(|item| item.conflict.is_some()),
        permanent: prepared.permanent,
        items: prepared
            .items
            .iter()
            .map(|item| FileBatchPreviewItem {
                source: item.source.to_string_lossy().into_owned(),
                target: item
                    .target
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                name: item
                    .source
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                size: item.size,
                conflict: item.conflict.clone(),
            })
            .collect(),
    }
}

#[cfg(windows)]
fn copy_without_overwrite(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::Storage::FileSystem::CopyFileW;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe { CopyFileW(PCWSTR(source.as_ptr()), PCWSTR(target.as_ptr()), BOOL(1)) }
        .map_err(|error| format!("复制文件失败: {error}"))
}

#[cfg(not(windows))]
fn copy_without_overwrite(source: &Path, target: &Path) -> Result<(), String> {
    use std::fs::OpenOptions;
    let mut input = fs::File::open(source).map_err(|error| format!("读取原文件失败: {error}"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("创建目标文件失败: {error}"))?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(target);
        return Err(format!("复制文件失败: {error}"));
    }
    Ok(())
}

#[cfg(windows)]
fn rename_without_overwrite(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Omitting REPLACE_EXISTING also protects targets created after the preview.
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(|error| format!("移动文件失败: {error}"))
}

#[cfg(not(windows))]
fn rename_without_overwrite(source: &Path, target: &Path) -> Result<(), String> {
    // A hard link fails atomically when target exists, unlike std::fs::rename.
    fs::hard_link(source, target).map_err(|error| error.to_string())?;
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(target);
        return Err(error.to_string());
    }
    Ok(())
}

fn move_without_overwrite(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() && !is_case_only_rename(source, target) {
        return Err(format!("目标文件已存在: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let metadata =
            fs::symlink_metadata(parent).map_err(|error| format!("读取目标文件夹失败: {error}"))?;
        if !metadata.is_dir() || is_link_like(&metadata) {
            return Err(format!("目标文件夹不能是链接: {}", parent.display()));
        }
    }
    match rename_without_overwrite(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_without_overwrite(source, target)?;
            if let Err(error) = fs::remove_file(source) {
                let _ = fs::remove_file(target);
                return Err(format!("移除原文件失败: {error}"));
            }
            Ok(())
        }
    }
}

fn verify_item_before_write(item: &PreparedItem) -> Result<(), String> {
    let source_metadata = fs::symlink_metadata(&item.source)
        .map_err(|_| format!("源文件已移动: {}", item.source.display()))?;
    if !source_metadata.is_file() || is_link_like(&source_metadata) {
        return Err(format!(
            "拒绝处理预检后被替换的链接: {}",
            item.source.display()
        ));
    }
    if let Some(parent) = item.target.as_ref().and_then(|target| target.parent()) {
        let parent_metadata = fs::symlink_metadata(parent)
            .map_err(|_| format!("目标文件夹已移动: {}", parent.display()))?;
        if !parent_metadata.is_dir() || is_link_like(&parent_metadata) {
            return Err(format!("目标文件夹不能是链接: {}", parent.display()));
        }
    }
    Ok(())
}

fn remember_event(events: &mut VecDeque<FileBatchEvent>, event: FileBatchEvent) {
    if let Some(index) = events.iter().position(|cached| {
        cached.job_id == event.job_id
            || (event.client_id.is_some() && cached.client_id == event.client_id)
    }) {
        events.remove(index);
    }
    events.push_back(event);
    while events.len() > MAX_CACHED_BATCH_EVENTS {
        let Some(index) = events.iter().position(|cached| {
            matches!(cached.status.as_str(), "completed" | "cancelled" | "failed")
        }) else {
            break;
        };
        events.remove(index);
    }
}

fn reserve_client_event(
    events: &mut VecDeque<FileBatchEvent>,
    raw_client_id: &str,
) -> Result<FileBatchEvent, String> {
    if raw_client_id.len() > 80
        || !raw_client_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("任务请求标识无效".into());
    }
    let client_id = uuid::Uuid::parse_str(raw_client_id)
        .map_err(|_| "任务请求标识无效".to_string())?
        .to_string();
    if events
        .iter()
        .any(|event| event.client_id.as_deref() == Some(&client_id) || event.job_id == client_id)
    {
        return Err("这次任务已经提交，请等待原任务完成".into());
    }
    let event = FileBatchEvent {
        job_id: client_id.clone(),
        client_id: Some(client_id),
        status: "preparing".into(),
        progress: 0.0,
        result: None,
        error: None,
    };
    remember_event(events, event.clone());
    Ok(event)
}

fn emit_event(app: &AppHandle, event: FileBatchEvent) {
    if let Ok(mut events) = BATCH_EVENTS.get_or_init(Mutex::default).lock() {
        remember_event(&mut events, event.clone());
    }
    let _ = app.emit("file-batch-progress", event);
}

#[tauri::command]
pub(crate) fn get_file_batch_status(job_id: String) -> Result<Option<FileBatchEvent>, String> {
    if job_id.is_empty() || job_id.len() > 80 {
        return Err("任务编号无效".into());
    }
    let events = BATCH_EVENTS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "暂时无法读取任务状态".to_string())?;
    let normalized = uuid::Uuid::parse_str(&job_id)
        .map(|id| id.to_string())
        .unwrap_or(job_id);
    Ok(events
        .iter()
        .find(|event| event.job_id == normalized || event.client_id.as_deref() == Some(&normalized))
        .cloned())
}

fn emit_start_failure(app: &AppHandle, client_id: &Option<String>, error: String) -> String {
    if let Some(client_id) = client_id {
        emit_event(
            app,
            FileBatchEvent {
                job_id: client_id.clone(),
                client_id: Some(client_id.clone()),
                status: "failed".into(),
                progress: 0.0,
                result: None,
                error: Some(error.clone()),
            },
        );
    }
    error
}

fn execute_batch(
    app: AppHandle,
    job_id: String,
    ticket: JobTicket,
    prepared: PreparedBatch,
    client_id: Option<String>,
    partial_result: &mut FileBatchExecutionResult,
) -> Result<(), String> {
    let manager = app.state::<JobManager>();
    manager.mark_running(&job_id)?;
    emit_event(
        &app,
        FileBatchEvent {
            job_id: job_id.clone(),
            client_id: client_id.clone(),
            status: "running".into(),
            progress: 0.0,
            result: None,
            error: None,
        },
    );
    let total = prepared.items.len();
    let mut processed = 0usize;
    let mut bytes_processed = 0u64;
    let mut last_emit = Instant::now();
    let mut recovery_batch_id = None;
    let mut recovery_entries = Vec::new();

    if prepared.operation == BatchOperation::Delete && !prepared.permanent {
        let batch_id = format!("file-batch-{}", uuid::Uuid::new_v4());
        let root = app
            .state::<StorageManager>()
            .layout()?
            .recovery
            .join(&batch_id);
        fs::create_dir_all(&root).map_err(|error| format!("创建恢复批次失败: {error}"))?;
        recovery_entries = prepared
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| RecoveryEntry {
                original: item.source.clone(),
                stored: root.join(format!(
                    "{index:04}-{}",
                    item.source
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                )),
            })
            .collect();
        let manifest = RecoveryManifest {
            batch_id: batch_id.clone(),
            created_at: chrono::Utc::now().timestamp_millis(),
            entries: recovery_entries.clone(),
        };
        write_recovery_manifest(&root, &manifest)?;
        recovery_batch_id = Some(batch_id);
        partial_result.recovery_batch_id = recovery_batch_id.clone();
    }

    for (index, item) in prepared.items.iter().enumerate() {
        if ticket.is_cancelled() {
            partial_result.cancelled = true;
            manager.mark_cancelled(&job_id)?;
            let result = FileBatchExecutionResult {
                processed,
                total,
                bytes_processed,
                cancelled: true,
                recovery_batch_id,
                preview: partial_result.preview.clone(),
            };
            emit_event(
                &app,
                FileBatchEvent {
                    job_id,
                    client_id,
                    status: "cancelled".into(),
                    progress: processed as f32 / total as f32,
                    result: Some(result),
                    error: None,
                },
            );
            return Ok(());
        }
        verify_item_before_write(item)?;
        match prepared.operation {
            BatchOperation::Rename | BatchOperation::Move => {
                move_without_overwrite(&item.source, item.target.as_ref().unwrap())?
            }
            BatchOperation::Copy => {
                let target = item.target.as_ref().unwrap();
                copy_without_overwrite(&item.source, target)?;
            }
            BatchOperation::Delete if prepared.permanent => {
                fs::remove_file(&item.source).map_err(|error| format!("彻底删除失败: {error}"))?
            }
            BatchOperation::Delete => {
                move_without_overwrite(&item.source, &recovery_entries[index].stored)?
            }
        }
        processed += 1;
        bytes_processed = bytes_processed.saturating_add(item.size);
        partial_result.processed = processed;
        partial_result.bytes_processed = bytes_processed;
        let progress = processed as f32 / total as f32;
        manager.set_progress(&job_id, progress)?;
        if last_emit.elapsed() >= Duration::from_millis(100) || processed == total {
            emit_event(
                &app,
                FileBatchEvent {
                    job_id: job_id.clone(),
                    client_id: client_id.clone(),
                    status: "running".into(),
                    progress,
                    result: None,
                    error: None,
                },
            );
            last_emit = Instant::now();
        }
    }
    manager.complete(&job_id)?;
    let result = FileBatchExecutionResult {
        processed,
        total,
        bytes_processed,
        cancelled: false,
        recovery_batch_id,
        preview: partial_result.preview.clone(),
    };
    emit_event(
        &app,
        FileBatchEvent {
            job_id,
            client_id,
            status: "completed".into(),
            progress: 1.0,
            result: Some(result),
            error: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn preview_file_batch(
    request: FileBatchRequest,
) -> Result<FileBatchPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_batch(&request).map(|batch| public_preview(&batch))
    })
    .await
    .map_err(|error| format!("预检任务失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn start_file_batch(
    app: AppHandle,
    request: FileBatchRequest,
) -> Result<FileBatchStartResult, String> {
    let client_id = if let Some(raw_client_id) = &request.client_id {
        let event = {
            let mut events = BATCH_EVENTS
                .get_or_init(Mutex::default)
                .lock()
                .map_err(|_| "暂时无法创建任务".to_string())?;
            reserve_client_event(&mut events, raw_client_id)?
        };
        let client_id = event.client_id.clone();
        let _ = app.emit("file-batch-progress", event);
        client_id
    } else {
        None
    };
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_batch(&request))
        .await
        .map_err(|error| emit_start_failure(&app, &client_id, format!("预检任务失败: {error}")))?
        .map_err(|error| emit_start_failure(&app, &client_id, error))?;
    if prepared.items.iter().any(|item| item.conflict.is_some()) {
        return Err(emit_start_failure(
            &app,
            &client_id,
            "存在文件名冲突，请修改设置后重新预检".to_string(),
        ));
    }
    let total_bytes = prepared.items.iter().map(|item| item.size).sum();
    let file_count = prepared.items.len();
    let preview = public_preview(&prepared);
    let execution_preview = preview.clone();
    let active_limit = app.state::<ResourceGovernor>().effective_worker_limit();
    let ticket = app
        .state::<JobManager>()
        .begin_limited("file-batch", "文件批处理", active_limit)
        .map_err(|error| emit_start_failure(&app, &client_id, error))?;
    let job_id = ticket.id().to_string();
    let execution_job_id = job_id.clone();
    let execution_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut partial_result = FileBatchExecutionResult {
            processed: 0,
            total: file_count,
            bytes_processed: 0,
            cancelled: false,
            recovery_batch_id: None,
            preview: execution_preview,
        };
        if let Err(error) = execute_batch(
            execution_app.clone(),
            execution_job_id.clone(),
            ticket,
            prepared,
            client_id.clone(),
            &mut partial_result,
        ) {
            let _ = execution_app
                .state::<JobManager>()
                .fail(&execution_job_id, &error);
            emit_event(
                &execution_app,
                FileBatchEvent {
                    job_id: execution_job_id,
                    client_id,
                    status: "failed".into(),
                    progress: partial_result.processed as f32 / file_count as f32,
                    result: Some(partial_result),
                    error: Some(error),
                },
            );
        }
    });
    Ok(FileBatchStartResult {
        job_id,
        file_count,
        total_bytes,
        preview,
    })
}

#[tauri::command]
pub(crate) async fn restore_file_batch(
    app: AppHandle,
    batch_id: String,
) -> Result<FileBatchRestoreResult, String> {
    if !batch_id.starts_with("file-batch-")
        || batch_id.len() > 80
        || !batch_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("恢复批次标识无效".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = app
            .state::<StorageManager>()
            .layout()?
            .recovery
            .join(&batch_id);
        restore_batch_from_root(&root, &batch_id)
    })
    .await
    .map_err(|error| format!("恢复任务失败: {error}"))?
}

fn restore_batch_from_root(root: &Path, batch_id: &str) -> Result<FileBatchRestoreResult, String> {
    let mut manifest: RecoveryManifest = serde_json::from_slice(
        &fs::read(root.join("manifest.json")).map_err(|_| "恢复清单不存在".to_string())?,
    )
    .map_err(|error| format!("恢复清单无效: {error}"))?;
    if manifest.batch_id != batch_id {
        return Err("恢复清单与批次不匹配".to_string());
    }
    let mut restored = 0;
    let mut pending = Vec::new();
    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("恢复目录无效: {error}"))?;
    for entry in manifest.entries {
        let stored_metadata = match fs::symlink_metadata(&entry.stored) {
            Ok(metadata) => metadata,
            // Cancelled jobs include entries that never moved; previous restores
            // can also have completed before a metadata write was interrupted.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                pending.push(entry);
                continue;
            }
        };
        let stored_within_batch = fs::canonicalize(&entry.stored)
            .ok()
            .is_some_and(|stored| stored.starts_with(&canonical_root));
        if !stored_metadata.is_file()
            || is_link_like(&stored_metadata)
            || !stored_within_batch
            || entry.original.exists()
        {
            pending.push(entry);
            continue;
        }
        move_without_overwrite(&entry.stored, &entry.original)?;
        restored += 1;
    }
    let skipped = pending.len();
    manifest.entries = pending;
    if manifest.entries.is_empty() {
        let _ = fs::remove_file(root.join("manifest.json"));
        let _ = fs::remove_dir(root);
    } else {
        write_recovery_manifest(root, &manifest)?;
    }
    Ok(FileBatchRestoreResult {
        batch_id: batch_id.to_string(),
        restored,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("dtkit-file-batch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn request(source: &Path, operation: BatchOperation) -> FileBatchRequest {
        FileBatchRequest {
            sources: vec![source.to_string_lossy().into_owned()],
            operation,
            destination: None,
            name_pattern: None,
            start_index: 1,
            rename_options: RenameOptions::default(),
            extensions: vec![],
            permanent: false,
            client_id: None,
        }
    }

    #[test]
    fn folder_import_is_read_only_sorted_and_recursion_is_explicit() {
        let root = temp_root();
        fs::write(root.join("b.TXT"), b"second").unwrap();
        fs::write(root.join("a.txt"), b"first").unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/child.txt"), b"child").unwrap();
        let directory = root.to_string_lossy();
        let flat =
            collect_sources_from_directory(&directory, false, SourceScanLimits::default()).unwrap();
        assert_eq!(flat.sources.len(), 2);
        assert_eq!(flat.skipped, 1);
        assert!(!flat.truncated);
        assert!(flat.warnings.is_empty());
        assert_eq!(Path::new(&flat.sources[0]).file_name().unwrap(), "a.txt");
        assert_eq!(Path::new(&flat.sources[1]).file_name().unwrap(), "b.TXT");
        let recursive =
            collect_sources_from_directory(&directory, true, SourceScanLimits::default()).unwrap();
        assert_eq!(recursive.sources.len(), 3);
        assert_eq!(recursive.skipped, 0);
        assert!(!recursive.truncated);
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"first");
        assert_eq!(fs::read(root.join("nested/child.txt")).unwrap(), b"child");
        assert!(collect_sources_from_directory(
            &root.join("a.txt").to_string_lossy(),
            false,
            SourceScanLimits::default()
        )
        .is_err());
        assert!(collect_sources_from_directory(
            &root.join("missing").to_string_lossy(),
            false,
            SourceScanLimits::default()
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_import_reports_file_entry_time_and_depth_limits() {
        let root = temp_root();
        for index in 0..=MAX_BATCH_FILES {
            fs::write(root.join(format!("file-{index:04}.txt")), b"fixture").unwrap();
        }
        let directory = root.to_string_lossy();
        let capped =
            collect_sources_from_directory(&directory, true, SourceScanLimits::default()).unwrap();
        assert_eq!(capped.sources.len(), MAX_BATCH_FILES);
        assert!(capped.truncated && !capped.warnings.is_empty());
        assert_eq!(
            Path::new(&capped.sources[0]).file_name().unwrap(),
            "file-0000.txt"
        );
        assert_eq!(
            Path::new(capped.sources.last().unwrap())
                .file_name()
                .unwrap(),
            "file-0499.txt"
        );
        let entries = collect_sources_from_directory(
            &directory,
            true,
            SourceScanLimits {
                entries: 2,
                ..SourceScanLimits::default()
            },
        )
        .unwrap();
        assert_eq!(entries.sources.len(), 2);
        assert!(
            entries.truncated
                && entries
                    .warnings
                    .iter()
                    .any(|warning| warning.contains("目录条目"))
        );
        let timed = collect_sources_from_directory(
            &directory,
            true,
            SourceScanLimits {
                duration: Duration::ZERO,
                ..SourceScanLimits::default()
            },
        )
        .unwrap();
        assert!(timed.sources.is_empty());
        assert!(
            timed.truncated
                && timed
                    .warnings
                    .iter()
                    .any(|warning| warning.contains("时间"))
        );
        fs::remove_dir_all(&root).unwrap();

        fs::create_dir_all(root.join("first/second")).unwrap();
        fs::write(root.join("first/direct.txt"), b"direct").unwrap();
        fs::write(root.join("first/second/deep.txt"), b"deep").unwrap();
        let depth = collect_sources_from_directory(
            &directory,
            true,
            SourceScanLimits {
                depth: 1,
                ..SourceScanLimits::default()
            },
        )
        .unwrap();
        assert_eq!(depth.sources.len(), 1);
        assert_eq!(depth.skipped, 1);
        assert!(depth.truncated && depth.warnings.iter().any(|warning| warning.contains("层")));
        assert_eq!(
            fs::read(root.join("first/second/deep.txt")).unwrap(),
            b"deep"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_import_rejects_link_roots_and_skips_link_entries() {
        let fixture = temp_root();
        let root = fixture.join("input");
        let outside = fixture.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("owned.txt"), b"owned").unwrap();
        fs::write(outside.join("other.txt"), b"outside").unwrap();
        let linked_folder = root.join("linked-folder");
        let linked_file = root.join("linked-file.txt");
        #[cfg(windows)]
        let links = std::os::windows::fs::symlink_dir(&outside, &linked_folder).and_then(|_| {
            std::os::windows::fs::symlink_file(outside.join("other.txt"), &linked_file)
        });
        #[cfg(not(windows))]
        let links = std::os::unix::fs::symlink(&outside, &linked_folder)
            .and_then(|_| std::os::unix::fs::symlink(outside.join("other.txt"), &linked_file));
        if let Err(error) = links {
            #[cfg(windows)]
            if error.raw_os_error() == Some(1314) {
                eprintln!("Skipping symlink fixture: Windows symlink privilege is unavailable");
                fs::remove_dir_all(fixture).unwrap();
                return;
            }
            panic!("Failed to create symlink fixture: {error}");
        }
        let imported = collect_sources_from_directory(
            &root.to_string_lossy(),
            true,
            SourceScanLimits::default(),
        )
        .unwrap();
        assert_eq!(imported.sources.len(), 1);
        assert_eq!(imported.skipped, 2);
        assert!(!imported.truncated);
        assert!(collect_sources_from_directory(
            &linked_folder.to_string_lossy(),
            true,
            SourceScanLimits::default()
        )
        .is_err());
        assert_eq!(fs::read(outside.join("other.txt")).unwrap(), b"outside");
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn rename_trims_removes_unicode_characters_and_expands_folder_once() {
        let root = temp_root();
        let folder = root.join("分组{n}");
        fs::create_dir(&folder).unwrap();
        let source = folder.join("  甲😀旧beta尾丙  .TxT");
        fs::write(&source, b"unicode fixture").unwrap();
        let options = RenameOptions {
            trim_whitespace: true,
            remove_start: 2,
            remove_end: 2,
            find: "旧".into(),
            replace: "新".into(),
            case_mode: RenameCaseMode::Upper,
            extension_case: RenameCaseMode::Lower,
            number_padding: 2,
            ..RenameOptions::default()
        };
        assert_eq!(
            render_name("{folder}_{name}_{n}{dotext}", &source, 1, &options,).unwrap(),
            "分组{n}_新BETA_01.txt"
        );
        let mut input = request(&source, BatchOperation::Rename);
        input.name_pattern = Some("{folder}_{name}_{n}{dotext}".into());
        input.rename_options = options;
        let prepared = prepare_batch(&input).unwrap();
        assert!(prepared.items[0].conflict.is_none() && source.is_file());
        let target = prepared.items[0].target.as_ref().unwrap();
        move_without_overwrite(&prepared.items[0].source, target).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(target).unwrap(), b"unicode fixture");
        assert_eq!(
            render_name(
                "{folder}{name}{dotext}",
                Path::new("/root-file.TxT"),
                1,
                &RenameOptions {
                    extension_case: RenameCaseMode::Upper,
                    ..RenameOptions::default()
                }
            )
            .unwrap(),
            "root-file.TXT"
        );
        assert_eq!(
            render_name(
                "{name}x{dotext}",
                Path::new("短😀.TXT"),
                1,
                &RenameOptions {
                    remove_start: 160,
                    remove_end: 160,
                    extension_case: RenameCaseMode::Lower,
                    ..RenameOptions::default()
                }
            )
            .unwrap(),
            "x.txt"
        );
        for options in [
            RenameOptions {
                remove_start: 161,
                ..RenameOptions::default()
            },
            RenameOptions {
                remove_end: 161,
                ..RenameOptions::default()
            },
        ] {
            assert!(render_name("{name}{dotext}", Path::new("valid.txt"), 1, &options).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_preview_expands_safe_placeholders_without_mutation() {
        let root = temp_root();
        let source = root.join("report.txt");
        fs::write(&source, b"hello").unwrap();
        let mut input = request(&source, BatchOperation::Rename);
        input.name_pattern = Some("archive-{n}{dotext}".into());
        let prepared = prepare_batch(&input).unwrap();
        let target = prepared.items[0].target.as_ref().unwrap();
        assert_eq!(target.file_name().unwrap(), "archive-1.txt");
        assert_eq!(target.parent().unwrap(), fs::canonicalize(&root).unwrap());
        assert!(source.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conflicts_are_detected_and_never_marked_for_overwrite() {
        let root = temp_root();
        let source = root.join("report.txt");
        fs::write(&source, b"hello").unwrap();
        fs::write(root.join("archive-1.txt"), b"existing").unwrap();
        let mut input = request(&source, BatchOperation::Rename);
        input.name_pattern = Some("archive-{n}{dotext}".into());
        assert!(prepare_batch(&input).unwrap().items[0].conflict.is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extension_filter_skips_non_matching_files() {
        let root = temp_root();
        let text = root.join("one.txt");
        let image = root.join("two.png");
        fs::write(&text, b"text").unwrap();
        fs::write(&image, b"image").unwrap();
        let mut input = request(&text, BatchOperation::Delete);
        input.sources.push(image.to_string_lossy().into_owned());
        input.extensions = vec!["png".into()];
        let prepared = prepare_batch(&input).unwrap();
        assert_eq!(prepared.items.len(), 1);
        assert_eq!(prepared.skipped, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_requests_and_partial_options_keep_compatible_defaults() {
        let input: FileBatchRequest = serde_json::from_value(serde_json::json!({
            "sources": ["report.txt"], "operation": "rename"
        }))
        .unwrap();
        assert_eq!(input.start_index, 1);
        assert_eq!(input.rename_options.number_step, 1);
        assert_eq!(input.rename_options.number_padding, 1);
        assert_eq!(input.rename_options.case_mode, RenameCaseMode::Keep);
        assert_eq!(input.rename_options.extension_case, RenameCaseMode::Keep);
        assert!(!input.rename_options.trim_whitespace);
        assert_eq!(input.rename_options.remove_start, 0);
        assert_eq!(input.rename_options.remove_end, 0);
        assert!(input.client_id.is_none());
        let input: FileBatchRequest = serde_json::from_value(serde_json::json!({
            "sources": ["report.txt"], "operation": "rename",
            "renameOptions": { "numberPadding": 3 }
        }))
        .unwrap();
        assert_eq!(input.rename_options.number_step, 1);
        assert_eq!(input.rename_options.number_padding, 3);
    }

    #[test]
    fn rename_tokens_expand_once_and_keep_unicode_and_extension_case() {
        let options = RenameOptions::default();
        assert_eq!(
            render_name(
                "{name}_{n}-{ext}{dotext}-{name}",
                Path::new("你好{n}{ext}.TXT"),
                7,
                &options,
            )
            .unwrap(),
            "你好{n}{ext}_7-TXT.TXT-你好{n}{ext}"
        );
        assert_eq!(
            render_name("{name}-{n}{dotext}", Path::new(".gitignore"), 0, &options).unwrap(),
            ".gitignore-0"
        );
    }

    #[test]
    fn rename_replaces_literal_occurrences_then_applies_unicode_case_and_padding() {
        let options = RenameOptions {
            find: "[旧]".into(),
            replace: "新{n}".into(),
            case_mode: RenameCaseMode::Upper,
            number_padding: 4,
            ..RenameOptions::default()
        };
        assert_eq!(
            render_name(
                "{name}_{n}{dotext}",
                Path::new("[旧]Straße[旧].Txt"),
                12,
                &options,
            )
            .unwrap(),
            "新{N}STRASSE新{N}_0012.Txt"
        );
        let lower = RenameOptions {
            case_mode: RenameCaseMode::Lower,
            ..RenameOptions::default()
        };
        assert_eq!(
            render_name("{name}{dotext}", Path::new("ABC中文.TXT"), 1, &lower).unwrap(),
            "abc中文.TXT"
        );
        assert_eq!(
            render_name("{name}{dotext}", Path::new("ΟΣ ΣΟΣ.TXT"), 1, &lower).unwrap(),
            "ος σος.TXT"
        );
    }

    #[test]
    fn rename_validates_result_and_number_options() {
        for pattern in ["", "../{name}", "CON{dotext}", "{name}.", "{name} "] {
            assert!(
                render_name(pattern, Path::new("ok.txt"), 1, &RenameOptions::default()).is_err()
            );
        }
        let unsafe_replace = RenameOptions {
            find: "ok".into(),
            replace: "../escape".into(),
            ..RenameOptions::default()
        };
        assert!(render_name("{name}{dotext}", Path::new("ok.txt"), 1, &unsafe_replace).is_err());
        for padding in [0, 9] {
            assert!(RenameOptions {
                number_padding: padding,
                ..RenameOptions::default()
            }
            .validate()
            .is_err());
        }
        for step in [0, 10001] {
            assert!(RenameOptions {
                number_step: step,
                ..RenameOptions::default()
            }
            .validate()
            .is_err());
        }
    }

    #[test]
    fn sequence_step_counts_only_unique_filtered_files() {
        let root = temp_root();
        let skipped = root.join("image.png");
        let first = root.join("one.TXT");
        let second = root.join("two.txt");
        for source in [&skipped, &first, &second] {
            fs::write(source, b"fixture").unwrap();
        }
        let mut input = request(&skipped, BatchOperation::Rename);
        input
            .sources
            .extend([&first, &first, &second].map(|path| path.to_string_lossy().into_owned()));
        input.extensions = vec![".TXT".into()];
        input.start_index = 5;
        input.name_pattern = Some("item-{n}{dotext}".into());
        input.rename_options.number_step = 3;
        input.rename_options.number_padding = 3;
        let prepared = prepare_batch(&input).unwrap();
        assert_eq!(prepared.skipped, 2);
        assert_eq!(prepared.items.len(), 2);
        assert_eq!(
            prepared.items[0]
                .target
                .as_ref()
                .unwrap()
                .file_name()
                .unwrap(),
            "item-005.TXT"
        );
        assert_eq!(
            prepared.items[1]
                .target
                .as_ref()
                .unwrap()
                .file_name()
                .unwrap(),
            "item-008.txt"
        );
        assert!(!prepared.items.iter().any(|item| item.conflict.is_some()));
        input.start_index = u32::MAX;
        assert!(prepare_batch(&input).unwrap_err().contains("序号"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_collisions_are_reported_without_mutating_sources() {
        let root = temp_root();
        let first = root.join("one.txt");
        let second = root.join("two.txt");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let mut input = request(&first, BatchOperation::Rename);
        input.sources.push(second.to_string_lossy().into_owned());
        input.name_pattern = Some("same{dotext}".into());
        let prepared = prepare_batch(&input).unwrap();
        assert!(prepared.items[0].conflict.is_none());
        assert!(prepared.items[1]
            .conflict
            .as_ref()
            .unwrap()
            .contains("相同目标"));
        assert!(first.exists() && second.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copy_and_move_never_overwrite_files_created_after_preview() {
        let root = temp_root();
        let source = root.join("source.txt");
        let target = root.join("target.txt");
        fs::write(&source, b"source bytes").unwrap();
        fs::write(&target, b"precious target bytes").unwrap();
        assert!(copy_without_overwrite(&source, &target).is_err());
        assert!(rename_without_overwrite(&source, &target).is_err());
        assert!(move_without_overwrite(&source, &target).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source bytes");
        assert_eq!(fs::read(&target).unwrap(), b"precious target bytes");
        fs::remove_file(&target).unwrap();
        copy_without_overwrite(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"source bytes");
        fs::remove_file(&target).unwrap();
        move_without_overwrite(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(&target).unwrap(), b"source bytes");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn case_only_rename_is_supported_without_changing_file_contents() {
        let root = temp_root();
        let source = root.join("Report.TXT");
        fs::write(&source, b"case fixture").unwrap();
        let mut input = request(&source, BatchOperation::Rename);
        input.name_pattern = Some("{name}{dotext}".into());
        input.rename_options.case_mode = RenameCaseMode::Lower;
        let prepared = prepare_batch(&input).unwrap();
        assert!(prepared.items[0].conflict.is_none());
        let target = prepared.items[0].target.as_ref().unwrap();
        move_without_overwrite(&prepared.items[0].source, target).unwrap();
        assert_eq!(fs::read(target).unwrap(), b"case fixture");
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .file_name(),
            "report.TXT"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn partial_restore_keeps_only_pending_files_and_can_complete_on_retry() {
        let fixture = temp_root();
        let root = fixture.join("recovery");
        let originals = fixture.join("originals");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&originals).unwrap();
        let restored = originals.join("first.txt");
        let conflict = originals.join("second.txt");
        let unmoved = originals.join("unmoved.txt");
        fs::write(root.join("first.txt"), b"first recovered bytes").unwrap();
        fs::write(root.join("second.txt"), b"second recovered bytes").unwrap();
        fs::write(&conflict, b"new original bytes").unwrap();
        fs::write(&unmoved, b"never moved bytes").unwrap();
        let manifest = RecoveryManifest {
            batch_id: "file-batch-partial-test".into(),
            created_at: 0,
            entries: vec![
                RecoveryEntry {
                    original: restored.clone(),
                    stored: root.join("first.txt"),
                },
                RecoveryEntry {
                    original: conflict.clone(),
                    stored: root.join("second.txt"),
                },
                RecoveryEntry {
                    original: unmoved.clone(),
                    stored: root.join("unmoved.txt"),
                },
            ],
        };
        write_recovery_manifest(&root, &manifest).unwrap();
        let result = restore_batch_from_root(&root, &manifest.batch_id).unwrap();
        assert_eq!((result.restored, result.skipped), (1, 1));
        assert_eq!(fs::read(&restored).unwrap(), b"first recovered bytes");
        assert_eq!(fs::read(&conflict).unwrap(), b"new original bytes");
        assert_eq!(fs::read(&unmoved).unwrap(), b"never moved bytes");
        let remaining: RecoveryManifest =
            serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(remaining.entries.len(), 1);
        assert_eq!(remaining.entries[0].original, conflict);
        fs::remove_file(&conflict).unwrap();
        let result = restore_batch_from_root(&root, &manifest.batch_id).unwrap();
        assert_eq!((result.restored, result.skipped), (1, 0));
        assert_eq!(fs::read(&conflict).unwrap(), b"second recovered bytes");
        assert!(!root.exists());
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn recovery_rejects_files_outside_the_batch_and_preserves_original_conflicts() {
        let fixture = temp_root();
        let root = fixture.join("recovery");
        fs::create_dir_all(&root).unwrap();
        let outside = fixture.join("outside.txt");
        let original = fixture.join("original.txt");
        fs::write(&outside, b"outside bytes").unwrap();
        let manifest = RecoveryManifest {
            batch_id: "file-batch-boundary-test".into(),
            created_at: 0,
            entries: vec![RecoveryEntry {
                original: original.clone(),
                stored: outside.clone(),
            }],
        };
        write_recovery_manifest(&root, &manifest).unwrap();
        let result = restore_batch_from_root(&root, &manifest.batch_id).unwrap();
        assert_eq!((result.restored, result.skipped), (0, 1));
        assert_eq!(fs::read(outside).unwrap(), b"outside bytes");
        assert!(!original.exists());
        assert!(restore_batch_from_root(&root, "file-batch-different").is_err());
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn event_cache_retains_active_jobs_and_latest_partial_recovery_results() {
        let event = |id: String, status: &str| FileBatchEvent {
            job_id: id,
            client_id: None,
            status: status.into(),
            progress: 0.0,
            result: None,
            error: None,
        };
        let mut events = VecDeque::new();
        remember_event(&mut events, event("active".into(), "running"));
        for index in 0..110 {
            remember_event(
                &mut events,
                event(format!("completed-{index}"), "completed"),
            );
        }
        assert_eq!(events.len(), MAX_CACHED_BATCH_EVENTS);
        assert!(events.iter().any(|event| event.job_id == "active"));
        assert!(!events.iter().any(|event| event.job_id == "completed-0"));
        let mut failed = event("active".into(), "failed");
        failed.progress = 0.5;
        failed.result = Some(FileBatchExecutionResult {
            processed: 2,
            total: 4,
            bytes_processed: 12,
            cancelled: false,
            recovery_batch_id: Some("file-batch-partial".into()),
            preview: FileBatchPreview {
                operation: BatchOperation::Delete,
                items: vec![],
                skipped: 0,
                total_bytes: 12,
                has_conflicts: false,
                permanent: false,
            },
        });
        remember_event(&mut events, failed);
        assert_eq!(events.len(), MAX_CACHED_BATCH_EVENTS);
        let cached = events
            .iter()
            .find(|event| event.job_id == "active")
            .unwrap();
        assert_eq!(cached.status, "failed");
        assert_eq!(cached.result.as_ref().unwrap().processed, 2);
        assert_eq!(
            cached.result.as_ref().unwrap().recovery_batch_id.as_deref(),
            Some("file-batch-partial")
        );
    }

    #[test]
    fn client_reservation_deduplicates_submission_and_tracks_real_job_identity() {
        let mut events = VecDeque::new();
        let client_id = uuid::Uuid::new_v4().to_string();
        let initial = reserve_client_event(&mut events, &client_id.to_uppercase()).unwrap();
        assert_eq!(initial.client_id.as_deref(), Some(client_id.as_str()));
        assert_eq!(initial.job_id, client_id);
        assert_eq!(initial.status, "preparing");
        assert!(reserve_client_event(&mut events, &client_id).is_err());
        let real_job_id = uuid::Uuid::new_v4().to_string();
        remember_event(
            &mut events,
            FileBatchEvent {
                job_id: real_job_id.clone(),
                client_id: Some(client_id.clone()),
                status: "running".into(),
                progress: 0.0,
                result: None,
                error: None,
            },
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].job_id, real_job_id);
        assert_eq!(events[0].client_id.as_deref(), Some(client_id.as_str()));
        let mut failed = events[0].clone();
        failed.status = "failed".into();
        remember_event(&mut events, failed);
        assert_eq!(events.len(), 1);
        assert!(reserve_client_event(&mut events, &client_id).is_err());
    }

    #[test]
    fn client_reservation_rejects_invalid_identifiers_without_creating_jobs() {
        let mut events = VecDeque::new();
        for identifier in ["", "../escape", "普通文字", "not-a-uuid"] {
            assert!(reserve_client_event(&mut events, identifier).is_err());
        }
        assert!(reserve_client_event(&mut events, &"a".repeat(81)).is_err());
        assert!(events.is_empty());
    }

    #[test]
    fn execution_preview_reflects_sources_that_changed_after_the_initial_check() {
        let root = temp_root();
        let first = root.join("first.txt");
        let second = root.join("second.txt");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let mut input = request(&first, BatchOperation::Rename);
        input.sources.push(second.to_string_lossy().into_owned());
        input.name_pattern = Some("renamed-{n}{dotext}".into());
        let initial = public_preview(&prepare_batch(&input).unwrap());
        assert_eq!(initial.items.len(), 2);
        fs::remove_file(&first).unwrap();
        fs::create_dir(&first).unwrap();
        let actual = public_preview(&prepare_batch(&input).unwrap());
        assert_eq!(actual.skipped, 1);
        assert_eq!(actual.items.len(), 1);
        assert_eq!(
            Path::new(&actual.items[0].source).file_name().unwrap(),
            "second.txt"
        );
        assert_eq!(
            Path::new(actual.items[0].target.as_ref().unwrap())
                .file_name()
                .unwrap(),
            "renamed-1.txt"
        );
        assert!(first.is_dir() && second.is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
