use super::jobs::{JobManager, JobTicket};
use super::resources::ResourceGovernor;
use super::storage::StorageManager;
use crate::path_safety::validate_leaf_filename;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const MAX_BATCH_FILES: usize = 500;

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
    extensions: Vec<String>,
    #[serde(default)]
    permanent: bool,
}

fn default_start_index() -> u32 {
    1
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileBatchExecutionResult {
    processed: usize,
    total: usize,
    bytes_processed: u64,
    cancelled: bool,
    recovery_batch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileBatchEvent {
    job_id: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileBatchRestoreResult {
    batch_id: String,
    restored: usize,
    skipped: usize,
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

fn render_name(pattern: &str, source: &Path, index: u32) -> Result<String, String> {
    if pattern.is_empty() || pattern.chars().count() > 160 {
        return Err("重命名模板不能为空且不能超过 160 个字符".to_string());
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let dot_extension = if extension.is_empty() {
        String::new()
    } else {
        format!(".{extension}")
    };
    let name = pattern
        .replace("{name}", stem)
        .replace("{ext}", extension)
        .replace("{dotext}", &dot_extension)
        .replace("{n}", &index.to_string());
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
        let item_index = request.start_index.saturating_add(items.len() as u32);
        let target = match request.operation {
            BatchOperation::Rename => {
                Some(source.with_file_name(render_name(pattern, &source, item_index)?))
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
            if target_key == source_key && request.operation == BatchOperation::Rename {
                conflict = Some("新文件名与原文件名相同".to_string());
            } else if target.exists() {
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

fn move_without_overwrite(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
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
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(source, target).map_err(|error| format!("复制文件失败: {error}"))?;
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

fn emit_event(app: &AppHandle, event: FileBatchEvent) {
    let _ = app.emit("file-batch-progress", event);
}

fn execute_batch(
    app: AppHandle,
    job_id: String,
    ticket: JobTicket,
    prepared: PreparedBatch,
) -> Result<(), String> {
    let manager = app.state::<JobManager>();
    manager.mark_running(&job_id)?;
    emit_event(
        &app,
        FileBatchEvent {
            job_id: job_id.clone(),
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
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("写入恢复清单失败: {error}"))?;
        recovery_batch_id = Some(batch_id);
    }

    for (index, item) in prepared.items.iter().enumerate() {
        if ticket.is_cancelled() {
            manager.mark_cancelled(&job_id)?;
            let result = FileBatchExecutionResult {
                processed,
                total,
                bytes_processed,
                cancelled: true,
                recovery_batch_id,
            };
            emit_event(
                &app,
                FileBatchEvent {
                    job_id,
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
                if target.exists() {
                    return Err(format!("目标文件已存在: {}", target.display()));
                }
                fs::copy(&item.source, target).map_err(|error| format!("复制文件失败: {error}"))?;
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
        let progress = processed as f32 / total as f32;
        manager.set_progress(&job_id, progress)?;
        if last_emit.elapsed() >= Duration::from_millis(100) || processed == total {
            emit_event(
                &app,
                FileBatchEvent {
                    job_id: job_id.clone(),
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
    };
    emit_event(
        &app,
        FileBatchEvent {
            job_id,
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
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_batch(&request))
        .await
        .map_err(|error| format!("预检任务失败: {error}"))??;
    if prepared.items.iter().any(|item| item.conflict.is_some()) {
        return Err("存在文件名冲突，请修改设置后重新预检".to_string());
    }
    let total_bytes = prepared.items.iter().map(|item| item.size).sum();
    let file_count = prepared.items.len();
    let active_limit = app.state::<ResourceGovernor>().effective_worker_limit();
    let ticket =
        app.state::<JobManager>()
            .begin_limited("file-batch", "文件批处理", active_limit)?;
    let job_id = ticket.id().to_string();
    let execution_job_id = job_id.clone();
    let execution_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = execute_batch(
            execution_app.clone(),
            execution_job_id.clone(),
            ticket,
            prepared,
        ) {
            let _ = execution_app
                .state::<JobManager>()
                .fail(&execution_job_id, &error);
            emit_event(
                &execution_app,
                FileBatchEvent {
                    job_id: execution_job_id,
                    status: "failed".into(),
                    progress: 0.0,
                    result: None,
                    error: Some(error),
                },
            );
        }
    });
    Ok(FileBatchStartResult {
        job_id,
        file_count,
        total_bytes,
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
        let manifest: RecoveryManifest = serde_json::from_slice(
            &fs::read(root.join("manifest.json")).map_err(|_| "恢复清单不存在".to_string())?,
        )
        .map_err(|error| format!("恢复清单无效: {error}"))?;
        if manifest.batch_id != batch_id {
            return Err("恢复清单与批次不匹配".to_string());
        }
        let mut restored = 0;
        let mut skipped = 0;
        let canonical_root =
            fs::canonicalize(&root).map_err(|error| format!("恢复目录无效: {error}"))?;
        for entry in manifest.entries {
            let stored_metadata = fs::symlink_metadata(&entry.stored).ok();
            let stored_within_batch = fs::canonicalize(&entry.stored)
                .ok()
                .is_some_and(|stored| stored.starts_with(&canonical_root));
            if stored_metadata
                .as_ref()
                .is_none_or(|metadata| !metadata.is_file() || is_link_like(metadata))
                || !stored_within_batch
                || entry.original.exists()
            {
                skipped += 1;
                continue;
            }
            move_without_overwrite(&entry.stored, &entry.original)?;
            restored += 1;
        }
        if restored > 0 && skipped == 0 {
            let _ = fs::remove_dir_all(&root);
        }
        Ok(FileBatchRestoreResult {
            batch_id,
            restored,
            skipped,
        })
    })
    .await
    .map_err(|error| format!("恢复任务失败: {error}"))?
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
            extensions: vec![],
            permanent: false,
        }
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
}
