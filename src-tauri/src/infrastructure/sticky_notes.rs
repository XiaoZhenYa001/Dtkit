//! On-demand sticky-note storage and windows. No polling or startup WebViews.
use super::storage::StorageManager;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use uuid::Uuid;

const MAX_NOTES: usize = 200;
const MAX_WINDOWS: usize = 8;
const MAX_TITLE: usize = 80;
const MAX_CONTENT: usize = 20_000;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_990;
const LABEL_PREFIX: &str = "sticky-note-";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteData {
    id: String,
    title: String,
    content: String,
    color: String,
    pinned: bool,
    created_at: i64,
    updated_at: i64,
    revision: u64,
    trashed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StickyNote {
    #[serde(flatten)]
    note: NoteData,
    opened: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StickyNoteDraft {
    id: String,
    title: String,
    content: String,
    color: String,
    pinned: bool,
    revision: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
struct Geometry {
    // Position and size are physical pixels; the current monitor supplies DPI.
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredNote {
    #[serde(flatten)]
    note: NoteData,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    geometry: Option<Geometry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Store {
    version: u32,
    notes: Vec<StoredNote>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            notes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Session {
    Opening,
    Open,
    Closing,
}

#[derive(Default)]
struct Inner {
    cache: Option<(PathBuf, Store)>,
    sessions: HashMap<String, Session>,
}

#[derive(Default, Clone)]
pub(crate) struct StickyNoteManager(Arc<Mutex<Inner>>);

impl StickyNoteManager {
    pub(crate) fn has_open_notes(&self) -> bool {
        self.0
            .lock()
            .map(|inner| !inner.sessions.is_empty())
            .unwrap_or(true)
    }

    pub(crate) fn invalidate(&self) {
        if let Ok(mut inner) = self.0.lock() {
            inner.cache = None;
        }
    }

    fn read<T>(
        &self,
        path: &Path,
        operation: impl FnOnce(&Store, &Inner) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut inner = self.0.lock().map_err(|_| "便签状态不可用")?;
        ensure_loaded(&mut inner, path)?;
        operation(&inner.cache.as_ref().expect("loaded").1, &inner)
    }

    fn mutate<T>(
        &self,
        path: &Path,
        operation: impl FnOnce(&mut Store, &Inner) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut inner = self.0.lock().map_err(|_| "便签状态不可用")?;
        ensure_loaded(&mut inner, path)?;
        let mut store = inner.cache.as_ref().expect("loaded").1.clone();
        let result = operation(&mut store, &inner)?;
        write_store(path, &store)?;
        inner.cache = Some((path.to_path_buf(), store));
        Ok(result)
    }

    fn remove_session(&self, id: &str) {
        if let Ok(mut inner) = self.0.lock() {
            inner.sessions.remove(id);
        }
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        Ok(())
    } else {
        Err("便签标识无效".into())
    }
}

fn validate_fields(title: &str, content: &str, color: &str, revision: u64) -> Result<(), String> {
    if title.encode_utf16().count() > MAX_TITLE || content.encode_utf16().count() > MAX_CONTENT {
        return Err("便签标题最多 80 字，正文最多 20000 字".into());
    }
    if title.contains('\0') || content.contains('\0') {
        return Err("便签不能包含空字符".into());
    }
    if !matches!(
        color,
        "yellow" | "green" | "blue" | "pink" | "purple" | "gray"
    ) {
        return Err("便签颜色无效".into());
    }
    if revision == 0 || revision > MAX_REVISION {
        return Err("便签版本无效".into());
    }
    Ok(())
}

fn validate_store(store: &Store) -> Result<(), String> {
    if store.version != 1 || store.notes.len() > MAX_NOTES {
        return Err("便签文件版本或数量无效".into());
    }
    let mut ids = HashSet::new();
    for record in &store.notes {
        let note = &record.note;
        validate_id(&note.id)?;
        validate_fields(&note.title, &note.content, &note.color, note.revision)?;
        if !ids.insert(&note.id) || note.created_at < 0 || note.updated_at < note.created_at {
            return Err("便签文件包含重复标识或无效时间".into());
        }
        if record.geometry.is_some_and(|g| {
            g.width == 0 || g.height == 0 || g.width > 100_000 || g.height > 100_000
        }) {
            return Err("便签窗口尺寸无效".into());
        }
    }
    Ok(())
}

fn read_store(path: &Path) -> Result<Store, String> {
    let file = File::open(path).map_err(|e| format!("无法读取便签文件: {e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES {
        return Err("便签文件过大，未修改原文件".into());
    }
    let store: Store =
        serde_json::from_reader(file).map_err(|e| format!("便签文件损坏，未修改原文件: {e}"))?;
    validate_store(&store).map_err(|e| format!("便签文件损坏，未修改原文件: {e}"))?;
    Ok(store)
}

fn ensure_loaded(inner: &mut Inner, path: &Path) -> Result<(), String> {
    if inner
        .cache
        .as_ref()
        .is_some_and(|(cached, _)| cached == path)
    {
        return Ok(());
    }
    let backup = path.with_extension("json.bak");
    let store = if path.exists() {
        // A malformed primary must never be silently replaced with an empty/older store.
        read_store(path)?
    } else if backup.exists() {
        let recovered = read_store(&backup)?;
        write_store(path, &recovered)?;
        recovered
    } else {
        Store::default()
    };
    inner.cache = Some((path.to_path_buf(), store));
    Ok(())
}

fn synced_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("无法写入便签文件: {e}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("保存便签失败: {e}"))
}

fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    validate_store(store)?;
    let parent = path.parent().ok_or("便签目录无效")?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建便签目录: {e}"))?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let backup_temporary = path.with_extension("json.bak.tmp");
    let bytes = serde_json::to_vec(store).map_err(|e| format!("便签序列化失败: {e}"))?;
    synced_write(&temporary, &bytes)?;
    if path.exists() {
        // Keep the previous committed version. Never move the primary away first:
        // rename replaces it atomically on Windows and Unix.
        let old = fs::read(path).map_err(|e| format!("无法备份便签: {e}"))?;
        synced_write(&backup_temporary, &old)?;
        fs::rename(&backup_temporary, &backup).map_err(|e| format!("无法提交便签备份: {e}"))?;
    }
    fs::rename(&temporary, path).map_err(|e| format!("无法提交便签，原数据已保留: {e}"))?;
    Ok(())
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .state::<StorageManager>()
        .layout()?
        .kits
        .join("StickyNotes")
        .join("notes.json"))
}

fn is_manager(label: &str) -> bool {
    label == "main" || label.starts_with("quick-host-")
}

fn authorize_manager(window: &WebviewWindow) -> Result<(), String> {
    if is_manager(window.label()) {
        Ok(())
    } else {
        Err("当前窗口不能管理便签".into())
    }
}

fn authorize_note(window: &WebviewWindow, id: &str, allow_manager: bool) -> Result<(), String> {
    authorize_note_label(window.label(), id, allow_manager)
}

fn authorize_note_label(label: &str, id: &str, allow_manager: bool) -> Result<(), String> {
    validate_id(id)?;
    if label == format!("{LABEL_PREFIX}{id}") || (allow_manager && is_manager(label)) {
        Ok(())
    } else {
        Err("只能访问当前窗口所属的便签".into())
    }
}

fn require_enabled(app: &AppHandle) -> Result<(), String> {
    if app
        .state::<super::tool_modules::ToolModuleManager>()
        .is_enabled("sticky-notes")
    {
        Ok(())
    } else {
        Err("便签工具已停用".into())
    }
}

fn emit_changed(app: &AppHandle, id: &str) {
    let _ = app.emit("sticky-notes-changed", serde_json::json!({ "id": id }));
}

async fn io<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce(StickyNoteManager, PathBuf) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let _work = super::launch::keep_native_work(app);
    let manager = app.state::<StickyNoteManager>().inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || operation(manager, storage_path(&app)?))
        .await
        .map_err(|e| format!("便签任务失败: {e}"))?
}

fn view(note: &NoteData, inner: &Inner) -> StickyNote {
    StickyNote {
        note: note.clone(),
        opened: inner.sessions.contains_key(&note.id),
    }
}

#[tauri::command]
pub(crate) async fn list_sticky_notes(window: WebviewWindow) -> Result<Vec<StickyNote>, String> {
    authorize_manager(&window)?;
    io(window.app_handle(), |manager, path| {
        manager.read(&path, |store, inner| {
            Ok(store
                .notes
                .iter()
                .map(|record| view(&record.note, inner))
                .collect())
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_sticky_note(
    window: WebviewWindow,
    id: String,
) -> Result<StickyNote, String> {
    authorize_note(&window, &id, true)?;
    io(window.app_handle(), move |manager, path| {
        manager.read(&path, |store, inner| {
            let record = store
                .notes
                .iter()
                .find(|record| record.note.id == id)
                .ok_or("便签不存在")?;
            Ok(view(&record.note, inner))
        })
    })
    .await
}

fn create_note(manager: &StickyNoteManager, path: &Path) -> Result<StickyNote, String> {
    manager.mutate(path, |store, inner| {
        if store.notes.len() >= MAX_NOTES {
            return Err("最多保存 200 张便签，请先从回收站永久删除不需要的便签".into());
        }
        let now = Utc::now().timestamp_millis();
        let note = NoteData {
            id: Uuid::new_v4().to_string(),
            title: String::new(),
            content: String::new(),
            color: "yellow".into(),
            pinned: true,
            created_at: now,
            updated_at: now,
            revision: 1,
            trashed_at: None,
        };
        let result = view(&note, inner);
        store.notes.push(StoredNote {
            note,
            geometry: None,
        });
        Ok(result)
    })
}

#[tauri::command]
pub(crate) async fn create_sticky_note(window: WebviewWindow) -> Result<StickyNote, String> {
    authorize_manager(&window)?;
    require_enabled(window.app_handle())?;
    let note = io(window.app_handle(), |manager, path| {
        create_note(&manager, &path)
    })
    .await?;
    emit_changed(window.app_handle(), &note.note.id);
    Ok(note)
}

fn save_note(
    manager: &StickyNoteManager,
    path: &Path,
    draft: StickyNoteDraft,
) -> Result<StickyNote, String> {
    validate_id(&draft.id)?;
    validate_fields(&draft.title, &draft.content, &draft.color, draft.revision)?;
    manager.mutate(path, |store, inner| {
        if inner.sessions.get(&draft.id) == Some(&Session::Closing) {
            return Err("便签正在关闭，请稍后重试".into());
        }
        let record = store
            .notes
            .iter_mut()
            .find(|record| record.note.id == draft.id)
            .ok_or("便签不存在")?;
        if record.note.trashed_at.is_some() {
            return Err("请先恢复已删除的便签".into());
        }
        if record.note.revision != draft.revision {
            return Err("便签已在其他位置更新，请重新载入后再保存".into());
        }
        if record.note.revision >= MAX_REVISION {
            return Err("便签版本已达上限".into());
        }
        record.note.title = draft.title;
        record.note.content = draft.content;
        record.note.color = draft.color;
        record.note.pinned = draft.pinned;
        record.note.updated_at = Utc::now().timestamp_millis().max(record.note.updated_at);
        record.note.revision += 1;
        Ok(view(&record.note, inner))
    })
}

#[tauri::command]
pub(crate) async fn save_sticky_note(
    window: WebviewWindow,
    draft: StickyNoteDraft,
) -> Result<StickyNote, String> {
    authorize_note(&window, &draft.id, false)?;
    let note = io(window.app_handle(), move |manager, path| {
        save_note(&manager, &path, draft)
    })
    .await?;
    // Persist first. If a platform rejects the visual update, stored text remains safe.
    let _ = window.set_always_on_top(note.note.pinned);
    let _ = window.set_title(if note.note.title.trim().is_empty() {
        "DtKit 便签"
    } else {
        &note.note.title
    });
    emit_changed(window.app_handle(), &note.note.id);
    Ok(note)
}

fn reserve_open(manager: &StickyNoteManager, path: &Path, id: &str) -> Result<StoredNote, String> {
    let mut inner = manager.0.lock().map_err(|_| "便签状态不可用")?;
    ensure_loaded(&mut inner, path)?;
    if inner.sessions.contains_key(id) {
        return Err("便签窗口正在打开或关闭，请稍后重试".into());
    }
    if inner.sessions.len() >= MAX_WINDOWS {
        return Err("最多同时打开 8 张便签，请先关闭不需要的便签".into());
    }
    let record = inner
        .cache
        .as_ref()
        .expect("loaded")
        .1
        .notes
        .iter()
        .find(|record| record.note.id == id)
        .cloned()
        .ok_or("便签不存在")?;
    if record.note.trashed_at.is_some() {
        return Err("请先从回收站恢复便签".into());
    }
    inner.sessions.insert(id.to_string(), Session::Opening);
    Ok(record)
}

// Clamp to the monitor with the most overlap, or the nearest one after a monitor
// is disconnected. Keep the whole note reachable, including its drag/close bar.
fn clamp_geometry(saved: Geometry, areas: &[(Geometry, f64)]) -> Option<Geometry> {
    let (area, scale) = areas.iter().max_by_key(|(area, _)| {
        let overlap_x = (i64::from(saved.x) + i64::from(saved.width))
            .min(i64::from(area.x) + i64::from(area.width))
            - i64::from(saved.x).max(i64::from(area.x));
        let overlap_y = (i64::from(saved.y) + i64::from(saved.height))
            .min(i64::from(area.y) + i64::from(area.height))
            - i64::from(saved.y).max(i64::from(area.y));
        let overlap = overlap_x.max(0) * overlap_y.max(0);
        let dx = (i64::from(saved.x) - i64::from(area.x)).abs();
        let dy = (i64::from(saved.y) - i64::from(area.y)).abs();
        (overlap, -(dx + dy))
    })?;
    let width = saved.width.max((250.0 * scale) as u32).min(area.width);
    let height = saved.height.max((240.0 * scale) as u32).min(area.height);
    Some(Geometry {
        x: i64::from(saved.x).clamp(
            i64::from(area.x),
            i64::from(area.x) + i64::from(area.width - width),
        ) as i32,
        y: i64::from(saved.y).clamp(
            i64::from(area.y),
            i64::from(area.y) + i64::from(area.height - height),
        ) as i32,
        width,
        height,
    })
}

fn build_note_window(app: &AppHandle, record: &StoredNote) -> Result<WebviewWindow, String> {
    let id = &record.note.id;
    let window = WebviewWindowBuilder::new(
        app,
        format!("{LABEL_PREFIX}{id}"),
        WebviewUrl::App(format!("sticky-note.html?id={id}").into()),
    )
    .title(if record.note.title.trim().is_empty() {
        "DtKit 便签"
    } else {
        &record.note.title
    })
    .inner_size(330.0, 380.0)
    .min_inner_size(250.0, 240.0)
    .decorations(false)
    .resizable(true)
    .always_on_top(record.note.pinned)
    .visible(false)
    .shadow(true)
    .center()
    .build()
    .map_err(|e| format!("无法打开便签窗口: {e}"))?;
    let setup = (|| {
        if let Some(saved) = record.geometry {
            let areas: Vec<_> = window
                .available_monitors()
                .map_err(|e| e.to_string())?
                .iter()
                .map(|monitor| {
                    let area = monitor.work_area();
                    (
                        Geometry {
                            x: area.position.x,
                            y: area.position.y,
                            width: area.size.width,
                            height: area.size.height,
                        },
                        monitor.scale_factor(),
                    )
                })
                .collect();
            if let Some(geometry) = clamp_geometry(saved, &areas) {
                window
                    .set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y))
                    .map_err(|e| e.to_string())?;
                window
                    .set_size(tauri::PhysicalSize::new(geometry.width, geometry.height))
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = setup {
        let _ = window.destroy();
        return Err(error);
    }
    Ok(window)
}

#[tauri::command]
pub(crate) async fn open_sticky_note(window: WebviewWindow, id: String) -> Result<(), String> {
    let _work = super::launch::keep_native_work(window.app_handle());
    authorize_manager(&window)?;
    validate_id(&id)?;
    let app = window.app_handle();
    require_enabled(app)?;
    if let Some(existing) = app.get_webview_window(&format!("{LABEL_PREFIX}{id}")) {
        let manager = app.state::<StickyNoteManager>();
        let ready = manager
            .0
            .lock()
            .map_err(|_| "便签状态不可用")?
            .sessions
            .get(&id)
            == Some(&Session::Open);
        if !ready {
            return Err("便签窗口正在打开或关闭，请稍后重试".into());
        }
        existing.unminimize().map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let note_id = id.clone();
    let record = io(app, move |manager, path| {
        reserve_open(&manager, &path, &note_id)
    })
    .await?;
    let manager = app.state::<StickyNoteManager>().inner().clone();
    // Async Tauri commands do not run on the UI thread; WebView creation must
    // never occur while that thread or the storage mutex is blocked.
    let note_window = match build_note_window(app, &record) {
        Ok(window) => window,
        Err(error) => {
            manager.remove_session(&id);
            return Err(error);
        }
    };
    let event_app = app.clone();
    let event_id = id.clone();
    let label = note_window.label().to_string();
    let event_manager = manager.clone();
    note_window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(window) = event_app.get_webview_window(&label) {
                let _ = window.emit("sticky-note-close-request", ());
            }
        }
        tauri::WindowEvent::Destroyed => {
            event_manager.remove_session(&event_id);
            emit_changed(&event_app, &event_id);
        }
        _ => {}
    });
    if let Ok(mut inner) = manager.0.lock() {
        inner.sessions.insert(id.clone(), Session::Open);
    }
    if let Err(error) = note_window.show().and_then(|_| note_window.set_focus()) {
        let _ = note_window.destroy();
        manager.remove_session(&id);
        return Err(format!("无法显示便签: {error}"));
    }
    emit_changed(app, &id);
    Ok(())
}

#[tauri::command]
pub(crate) async fn close_sticky_note(window: WebviewWindow, id: String) -> Result<(), String> {
    let _work = super::launch::keep_native_work(window.app_handle());
    authorize_note(&window, &id, true)?;
    let app = window.app_handle();
    if is_manager(window.label()) {
        if let Some(note_window) = app.get_webview_window(&format!("{LABEL_PREFIX}{id}")) {
            note_window
                .emit("sticky-note-close-request", ())
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let geometry = (!window.is_minimized().unwrap_or(false) && size.width > 0 && size.height > 0)
        .then_some(Geometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        });
    let note_id = id.clone();
    io(app, move |manager, path| {
        let mut inner = manager.0.lock().map_err(|_| "便签状态不可用")?;
        ensure_loaded(&mut inner, &path)?;
        let mut store = inner.cache.as_ref().expect("loaded").1.clone();
        let record = store
            .notes
            .iter_mut()
            .find(|record| record.note.id == note_id)
            .ok_or("便签不存在")?;
        if geometry.is_some() && record.geometry != geometry {
            record.geometry = geometry;
            write_store(&path, &store)?;
            inner.cache = Some((path, store));
        }
        inner.sessions.insert(note_id, Session::Closing);
        Ok(())
    })
    .await?;
    if let Err(error) = window.destroy() {
        if let Ok(mut inner) = app.state::<StickyNoteManager>().0.lock() {
            inner.sessions.insert(id, Session::Open);
        }
        return Err(format!("无法关闭便签: {error}"));
    }
    // Destroyed removes the reservation; do not remove early and permit a
    // second WebView with the same label before native destruction completes.
    Ok(())
}

#[derive(Clone, Copy)]
enum ArchiveAction {
    Trash,
    Restore,
    Delete,
}

fn archive_note(
    manager: &StickyNoteManager,
    path: &Path,
    id: &str,
    action: ArchiveAction,
) -> Result<(), String> {
    validate_id(id)?;
    manager.mutate(path, |store, inner| {
        if inner.sessions.contains_key(id) {
            return Err("请先关闭这张便签，确保编辑内容已保存".into());
        }
        let index = store
            .notes
            .iter()
            .position(|record| record.note.id == id)
            .ok_or("便签不存在")?;
        let note = &mut store.notes[index].note;
        if matches!(action, ArchiveAction::Delete) {
            if note.trashed_at.is_none() {
                return Err("只能永久删除回收站中的便签".into());
            }
            store.notes.remove(index);
        } else {
            let trash = matches!(action, ArchiveAction::Trash);
            if trash == note.trashed_at.is_some() {
                return Ok(());
            }
            if note.revision >= MAX_REVISION {
                return Err("便签版本已达上限".into());
            }
            note.updated_at = Utc::now().timestamp_millis().max(note.updated_at);
            note.trashed_at = if trash { Some(note.updated_at) } else { None };
            note.revision += 1;
        }
        Ok(())
    })
}

async fn archive(window: WebviewWindow, id: String, action: ArchiveAction) -> Result<(), String> {
    authorize_manager(&window)?;
    let note_id = id.clone();
    io(window.app_handle(), move |manager, path| {
        archive_note(&manager, &path, &note_id, action)
    })
    .await?;
    emit_changed(window.app_handle(), &id);
    Ok(())
}

#[tauri::command]
pub(crate) async fn trash_sticky_note(window: WebviewWindow, id: String) -> Result<(), String> {
    archive(window, id, ArchiveAction::Trash).await
}

#[tauri::command]
pub(crate) async fn restore_sticky_note(window: WebviewWindow, id: String) -> Result<(), String> {
    archive(window, id, ArchiveAction::Restore).await
}

#[tauri::command]
pub(crate) async fn delete_sticky_note(window: WebviewWindow, id: String) -> Result<(), String> {
    archive(window, id, ArchiveAction::Delete).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("dtkit-sticky-test-{}", Uuid::new_v4())))
        }
        fn path(&self) -> PathBuf {
            self.0.join("notes.json")
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn draft(note: &StickyNote, content: &str) -> StickyNoteDraft {
        StickyNoteDraft {
            id: note.note.id.clone(),
            title: "计划".into(),
            content: content.into(),
            color: "green".into(),
            pinned: false,
            revision: note.note.revision,
        }
    }

    #[test]
    fn round_trip_revision_and_conflicting_save() {
        let dir = TestDir::new();
        let manager = StickyNoteManager::default();
        let created = create_note(&manager, &dir.path()).unwrap();
        let saved = save_note(&manager, &dir.path(), draft(&created, "第一行\n第二行 📝")).unwrap();
        assert_eq!(saved.note.revision, 2);
        assert!(save_note(&manager, &dir.path(), draft(&created, "stale")).is_err());
        manager.invalidate();
        manager
            .read(&dir.path(), |store, _| {
                assert_eq!(store.notes[0].note.content, "第一行\n第二行 📝");
                assert!(!store.notes[0].note.pinned);
                Ok(())
            })
            .unwrap();
        assert!(dir.path().with_extension("json.bak").is_file());
    }

    #[test]
    fn missing_primary_recovers_backup_but_corruption_is_not_overwritten() {
        let dir = TestDir::new();
        let manager = StickyNoteManager::default();
        let created = create_note(&manager, &dir.path()).unwrap();
        save_note(&manager, &dir.path(), draft(&created, "next revision")).unwrap();
        fs::remove_file(dir.path()).unwrap();
        manager.invalidate();
        manager
            .read(&dir.path(), |store, _| {
                assert_eq!(store.notes[0].note.revision, 1);
                Ok(())
            })
            .unwrap();
        fs::write(dir.path(), b"damaged").unwrap();
        manager.invalidate();
        assert!(create_note(&manager, &dir.path()).is_err());
        assert_eq!(fs::read(dir.path()).unwrap(), b"damaged");
    }

    #[test]
    fn cache_tracks_root_and_failed_write_does_not_replace_cache() {
        let first = TestDir::new();
        let second = TestDir::new();
        let manager = StickyNoteManager::default();
        let note = create_note(&manager, &first.path()).unwrap();
        manager
            .read(&second.path(), |store, _| {
                assert!(store.notes.is_empty());
                Ok(())
            })
            .unwrap();
        manager
            .read(&first.path(), |store, _| {
                assert_eq!(store.notes[0].note.id, note.note.id);
                Ok(())
            })
            .unwrap();
        fs::create_dir(first.path().with_extension("json.tmp")).unwrap();
        assert!(save_note(&manager, &first.path(), draft(&note, "must not commit")).is_err());
        manager
            .read(&first.path(), |store, _| {
                assert!(store.notes[0].note.content.is_empty());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn concurrent_creates_are_serialized_without_lost_notes() {
        let dir = TestDir::new();
        let manager = StickyNoteManager::default();
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let path = dir.path();
                let manager = manager.clone();
                std::thread::spawn(move || create_note(&manager, &path).unwrap())
            })
            .collect();
        let ids: HashSet<_> = threads
            .into_iter()
            .map(|t| t.join().unwrap().note.id)
            .collect();
        assert_eq!(ids.len(), 12);
        assert_eq!(read_store(&dir.path()).unwrap().notes.len(), 12);
    }

    #[test]
    fn concurrent_saves_cannot_overwrite_the_same_revision() {
        let dir = TestDir::new();
        let manager = StickyNoteManager::default();
        let note = create_note(&manager, &dir.path()).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|content| {
                let manager = manager.clone();
                let path = dir.path();
                let barrier = barrier.clone();
                let draft = draft(&note, content);
                std::thread::spawn(move || {
                    barrier.wait();
                    save_note(&manager, &path, draft)
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(read_store(&dir.path()).unwrap().notes[0].note.revision, 2);
    }

    #[test]
    fn note_windows_cannot_access_other_notes_or_management() {
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        let label = format!("{LABEL_PREFIX}{first}");
        assert!(authorize_note_label(&label, &first, false).is_ok());
        assert!(authorize_note_label(&label, &second, true).is_err());
        assert!(!is_manager(&label));
        assert!(authorize_note_label("main", &first, true).is_ok());
        assert!(authorize_note_label("main", &first, false).is_err());
        assert!(authorize_note_label("quick-host-1", &first, true).is_ok());
        assert!(authorize_note_label("capture-overlay", &first, true).is_err());
    }

    #[test]
    fn permanent_delete_reclaims_capacity() {
        let dir = TestDir::new();
        let manager = StickyNoteManager::default();
        let first = create_note(&manager, &dir.path()).unwrap();
        manager
            .mutate(&dir.path(), |store, _| {
                let template = store.notes[0].clone();
                for _ in 1..MAX_NOTES {
                    let mut record = template.clone();
                    record.note.id = Uuid::new_v4().to_string();
                    store.notes.push(record);
                }
                Ok(())
            })
            .unwrap();
        assert!(create_note(&manager, &dir.path()).is_err());
        archive_note(&manager, &dir.path(), &first.note.id, ArchiveAction::Trash).unwrap();
        assert!(create_note(&manager, &dir.path()).is_err());
        archive_note(&manager, &dir.path(), &first.note.id, ArchiveAction::Delete).unwrap();
        assert!(create_note(&manager, &dir.path()).is_ok());
    }

    #[test]
    fn archive_refuses_open_notes_and_delete_requires_trash() {
        let dir = TestDir::new();
        let manager = StickyNoteManager::default();
        let note = create_note(&manager, &dir.path()).unwrap();
        let id = note.note.id;
        assert!(archive_note(&manager, &dir.path(), &id, ArchiveAction::Delete).is_err());
        reserve_open(&manager, &dir.path(), &id).unwrap();
        assert!(manager.has_open_notes());
        assert!(archive_note(&manager, &dir.path(), &id, ArchiveAction::Trash).is_err());
        assert!(reserve_open(&manager, &dir.path(), &id).is_err());
        manager.remove_session(&id);
        archive_note(&manager, &dir.path(), &id, ArchiveAction::Trash).unwrap();
        assert!(reserve_open(&manager, &dir.path(), &id).is_err());
        archive_note(&manager, &dir.path(), &id, ArchiveAction::Restore).unwrap();
        archive_note(&manager, &dir.path(), &id, ArchiveAction::Trash).unwrap();
        archive_note(&manager, &dir.path(), &id, ArchiveAction::Delete).unwrap();
        assert!(read_store(&dir.path()).unwrap().notes.is_empty());
    }

    #[test]
    fn limits_validate_before_mutating_and_cap_windows() {
        assert!(validate_id("../notes").is_err());
        assert!(validate_fields("", "", "red", 1).is_err());
        assert!(validate_fields("", "", "yellow", 0).is_err());
        assert!(validate_fields(&"a".repeat(81), "", "yellow", 1).is_err());
        assert!(validate_fields("", &"a".repeat(20_001), "yellow", 1).is_err());
        assert!(validate_fields("", &"📝".repeat(10_001), "yellow", 1).is_err());
        let dir = TestDir::new();
        let manager = StickyNoteManager::default();
        for _ in 0..MAX_WINDOWS {
            let note = create_note(&manager, &dir.path()).unwrap();
            reserve_open(&manager, &dir.path(), &note.note.id).unwrap();
        }
        let extra = create_note(&manager, &dir.path()).unwrap();
        assert!(reserve_open(&manager, &dir.path(), &extra.note.id).is_err());
    }

    #[test]
    fn offscreen_and_hidpi_geometry_stays_reachable() {
        let areas = [
            (
                Geometry {
                    x: -1920,
                    y: 0,
                    width: 1920,
                    height: 1040,
                },
                1.0,
            ),
            (
                Geometry {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1040,
                },
                1.5,
            ),
        ];
        let result = clamp_geometry(
            Geometry {
                x: 4000,
                y: 2000,
                width: 100,
                height: 100,
            },
            &areas,
        )
        .unwrap();
        assert_eq!(
            result,
            Geometry {
                x: 1545,
                y: 680,
                width: 375,
                height: 360
            }
        );
        let left = clamp_geometry(
            Geometry {
                x: -1900,
                y: 10,
                width: 400,
                height: 400,
            },
            &areas,
        )
        .unwrap();
        assert_eq!(left.x, -1900);
        assert!(clamp_geometry(left, &[]).is_none());
    }
}
