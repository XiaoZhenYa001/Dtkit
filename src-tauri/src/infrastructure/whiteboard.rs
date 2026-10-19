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
    operations: Mutex<()>,
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

    pub(crate) fn release_window(&self, label: &str) {
        if let Ok(mut owners) = self.owners.lock() {
            owners.retain(|_, owner| owner_window(owner) != label);
        }
    }
}

fn edit_owner(label: &str, instance_id: Option<&str>) -> Result<String, String> {
    match instance_id {
        None => Ok(label.to_string()),
        Some(id)
            if !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) =>
        {
            Ok(format!("{label}::{id}"))
        }
        _ => Err("白板页面标识无效".to_string()),
    }
}

fn owner_window(owner: &str) -> &str {
    owner.split_once("::").map_or(owner, |(label, _)| label)
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
    is_formal: bool,
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

fn write_board_files(
    board_root: &Path,
    document: &Value,
    thumbnail_data_url: Option<&str>,
) -> Result<(), String> {
    let document = document_bytes(document)?;
    let thumbnail = thumbnail_data_url.map(decode_thumbnail).transpose()?;
    atomic_write(&board_root.join("board.json"), &document)?;
    if let Some(bytes) = thumbnail {
        atomic_write(&board_root.join("thumbnail.png"), &bytes)?;
    }
    Ok(())
}

fn write_index(path: &Path, items: &[WhiteboardMeta]) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(items).map_err(|error| format!("序列化白板索引失败: {error}"))?;
    atomic_write(path, &bytes)
}

fn draft_metadata(id: &str, payload: &Value, modified_at: i64) -> Option<WhiteboardMeta> {
    safe_id(id).ok()?;
    let document = payload.get("document")?;
    if document.get("version").and_then(Value::as_u64) != Some(2)
        || document.get("infinite").and_then(Value::as_bool) != Some(true)
        || !document.get("elements").is_some_and(Value::is_array)
    {
        return None;
    }
    let saved_at = payload
        .get("savedAt")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(modified_at.max(0));
    Some(WhiteboardMeta {
        id: id.to_string(),
        name: clean_name(payload.get("name").and_then(Value::as_str).unwrap_or("")),
        created_at: saved_at,
        updated_at: saved_at,
        has_draft: true,
    })
}

fn merge_draft_metadata(
    mut items: Vec<WhiteboardMeta>,
    drafts: impl IntoIterator<Item = WhiteboardMeta>,
) -> Vec<WhiteboardMeta> {
    let mut positions: HashMap<String, usize> = items
        .iter()
        .enumerate()
        .map(|(position, item)| (item.id.clone(), position))
        .collect();
    for draft in drafts {
        if let Some(position) = positions.get(&draft.id) {
            items[*position].has_draft = true;
        } else {
            positions.insert(draft.id.clone(), items.len());
            items.push(draft);
        }
    }
    items.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    items
}

fn history_with_drafts(
    mut items: Vec<WhiteboardMeta>,
    drafts: &Path,
) -> Result<Vec<WhiteboardMeta>, String> {
    items.retain(|item| safe_id(&item.id).is_ok());
    for item in &mut items {
        item.has_draft = drafts.join(format!("{}.json", item.id)).is_file();
    }
    let formal_ids: std::collections::HashSet<_> =
        items.iter().map(|item| item.id.clone()).collect();
    let entries = match fs::read_dir(drafts) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(merge_draft_metadata(items, []))
        }
        Err(error) => return Err(format!("读取白板恢复草稿列表失败: {error}")),
    };
    let mut recovered = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || !entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if safe_id(id).is_err() || formal_ids.contains(id) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > DOCUMENT_LIMIT as u64 {
            continue;
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0);
        let Ok(bytes) = fs::read(&path) else { continue };
        let Ok(payload) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if let Some(meta) = draft_metadata(id, &payload, modified_at) {
            recovered.push(meta);
        }
    }
    Ok(merge_draft_metadata(items, recovered))
}

#[tauri::command]
pub(crate) fn list_whiteboards(app: AppHandle) -> Result<Vec<WhiteboardMeta>, String> {
    let manager = app.state::<WhiteboardEditManager>();
    let _operation = manager
        .operations
        .lock()
        .map_err(|_| "白板存储状态不可用".to_string())?;
    let (_, drafts, index) = roots(&app)?;
    history_with_drafts(read_index(&index)?, &drafts)
}

#[tauri::command]
pub(crate) fn load_whiteboard(
    app: AppHandle,
    window: WebviewWindow,
    manager: tauri::State<'_, WhiteboardEditManager>,
    id: String,
    instance_id: Option<String>,
) -> Result<WhiteboardOpenResult, String> {
    safe_id(&id)?;
    let owner = edit_owner(window.label(), instance_id.as_deref())?;
    let _operation = manager
        .operations
        .lock()
        .map_err(|_| "白板存储状态不可用".to_string())?;
    let (boards, drafts, index) = roots(&app)?;
    let formal_meta = read_index(&index)?.into_iter().find(|item| item.id == id);
    let draft_path = drafts.join(format!("{id}.json"));
    let draft: Option<Value> = if draft_path.is_file() {
        Some(
            serde_json::from_slice(
                &fs::read(draft_path).map_err(|error| format!("读取恢复草稿失败: {error}"))?,
            )
            .map_err(|error| format!("恢复草稿损坏: {error}"))?,
        )
    } else {
        None
    };
    let is_formal = formal_meta.is_some();
    let document: Value = if is_formal {
        serde_json::from_slice(
            &fs::read(boards.join(&id).join("board.json"))
                .map_err(|error| format!("读取白板失败: {error}"))?,
        )
        .map_err(|error| format!("白板数据损坏: {error}"))?
    } else {
        draft
            .as_ref()
            .and_then(|value| value.get("document"))
            .cloned()
            .ok_or_else(|| "白板不存在".to_string())?
    };
    let meta = formal_meta.unwrap_or_else(|| WhiteboardMeta {
        id: id.clone(),
        name: clean_name(
            draft
                .as_ref()
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("未命名白板"),
        ),
        created_at: 0,
        updated_at: draft
            .as_ref()
            .and_then(|value| value.get("savedAt"))
            .and_then(Value::as_i64)
            .unwrap_or(0),
        has_draft: true,
    });
    let editable = manager.acquire(&id, &owner)?;
    Ok(WhiteboardOpenResult {
        meta,
        document,
        draft,
        editable,
        is_formal,
    })
}

#[tauri::command]
pub(crate) fn save_whiteboard(
    app: AppHandle,
    window: WebviewWindow,
    manager: tauri::State<'_, WhiteboardEditManager>,
    request: SaveWhiteboardRequest,
    instance_id: Option<String>,
) -> Result<WhiteboardMeta, String> {
    let _native_work = super::launch::keep_native_work(&app);
    let owner = edit_owner(window.label(), instance_id.as_deref())?;
    let _operation = manager
        .operations
        .lock()
        .map_err(|_| "白板存储状态不可用".to_string())?;
    let (boards, drafts, index) = roots(&app)?;
    let mut items = read_index(&index)?;
    let id = request
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    safe_id(&id)?;
    if !manager.acquire(&id, &owner)? {
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
    write_board_files(
        &board_root,
        &request.document,
        request.thumbnail_data_url.as_deref(),
    )?;
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
    instance_id: Option<String>,
) -> Result<(), String> {
    safe_id(&request.id)?;
    let _native_work = super::launch::keep_native_work(&app);
    let owner = edit_owner(window.label(), instance_id.as_deref())?;
    let _operation = manager
        .operations
        .lock()
        .map_err(|_| "白板存储状态不可用".to_string())?;
    if !manager.acquire(&request.id, &owner)? {
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
pub(crate) fn discard_whiteboard_draft(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    instance_id: Option<String>,
) -> Result<(), String> {
    safe_id(&id)?;
    let _native_work = super::launch::keep_native_work(&app);
    let manager = app.state::<WhiteboardEditManager>();
    let _operation = manager
        .operations
        .lock()
        .map_err(|_| "白板存储状态不可用".to_string())?;
    let owner = edit_owner(window.label(), instance_id.as_deref())?;
    if !manager.acquire(&id, &owner)? {
        return Err("该白板正在另一个页面编辑，当前页面不会清理它的草稿".to_string());
    }
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
    instance_id: Option<String>,
) -> Result<(), String> {
    safe_id(&id)?;
    let owner = edit_owner(window.label(), instance_id.as_deref())?;
    let _operation = manager
        .operations
        .lock()
        .map_err(|_| "白板存储状态不可用".to_string())?;
    if let Some(previous_owner) = manager.take_over(&id, &owner)? {
        if let Some(previous_window) = app.get_webview_window(owner_window(&previous_owner)) {
            let instance = previous_owner
                .split_once("::")
                .map(|(_, instance)| instance);
            let _ = previous_window.emit(
                "whiteboard-edit-revoked",
                serde_json::json!({ "id": id, "instanceId": instance }),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn release_whiteboard_edit(
    window: WebviewWindow,
    manager: tauri::State<'_, WhiteboardEditManager>,
    id: String,
    instance_id: Option<String>,
) -> Result<(), String> {
    safe_id(&id)?;
    let owner = edit_owner(window.label(), instance_id.as_deref())?;
    manager.release(&id, &owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_metadata_requires_safe_ids_and_documents_and_falls_back_to_file_time() {
        let id = uuid::Uuid::new_v4().to_string();
        let payload = serde_json::json!({
            "name": "  恢复中的白板  ", "savedAt": 500,
            "document": { "version": 2, "infinite": true, "elements": [] }
        });
        let meta = draft_metadata(&id, &payload, 250).unwrap();
        assert_eq!(meta.id, id);
        assert_eq!(meta.name, "恢复中的白板");
        assert_eq!(meta.created_at, 500);
        assert_eq!(meta.updated_at, 500);
        assert!(meta.has_draft);
        assert!(draft_metadata("../outside", &payload, 250).is_none());
        assert!(draft_metadata(&id, &serde_json::json!({ "document": {} }), 250).is_none());
        let fallback = draft_metadata(
            &id,
            &serde_json::json!({
                "savedAt": -1, "document": { "version": 2, "infinite": true, "elements": [] }
            }),
            250,
        )
        .unwrap();
        assert_eq!(fallback.name, "未命名白板");
        assert_eq!(fallback.updated_at, 250);
    }

    #[test]
    fn orphan_drafts_are_listed_without_replacing_formal_metadata_or_failing_on_corruption() {
        let draft_root =
            std::env::temp_dir().join(format!("dtkit-whiteboard-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&draft_root).unwrap();
        let formal_id = uuid::Uuid::new_v4().to_string();
        let orphan_id = uuid::Uuid::new_v4().to_string();
        let fallback_id = uuid::Uuid::new_v4().to_string();
        let broken_id = uuid::Uuid::new_v4().to_string();
        let document = serde_json::json!({ "version": 2, "infinite": true, "elements": [] });
        for (id, payload) in [
            (
                formal_id.as_str(),
                serde_json::json!({ "name": "草稿新名", "savedAt": 30, "document": document }),
            ),
            (
                orphan_id.as_str(),
                serde_json::json!({ "name": "未正式保存的白板", "savedAt": 40, "document": document }),
            ),
            (
                fallback_id.as_str(),
                serde_json::json!({ "document": document }),
            ),
            (
                "not-a-whiteboard-id",
                serde_json::json!({ "document": document }),
            ),
        ] {
            fs::write(
                draft_root.join(format!("{id}.json")),
                serde_json::to_vec(&payload).unwrap(),
            )
            .unwrap();
        }
        fs::write(draft_root.join(format!("{broken_id}.json")), b"{broken").unwrap();
        fs::write(draft_root.join("ignored.json.backup"), b"{}").unwrap();
        let formal = WhiteboardMeta {
            id: formal_id.clone(),
            name: "正式名称".into(),
            created_at: 10,
            updated_at: 20,
            has_draft: false,
        };
        let items = history_with_drafts(vec![formal], &draft_root).unwrap();
        assert_eq!(items.len(), 3);
        assert!(items
            .windows(2)
            .all(|pair| pair[0].updated_at >= pair[1].updated_at));
        let formal = items.iter().find(|item| item.id == formal_id).unwrap();
        assert_eq!(formal.name, "正式名称");
        assert_eq!(formal.created_at, 10);
        assert_eq!(formal.updated_at, 20);
        assert!(formal.has_draft);
        let orphan = items.iter().find(|item| item.id == orphan_id).unwrap();
        assert_eq!(orphan.name, "未正式保存的白板");
        assert_eq!(orphan.updated_at, 40);
        assert!(orphan.has_draft);
        let fallback = items.iter().find(|item| item.id == fallback_id).unwrap();
        assert_eq!(fallback.name, "未命名白板");
        assert!(fallback.updated_at > 0);
        for entry in fs::read_dir(&draft_root).unwrap().flatten() {
            fs::remove_file(entry.path()).unwrap();
        }
        fs::remove_dir(&draft_root).unwrap();
    }

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
    fn invalid_thumbnail_preserves_existing_document_and_thumbnail() {
        let board_root = std::env::temp_dir().join(format!(
            "dtkit-whiteboard-validation-{}",
            uuid::Uuid::new_v4()
        ));
        let thumbnail = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"original thumbnail")
        );
        let original = serde_json::json!({ "version": 2, "elements": [] });
        write_board_files(&board_root, &original, Some(&thumbnail)).unwrap();
        let document_path = board_root.join("board.json");
        let thumbnail_path = board_root.join("thumbnail.png");
        let before = fs::read(&document_path).unwrap();

        let changed = serde_json::json!({ "version": 2, "elements": [{ "id": "new" }] });
        assert!(write_board_files(
            &board_root,
            &changed,
            Some("data:image/png;base64,%%%invalid%%%")
        )
        .is_err());
        assert_eq!(fs::read(&document_path).unwrap(), before);
        assert_eq!(fs::read(&thumbnail_path).unwrap(), b"original thumbnail");

        fs::remove_file(document_path).unwrap();
        fs::remove_file(thumbnail_path).unwrap();
        fs::remove_dir(board_root).unwrap();
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

    #[test]
    fn pages_in_one_window_have_separate_edit_leases() {
        let manager = WhiteboardEditManager::default();
        let id = uuid::Uuid::new_v4().to_string();
        let first = edit_owner("main", Some("page-1")).unwrap();
        let second = edit_owner("main", Some("page-2")).unwrap();
        assert!(manager.acquire(&id, &first).unwrap());
        assert!(!manager.acquire(&id, &second).unwrap());
        manager.release(&id, &second).unwrap();
        assert!(!manager.acquire(&id, &second).unwrap());
        assert_eq!(
            manager.take_over(&id, &second).unwrap(),
            Some(first.clone())
        );
        manager.release(&id, &first).unwrap();
        assert!(!manager.acquire(&id, &first).unwrap());
        manager.release_window("main");
        assert!(manager.acquire(&id, &first).unwrap());
    }

    #[test]
    fn edit_owner_rejects_ambiguous_page_identifiers_and_keeps_legacy_calls() {
        assert_eq!(edit_owner("main", None).unwrap(), "main");
        assert!(edit_owner("main", Some("page::other")).is_err());
        assert!(edit_owner("main", Some("")).is_err());
        assert_eq!(owner_window("main::page-1"), "main");
    }
}
