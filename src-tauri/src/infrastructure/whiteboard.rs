use super::storage::StorageManager;
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const INDEX_FILE: &str = "index.json";
const DOCUMENT_LIMIT: usize = 12 * 1024 * 1024;
const THUMBNAIL_LIMIT: usize = 700 * 1024;

#[derive(Default)]
pub(crate) struct WhiteboardEditManager {
    owners: Mutex<HashMap<String, String>>,
}

impl WhiteboardEditManager {
    fn acquire(&self, id: &str, window_label: &str) -> Result<bool, String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "白板编辑状态不可用".to_string())?;
        match owners.get(id) {
            Some(owner) if owner != window_label => Ok(false),
            Some(_) => Ok(true),
            None => {
                owners.insert(id.to_string(), window_label.to_string());
                Ok(true)
            }
        }
    }

    fn take_over(&self, id: &str, window_label: &str) -> Result<Option<String>, String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "白板编辑状态不可用".to_string())?;
        Ok(owners
            .insert(id.to_string(), window_label.to_string())
            .filter(|owner| owner != window_label))
    }

    fn release(&self, id: &str, window_label: &str) -> Result<(), String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "白板编辑状态不可用".to_string())?;
        if owners.get(id).is_some_and(|owner| owner == window_label) {
            owners.remove(id);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WhiteboardMeta {
    id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    has_draft: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WhiteboardOpenResult {
    meta: WhiteboardMeta,
    document: Value,
    draft: Option<Value>,
    editable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveWhiteboardRequest {
    id: Option<String>,
    name: String,
    document: Value,
    thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveDraftRequest {
    id: String,
    name: String,
    document: Value,
}

fn safe_id(id: &str) -> Result<&str, String> {
    uuid::Uuid::parse_str(id)
        .map(|_| id)
        .map_err(|_| "白板标识无效".to_string())
}

fn clean_name(name: &str) -> String {
    let value = name.trim().chars().take(60).collect::<String>();
    if value.is_empty() {
        "未命名白板".to_string()
    } else {
        value
    }
}

fn roots(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = app.state::<StorageManager>().layout()?.whiteboards;
    Ok((
        root.join("Boards"),
        root.join("Drafts"),
        root.join(INDEX_FILE),
    ))
}

fn read_index(path: &Path) -> Result<Vec<WhiteboardMeta>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| format!("读取白板索引失败: {error}"))?)
        .map_err(|error| format!("白板索引损坏: {error}"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "白板文件缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建白板目录失败: {error}"))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    fs::write(&temporary, bytes).map_err(|error| format!("写入白板临时文件失败: {error}"))?;
    if path.exists() {
        let backup = parent.join(format!(
            ".{}.backup",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|error| format!("备份白板文件失败: {error}"))?;
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::rename(&backup, path);
            return Err(format!("提交白板文件失败: {error}"));
        }
        let _ = fs::remove_file(backup);
    } else {
        fs::rename(&temporary, path).map_err(|error| format!("提交白板文件失败: {error}"))?;
    }
    Ok(())
}

fn document_bytes(document: &Value) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(document).map_err(|error| format!("序列化白板失败: {error}"))?;
    if bytes.len() > DOCUMENT_LIMIT {
        return Err("白板数据超过单文件安全上限".to_string());
    }
    Ok(bytes)
}

fn decode_thumbnail(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "白板缩略图格式无效".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "白板缩略图无法解码".to_string())?;
    if bytes.len() > THUMBNAIL_LIMIT {
        return Err("白板缩略图过大".to_string());
    }
    Ok(bytes)
}

fn write_index(path: &Path, items: &[WhiteboardMeta]) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(items).map_err(|error| format!("序列化白板索引失败: {error}"))?;
    atomic_write(path, &bytes)
}

#[tauri::command]
pub(crate) fn list_whiteboards(app: AppHandle) -> Result<Vec<WhiteboardMeta>, String> {
    let (_, drafts, index) = roots(&app)?;
    let mut items = read_index(&index)?;
    for item in &mut items {
        item.has_draft = drafts.join(format!("{}.json", item.id)).is_file();
    }
    items.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(items)
}

#[tauri::command]
pub(crate) fn load_whiteboard(
    app: AppHandle,
    window: WebviewWindow,
    manager: tauri::State<'_, WhiteboardEditManager>,
    id: String,
) -> Result<WhiteboardOpenResult, String> {
    safe_id(&id)?;
    let (boards, drafts, index) = roots(&app)?;
    let meta = read_index(&index)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "白板不存在".to_string())?;
    let document: Value = serde_json::from_slice(
        &fs::read(boards.join(&id).join("board.json"))
            .map_err(|error| format!("读取白板失败: {error}"))?,
    )
    .map_err(|error| format!("白板数据损坏: {error}"))?;
    let draft_path = drafts.join(format!("{id}.json"));
    let draft = if draft_path.is_file() {
        Some(
            serde_json::from_slice(
                &fs::read(draft_path).map_err(|error| format!("读取恢复草稿失败: {error}"))?,
            )
            .map_err(|error| format!("恢复草稿损坏: {error}"))?,
        )
    } else {
        None
    };
    let editable = manager.acquire(&id, window.label())?;
    Ok(WhiteboardOpenResult {
        meta,
        document,
        draft,
        editable,
    })
}

#[tauri::command]
pub(crate) fn save_whiteboard(
    app: AppHandle,
    window: WebviewWindow,
    manager: tauri::State<'_, WhiteboardEditManager>,
    request: SaveWhiteboardRequest,
) -> Result<WhiteboardMeta, String> {
    let (boards, drafts, index) = roots(&app)?;
    let mut items = read_index(&index)?;
    let id = request
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    safe_id(&id)?;
    if !manager.acquire(&id, window.label())? {
        return Err("该白板正在另一个窗口编辑；请先接管编辑权".to_string());
    }
    let now = Utc::now().timestamp_millis();
    let created_at = items
        .iter()
        .find(|item| item.id == id)
        .map(|item| item.created_at)
        .unwrap_or(now);
    let meta = WhiteboardMeta {
        id: id.clone(),
        name: clean_name(&request.name),
        created_at,
        updated_at: now,
        has_draft: false,
    };
    let board_root = boards.join(&id);
    atomic_write(
        &board_root.join("board.json"),
        &document_bytes(&request.document)?,
    )?;
    if let Some(data_url) = request.thumbnail_data_url {
        atomic_write(
            &board_root.join("thumbnail.png"),
            &decode_thumbnail(&data_url)?,
        )?;
    }
    let _ = fs::remove_file(drafts.join(format!("{id}.json")));
    items.retain(|item| item.id != id);
    items.push(meta.clone());
    write_index(&index, &items)?;
    Ok(meta)
}

#[tauri::command]
pub(crate) fn save_whiteboard_draft(
    app: AppHandle,
    window: WebviewWindow,
    manager: tauri::State<'_, WhiteboardEditManager>,
    request: SaveDraftRequest,
) -> Result<(), String> {
    safe_id(&request.id)?;
    if !manager.acquire(&request.id, window.label())? {
        return Err("该白板正在另一个窗口编辑，当前窗口不会覆盖它的草稿".to_string());
    }
    let (_, drafts, _) = roots(&app)?;
    let payload = serde_json::json!({ "name": clean_name(&request.name), "document": request.document, "savedAt": Utc::now().timestamp_millis() });
    atomic_write(
        &drafts.join(format!("{}.json", request.id)),
        &document_bytes(&payload)?,
    )
}

#[tauri::command]
pub(crate) fn discard_whiteboard_draft(app: AppHandle, id: String) -> Result<(), String> {
    safe_id(&id)?;
    let (_, drafts, _) = roots(&app)?;
    let path = drafts.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("清理恢复草稿失败: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_whiteboard_thumbnail(
    app: AppHandle,
    id: String,
) -> Result<Option<String>, String> {
    safe_id(&id)?;
    let (boards, _, _) = roots(&app)?;
    let path = boards.join(id).join("thumbnail.png");
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| format!("读取白板缩略图失败: {error}"))?;
    Ok(Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

#[tauri::command]
pub(crate) fn take_over_whiteboard_edit(
    app: AppHandle,
    window: WebviewWindow,
    manager: tauri::State<'_, WhiteboardEditManager>,
    id: String,
) -> Result<(), String> {
    safe_id(&id)?;
    if let Some(previous_owner) = manager.take_over(&id, window.label())? {
        if let Some(previous_window) = app.get_webview_window(&previous_owner) {
            let _ = previous_window.emit("whiteboard-edit-revoked", &id);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn release_whiteboard_edit(
    window: WebviewWindow,
    manager: tauri::State<'_, WhiteboardEditManager>,
    id: String,
) -> Result<(), String> {
    safe_id(&id)?;
    manager.release(&id, window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whiteboard_ids_and_names_are_bounded() {
        assert!(safe_id(&uuid::Uuid::new_v4().to_string()).is_ok());
        assert!(safe_id("../Config").is_err());
        assert_eq!(clean_name("   "), "未命名白板");
        assert_eq!(clean_name(&"a".repeat(100)).chars().count(), 60);
    }

    #[test]
    fn thumbnails_accept_only_small_png_data_urls() {
        let valid = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"png")
        );
        assert_eq!(decode_thumbnail(&valid).unwrap(), b"png");
        assert!(decode_thumbnail("data:image/jpeg;base64,AA==").is_err());
    }

    #[test]
    fn only_one_window_edits_a_whiteboard_until_takeover_or_release() {
        let manager = WhiteboardEditManager::default();
        let id = uuid::Uuid::new_v4().to_string();
        assert!(manager.acquire(&id, "quick-host-1").unwrap());
        assert!(!manager.acquire(&id, "quick-host-2").unwrap());
        assert_eq!(
            manager.take_over(&id, "quick-host-2").unwrap(),
            Some("quick-host-1".into())
        );
        assert!(!manager.acquire(&id, "quick-host-1").unwrap());
        manager.release(&id, "quick-host-2").unwrap();
        assert!(manager.acquire(&id, "main").unwrap());
    }
}
