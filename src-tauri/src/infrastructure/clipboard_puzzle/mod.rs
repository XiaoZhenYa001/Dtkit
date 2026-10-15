mod clipboard;
mod images;
mod repository;

use base64::Engine;
use repository::{Operation, Repository, Task};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub(crate) const EVENT: &str = "clipboard-puzzle-changed";
pub(crate) const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_PIXELS: u64 = 40_000_000;

#[derive(Default)]
pub(crate) struct PuzzleManager {
    repository: Mutex<Repository>,
    collection: Arc<Mutex<Collection>>,
    listener: Mutex<Option<clipboard::Listener>>,
    listener_window: Arc<AtomicUsize>,
    collection_control: Mutex<()>,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Collection {
    task_id: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Overview {
    tasks: Vec<repository::TaskMeta>,
    collection: Collection,
    retention_hours: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyRequest {
    source_task_id: String,
    target_task_id: String,
    source_revision: u64,
    ids: Vec<String>,
    x: f64,
    y: f64,
}

impl PuzzleManager {
    fn repository<'a>(
        &'a self,
        app: &AppHandle,
    ) -> Result<std::sync::MutexGuard<'a, Repository>, String> {
        let mut repo = self.repository.lock().map_err(|_| "拼图存储状态不可用")?;
        let collecting = self
            .collection
            .lock()
            .map_err(|_| "收集状态不可用")?
            .task_id
            .clone();
        repo.initialize_protected(
            app.state::<super::storage::StorageManager>()
                .layout()?
                .kits
                .join("ClipboardPuzzles"),
            collecting.as_deref(),
        )?;
        Ok(repo)
    }

    pub(crate) fn has_active_collection(&self) -> bool {
        self.collection
            .lock()
            .map(|c| c.task_id.is_some())
            .unwrap_or(true)
    }

    pub(crate) fn release_window(&self, label: &str) {
        if let Ok(mut repo) = self.repository.lock() {
            repo.release_window(label);
        }
    }
    pub(crate) fn migration_guard(&self) -> Result<std::sync::MutexGuard<'_, Repository>, String> {
        self.repository
            .lock()
            .map_err(|_| "拼图存储状态不可用".into())
    }

    pub(crate) fn stop(&self) {
        let Ok(_control) = self.collection_control.lock() else {
            return;
        };
        self.stop_locked();
    }
    fn stop_locked(&self) {
        if let Ok(mut c) = self.collection.lock() {
            c.task_id = None;
        }
        if let Ok(mut listener) = self.listener.lock() {
            if let Some(listener) = listener.take() {
                listener.stop();
            }
        }
    }
}

fn owner(window: &WebviewWindow, instance_id: Option<&str>) -> Result<String, String> {
    let id = instance_id.unwrap_or(window.label());
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err("拼图页面标识无效".into());
    }
    Ok(format!("{}::{id}", window.label()))
}

fn notify(app: &AppHandle, task: Option<&Task>) {
    let _ = app.emit(EVENT, serde_json::json!({"taskId":task.map(|t| &t.meta.id),"revision":task.map(|t| t.meta.revision)}));
}
pub(crate) fn module_stopped(app: &AppHandle) {
    notify(app, None);
}
async fn work<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let guard = super::launch::keep_native_work(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        action(&app)
    })
    .await
    .map_err(|e| format!("拼图任务异常：{e}"))?
}

#[tauri::command]
pub(crate) async fn puzzle_overview(app: AppHandle) -> Result<Overview, String> {
    work(app, |app| {
        let manager = app.state::<PuzzleManager>();
        let mut repo = manager.repository(&app)?;
        let collecting = manager
            .collection
            .lock()
            .map_err(|_| "收集状态不可用")?
            .clone();
        repo.cleanup(collecting.task_id.as_deref())?;
        Ok(Overview {
            tasks: repo.list(),
            collection: collecting,
            retention_hours: repo.retention_hours(),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_open(
    app: AppHandle,
    window: WebviewWindow,
    task_id: Option<String>,
    instance_id: Option<String>,
    current_collection: Option<bool>,
) -> Result<Task, String> {
    let owner = owner(&window, instance_id.as_deref())?;
    work(app, move |app| {
        let manager = app.state::<PuzzleManager>();
        let collecting = if current_collection.unwrap_or(false) {
            manager
                .collection
                .lock()
                .map_err(|_| "收集状态不可用")?
                .task_id
                .clone()
        } else {
            None
        };
        let mut repo = manager.repository(&app)?;
        let task = repo.open(
            &owner,
            task_id.as_deref().or(collecting.as_deref()),
            current_collection.unwrap_or(false),
        )?;
        Ok(task)
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_close(
    app: AppHandle,
    window: WebviewWindow,
    instance_id: Option<String>,
) -> Result<(), String> {
    let owner = owner(&window, instance_id.as_deref())?;
    work(app, move |app| {
        let manager = app.state::<PuzzleManager>();
        manager
            .repository
            .lock()
            .map_err(|_| "拼图存储状态不可用")?
            .release(&owner);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_get(app: AppHandle, task_id: String) -> Result<Task, String> {
    work(app, move |app| {
        app.state::<PuzzleManager>().repository(app)?.load(&task_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_edit(
    app: AppHandle,
    task_id: String,
    operations: Vec<Operation>,
) -> Result<Task, String> {
    work(app, move |app| {
        let manager = app.state::<PuzzleManager>();
        let task = manager.repository(&app)?.edit(&task_id, operations)?;
        notify(&app, Some(&task));
        Ok(task)
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_copy(app: AppHandle, request: CopyRequest) -> Result<Task, String> {
    work(app, move |app| {
        let manager = app.state::<PuzzleManager>();
        let task = manager.repository(&app)?.copy(request)?;
        notify(&app, Some(&task));
        Ok(task)
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_remove(app: AppHandle, task_id: String) -> Result<(), String> {
    work(app, move |app| {
        let manager = app.state::<PuzzleManager>();
        let _control = manager
            .collection_control
            .lock()
            .map_err(|_| "收集状态不可用")?;
        let collecting = manager
            .collection
            .lock()
            .map_err(|_| "收集状态不可用")?
            .task_id
            .as_deref()
            == Some(&task_id);
        if collecting {
            manager.stop_locked();
        }
        manager.repository(&app)?.remove(&task_id)?;
        notify(&app, None);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_retention(app: AppHandle, hours: u64) -> Result<(), String> {
    work(app, move |app| {
        app.state::<PuzzleManager>()
            .repository(app)?
            .set_retention(hours)?;
        notify(&app, None);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_collect(
    app: AppHandle,
    task_id: Option<String>,
) -> Result<Collection, String> {
    let result = work(app.clone(), move |app| {
        let manager = app.state::<PuzzleManager>();
        let _control = manager
            .collection_control
            .lock()
            .map_err(|_| "收集状态不可用")?;
        manager.stop_locked();
        if let Some(id) = task_id {
            if !app
                .state::<super::tool_modules::ToolModuleManager>()
                .is_enabled("clipboard-puzzle")
            {
                return Err("剪贴板拼图模块已停用".into());
            }
            manager.repository(&app)?.load(&id)?;
            *manager.collection.lock().map_err(|_| "收集状态不可用")? = Collection {
                task_id: Some(id),
                error: None,
            };
            match clipboard::Listener::start(app.clone(), manager.listener_window.clone()) {
                Ok(listener) => {
                    *manager.listener.lock().map_err(|_| "收集状态不可用")? = Some(listener)
                }
                Err(error) => {
                    *manager.collection.lock().map_err(|_| "收集状态不可用")? = Collection {
                        task_id: None,
                        error: Some(error.clone()),
                    };
                    notify(&app, None);
                    return Err(error);
                }
            }
        }
        let result = manager
            .collection
            .lock()
            .map_err(|_| "收集状态不可用")?
            .clone();
        notify(&app, None);
        Ok(result)
    })
    .await?;
    super::launch::finish_tool_only_if_idle(app.clone()).await;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn puzzle_take_clipboard(app: AppHandle, task_id: String) -> Result<Task, String> {
    work(app, move |app| {
        let captured = clipboard::read(false)?;
        append_capture(app, &task_id, captured)
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_import_content(
    app: AppHandle,
    task_id: String,
    text: String,
    html: String,
    x: f64,
    y: f64,
) -> Result<Task, String> {
    work(app, move |app| {
        if !x.is_finite() || !y.is_finite() {
            return Err("插入位置无效".into());
        }
        let capture = clipboard::Capture::from_content(text, html)?;
        let images = capture.prepare_images();
        let manager = app.state::<PuzzleManager>();
        let mut repo = manager.repository(app)?;
        let mut nodes = capture.nodes(&mut repo, images)?;
        let min_x = nodes.iter().map(|n| n.x).fold(f64::INFINITY, f64::min);
        let min_y = nodes.iter().map(|n| n.y).fold(f64::INFINITY, f64::min);
        for node in &mut nodes {
            node.x += x - min_x;
            node.y += y - min_y;
        }
        let task = repo.edit(&task_id, vec![Operation::Upsert { nodes }])?;
        drop(repo);
        notify(app, Some(&task));
        Ok(task)
    })
    .await
}

fn append_capture(
    app: &AppHandle,
    task_id: &str,
    capture: clipboard::Capture,
) -> Result<Task, String> {
    let images = capture.prepare_images();
    let manager = app.state::<PuzzleManager>();
    let mut repo = manager.repository(app)?;
    let nodes = capture.nodes(&mut repo, images)?;
    let task = repo.append(task_id, nodes)?;
    drop(repo);
    notify(app, Some(&task));
    Ok(task)
}

pub(crate) fn capture_changed(app: &AppHandle, capture: clipboard::Capture, target: &str) {
    if let Err(error) = append_capture(app, target, capture) {
        let manager = app.state::<PuzzleManager>();
        if let Ok(mut state) = manager.collection.lock() {
            state.task_id = None;
            state.error = Some(error);
        }
        clipboard::request_stop(&manager.listener_window);
        notify(app, None);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetResult {
    asset_id: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub(crate) async fn puzzle_import_image(
    app: AppHandle,
    data_url: String,
) -> Result<AssetResult, String> {
    let _work = super::launch::keep_native_work(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_png(&data_url)?;
        app.state::<PuzzleManager>()
            .repository(&app)?
            .store_png(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn decode_png(url: &str) -> Result<Vec<u8>, String> {
    let encoded = url
        .strip_prefix("data:image/png;base64,")
        .ok_or("请使用 PNG 图片数据")?;
    if encoded.len() > MAX_IMAGE_BYTES * 4 / 3 + 8 {
        return Err("单张图片不能超过 32 MB".into());
    }
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "图片数据无法解码".into())
}

#[tauri::command]
pub(crate) async fn puzzle_asset(
    app: AppHandle,
    asset_id: String,
    preview: bool,
) -> Result<String, String> {
    work(app, move |app| {
        let manager = app.state::<PuzzleManager>();
        let bytes = manager.repository(&app)?.asset(&asset_id, preview)?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
}

#[tauri::command]
pub(crate) async fn puzzle_output(
    app: AppHandle,
    data_url: String,
    copy: bool,
    name: String,
    task_id: String,
) -> Result<Option<String>, String> {
    let _work = super::launch::keep_native_work(&app);
    let output_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let bytes = decode_png(&data_url)?;
        if copy {
            clipboard::write_png(&bytes)?;
            Ok(None)
        } else {
            repository::validate_png(&bytes)?;
            let layout = output_app
                .state::<super::storage::StorageManager>()
                .layout()?;
            let clean = name
                .chars()
                .filter(|c| !r#"<>:"/\|?*"#.contains(*c) && !c.is_control())
                .take(60)
                .collect::<String>();
            let path = layout.downloads.join(format!(
                "{}-{}.png",
                if clean.is_empty() { "拼图" } else { &clean },
                chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f")
            ));
            repository::atomic_write(&path, &bytes)?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    if copy {
        work(app.clone(), move |app| {
            let manager = app.state::<PuzzleManager>();
            let _control = manager
                .collection_control
                .lock()
                .map_err(|_| "收集状态不可用")?;
            let collecting = manager
                .collection
                .lock()
                .map_err(|_| "收集状态不可用")?
                .task_id
                .as_deref()
                == Some(&task_id);
            if collecting {
                manager.stop_locked();
                notify(&app, None);
            }
            Ok(())
        })
        .await?;
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn puzzle_copy_text(app: AppHandle, text: String) -> Result<(), String> {
    work(app, move |_| clipboard::write_text(&text)).await
}

#[tauri::command]
pub(crate) async fn puzzle_open_url(app: AppHandle, url: String) -> Result<(), String> {
    if url.len() > 8192
        || !(url.starts_with("https://") || url.starts_with("http://"))
        || url.chars().any(char::is_control)
    {
        return Err("仅支持打开有效的 HTTP 或 HTTPS 链接".into());
    }
    work(app, move |_| {
        opener::open(url).map_err(|e| format!("打开链接失败：{e}"))
    })
    .await
}
