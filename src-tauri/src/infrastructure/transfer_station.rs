use super::storage::StorageManager;
use crate::path_safety::validate_leaf_filename;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

const MAX_STATION_ITEMS: usize = 100;
const MAX_IMPORT_FILES: usize = 50;
const MIN_TTL_SECONDS: u64 = 60 * 60;
const MAX_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;

#[cfg(windows)]
fn is_link_like(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_like(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferItem {
    id: String,
    name: String,
    size: u64,
    created_at: i64,
    expires_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportTransferRequest {
    sources: Vec<String>,
    ttl_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportTransferResult {
    imported: Vec<TransferItem>,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveTransferResult {
    permanent: bool,
    recovery_batch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreTransferResult {
    batch_id: String,
    restored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanShareInfo {
    share_id: String,
    item_id: String,
    item_name: String,
    url: String,
    expires_at: i64,
}

struct ActiveLanShare {
    info: LanShareInfo,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub(crate) struct TransferStationManager {
    active_share: Arc<Mutex<Option<ActiveLanShare>>>,
}

impl TransferStationManager {
    pub(crate) async fn has_active_share(&self) -> bool {
        self.active_share.lock().await.is_some()
    }

    async fn current_share(&self) -> Option<LanShareInfo> {
        self.active_share
            .lock()
            .await
            .as_ref()
            .map(|share| share.info.clone())
    }

    async fn stop_share(&self) -> Option<LanShareInfo> {
        let mut active = self.active_share.lock().await;
        let mut share = active.take()?;
        if let Some(cancel) = share.cancel.take() {
            let _ = cancel.send(());
        }
        Some(share.info)
    }
}

fn items_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .state::<StorageManager>()
        .layout()?
        .temp_transfer
        .join("items");
    fs::create_dir_all(&root).map_err(|error| format!("创建中转目录失败: {error}"))?;
    Ok(root)
}

fn safe_id(value: &str) -> bool {
    value.len() == 36
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

fn safe_batch_id(value: &str) -> bool {
    value.starts_with("transfer-")
        && value.len() <= 80
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn item_directory(root: &Path, item_id: &str) -> Result<PathBuf, String> {
    if !safe_id(item_id) {
        return Err("中转条目标识无效".to_string());
    }
    Ok(root.join(item_id))
}

fn metadata_path(directory: &Path) -> PathBuf {
    directory.join("meta.json")
}

fn data_path(directory: &Path) -> PathBuf {
    directory.join("data")
}

fn read_item(directory: &Path) -> Result<TransferItem, String> {
    let metadata =
        fs::symlink_metadata(directory).map_err(|error| format!("读取中转条目失败: {error}"))?;
    if !metadata.is_dir() || is_link_like(&metadata) {
        return Err("拒绝读取链接形式的中转条目".to_string());
    }
    let item: TransferItem = serde_json::from_slice(
        &fs::read(metadata_path(directory))
            .map_err(|error| format!("读取中转元数据失败: {error}"))?,
    )
    .map_err(|error| format!("中转元数据无效: {error}"))?;
    if !safe_id(&item.id) || validate_leaf_filename(&item.name).is_err() {
        return Err("中转元数据包含不安全字段".to_string());
    }
    let data_metadata = fs::symlink_metadata(data_path(directory))
        .map_err(|error| format!("读取中转文件失败: {error}"))?;
    if !data_metadata.is_file() || is_link_like(&data_metadata) || data_metadata.len() != item.size
    {
        return Err("中转文件与元数据不匹配".to_string());
    }
    Ok(item)
}

fn write_item(directory: &Path, item: &TransferItem) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(item).map_err(|error| error.to_string())?;
    let temporary = directory.join("meta.json.tmp");
    fs::write(&temporary, serialized).map_err(|error| format!("写入中转元数据失败: {error}"))?;
    fs::rename(&temporary, metadata_path(directory))
        .map_err(|error| format!("提交中转元数据失败: {error}"))
}

fn list_items_in(root: &Path) -> Result<Vec<TransferItem>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = fs::read_dir(root)
        .map_err(|error| format!("读取中转目录失败: {error}"))?
        .flatten()
        .filter_map(|entry| read_item(&entry.path()).ok())
        .collect::<Vec<_>>();
    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(items)
}

fn copy_file_create_new(source: &Path, target: &Path) -> Result<u64, String> {
    let mut input = fs::File::open(source).map_err(|error| format!("打开源文件失败: {error}"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("创建目标文件失败: {error}"))?;
    io::copy(&mut input, &mut output).map_err(|error| format!("复制文件失败: {error}"))
}

fn move_item_to_recovery(app: &AppHandle, item_id: &str, prefix: &str) -> Result<String, String> {
    let root = items_root(app)?;
    let source = item_directory(&root, item_id)?;
    read_item(&source)?;
    let batch_id = format!("transfer-{prefix}-{}", uuid::Uuid::new_v4());
    let recovery = app
        .state::<StorageManager>()
        .layout()?
        .recovery
        .join(&batch_id);
    fs::create_dir_all(&recovery).map_err(|error| format!("创建恢复目录失败: {error}"))?;
    fs::write(recovery.join("item-id.txt"), item_id)
        .map_err(|error| format!("写入恢复标识失败: {error}"))?;
    fs::rename(&source, recovery.join(item_id))
        .map_err(|error| format!("移动到恢复区失败: {error}"))?;
    Ok(batch_id)
}

fn expire_items(app: &AppHandle) -> Result<usize, String> {
    let root = items_root(app)?;
    let now = Utc::now().timestamp_millis();
    let expired = list_items_in(&root)?
        .into_iter()
        .filter(|item| item.expires_at <= now)
        .map(|item| item.id)
        .collect::<Vec<_>>();
    let mut moved = 0;
    for item_id in expired {
        if move_item_to_recovery(app, &item_id, "expired").is_ok() {
            moved += 1;
        }
    }
    Ok(moved)
}

fn import_files(
    app: &AppHandle,
    request: ImportTransferRequest,
) -> Result<ImportTransferResult, String> {
    if request.sources.is_empty() || request.sources.len() > MAX_IMPORT_FILES {
        return Err(format!("一次请选择 1 到 {MAX_IMPORT_FILES} 个文件"));
    }
    if !(MIN_TTL_SECONDS..=MAX_TTL_SECONDS).contains(&request.ttl_seconds) {
        return Err("保存时间必须在 1 小时到 30 天之间".to_string());
    }
    expire_items(app)?;
    let root = items_root(app)?;
    if list_items_in(&root)?
        .len()
        .saturating_add(request.sources.len())
        > MAX_STATION_ITEMS
    {
        return Err(format!("中转站最多保存 {MAX_STATION_ITEMS} 个文件"));
    }
    let now = Utc::now().timestamp_millis();
    let expires_at = now.saturating_add((request.ttl_seconds as i64).saturating_mul(1_000));
    let mut validated = Vec::new();
    for raw in request.sources {
        let raw_metadata = fs::symlink_metadata(&raw).map_err(|_| format!("文件不存在: {raw}"))?;
        if !raw_metadata.is_file() || is_link_like(&raw_metadata) {
            return Err(format!("不能导入链接或非文件路径: {raw}"));
        }
        let source = fs::canonicalize(&raw).map_err(|_| format!("文件不存在: {raw}"))?;
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "文件名不是有效文本".to_string())?
            .to_string();
        validate_leaf_filename(&name)?;
        validated.push((source, name));
    }

    let mut imported: Vec<TransferItem> = Vec::new();
    let mut total_bytes = 0u64;
    for (source, name) in validated {
        let id = uuid::Uuid::new_v4().to_string();
        let directory = root.join(&id);
        let create_result = (|| {
            fs::create_dir(&directory).map_err(|error| format!("创建中转条目失败: {error}"))?;
            let copied = copy_file_create_new(&source, &data_path(&directory))?;
            let item = TransferItem {
                id,
                name,
                size: copied,
                created_at: now,
                expires_at,
            };
            write_item(&directory, &item)?;
            Ok::<_, String>(item)
        })();
        let item = match create_result {
            Ok(item) => item,
            Err(error) => {
                let _ = fs::remove_dir_all(&directory);
                for previous in &imported {
                    let _ = fs::remove_dir_all(root.join(&previous.id));
                }
                return Err(error);
            }
        };
        total_bytes = total_bytes.saturating_add(item.size);
        imported.push(item);
    }
    Ok(ImportTransferResult {
        imported,
        total_bytes,
    })
}

fn resolve_item(app: &AppHandle, item_id: &str) -> Result<(TransferItem, PathBuf), String> {
    let directory = item_directory(&items_root(app)?, item_id)?;
    let item = read_item(&directory)?;
    if item.id != item_id {
        return Err("中转条目标识不匹配".to_string());
    }
    Ok((item, data_path(&directory)))
}

fn export_item(app: &AppHandle, item_id: &str, destination: &str) -> Result<PathBuf, String> {
    let raw_metadata =
        fs::symlink_metadata(destination).map_err(|_| "目标文件夹不存在".to_string())?;
    if !raw_metadata.is_dir() || is_link_like(&raw_metadata) {
        return Err("目标文件夹不能是符号链接或目录联接".to_string());
    }
    let destination = fs::canonicalize(destination).map_err(|_| "目标文件夹不存在".to_string())?;
    let (item, source) = resolve_item(app, item_id)?;
    let target = destination.join(&item.name);
    if target.exists() {
        return Err("目标文件已存在，DtKit 不会覆盖".to_string());
    }
    copy_file_create_new(&source, &target)?;
    Ok(target)
}

fn is_safe_to_open(name: &str) -> bool {
    !matches!(
        Path::new(name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "exe" | "com" | "bat" | "cmd" | "ps1" | "msi" | "scr" | "lnk" | "url"
    )
}

#[tauri::command]
pub(crate) async fn list_transfer_items(app: AppHandle) -> Result<Vec<TransferItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        expire_items(&app)?;
        list_items_in(&items_root(&app)?)
    })
    .await
    .map_err(|error| format!("读取中转站失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn import_transfer_files(
    app: AppHandle,
    request: ImportTransferRequest,
) -> Result<ImportTransferResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_files(&app, request))
        .await
        .map_err(|error| format!("导入任务失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn export_transfer_item(
    app: AppHandle,
    item_id: String,
    destination: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_item(&app, &item_id, &destination))
        .await
        .map_err(|error| format!("导出任务失败: {error}"))?
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn open_transfer_item(app: AppHandle, item_id: String) -> Result<(), String> {
    let (item, path) = tauri::async_runtime::spawn_blocking(move || resolve_item(&app, &item_id))
        .await
        .map_err(|error| format!("读取中转条目失败: {error}"))??;
    if !is_safe_to_open(&item.name) {
        return Err("为避免意外执行程序，中转站不能直接打开可执行文件或脚本".to_string());
    }
    opener::open(path).map_err(|error| format!("打开文件失败: {error}"))
}

#[tauri::command]
pub(crate) async fn remove_transfer_item(
    app: AppHandle,
    manager: tauri::State<'_, TransferStationManager>,
    item_id: String,
    permanent: bool,
) -> Result<RemoveTransferResult, String> {
    if manager
        .current_share()
        .await
        .is_some_and(|share| share.item_id == item_id)
    {
        manager.stop_share().await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let directory = item_directory(&items_root(&app)?, &item_id)?;
        read_item(&directory)?;
        if permanent {
            fs::remove_dir_all(directory).map_err(|error| format!("彻底删除失败: {error}"))?;
            Ok(RemoveTransferResult {
                permanent: true,
                recovery_batch_id: None,
            })
        } else {
            let batch_id = move_item_to_recovery(&app, &item_id, "removed")?;
            Ok(RemoveTransferResult {
                permanent: false,
                recovery_batch_id: Some(batch_id),
            })
        }
    })
    .await
    .map_err(|error| format!("移除任务失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn restore_transfer_item(
    app: AppHandle,
    batch_id: String,
) -> Result<RestoreTransferResult, String> {
    if !safe_batch_id(&batch_id) {
        return Err("恢复批次标识无效".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let layout = app.state::<StorageManager>().layout()?;
        let batch = layout.recovery.join(&batch_id);
        let batch_metadata =
            fs::symlink_metadata(&batch).map_err(|_| "恢复批次不存在".to_string())?;
        if !batch_metadata.is_dir() || is_link_like(&batch_metadata) {
            return Err("恢复批次不是安全目录".to_string());
        }
        let item_id = fs::read_to_string(batch.join("item-id.txt"))
            .map_err(|_| "恢复批次缺少条目标识".to_string())?;
        let item_id = item_id.trim();
        let source = item_directory(&batch, item_id)?;
        read_item(&source)?;
        let target = item_directory(&items_root(&app)?, item_id)?;
        if target.exists() {
            return Err("中转站中已存在同一条目".to_string());
        }
        fs::rename(source, target).map_err(|error| format!("恢复中转文件失败: {error}"))?;
        let _ = fs::remove_dir_all(&batch);
        Ok(RestoreTransferResult {
            batch_id,
            restored: true,
        })
    })
    .await
    .map_err(|error| format!("恢复任务失败: {error}"))?
}

fn local_ipv4() -> Result<Ipv4Addr, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("检测局域网地址失败: {error}"))?;
    socket
        .connect((Ipv4Addr::new(192, 0, 2, 1), 80))
        .map_err(|error| format!("检测局域网地址失败: {error}"))?;
    match socket.local_addr().map(|address| address.ip()) {
        Ok(IpAddr::V4(address)) if !address.is_loopback() => Ok(address),
        _ => Err("未检测到可用的局域网 IPv4 地址".to_string()),
    }
}

fn ascii_download_name(name: &str) -> String {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            value
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        })
        .unwrap_or("bin");
    format!("dtkit-transfer.{extension}")
}

async fn write_http_error(stream: &mut TcpStream, status: &str) {
    let body = status.as_bytes();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

async fn serve_download(
    mut stream: TcpStream,
    token: &str,
    path: &Path,
    item: &TransferItem,
) -> bool {
    let mut request = [0u8; 8192];
    let read = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut request)).await {
        Ok(Ok(read)) if read > 0 => read,
        _ => return false,
    };
    let first_line = String::from_utf8_lossy(&request[..read])
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let expected = format!("GET /download?token={token} HTTP/");
    if !first_line.starts_with(&expected) {
        write_http_error(&mut stream, "403 Forbidden").await;
        return false;
    }
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        write_http_error(&mut stream, "404 Not Found").await;
        return false;
    };
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        item.size,
        ascii_download_name(&item.name)
    );
    if stream.write_all(header.as_bytes()).await.is_err() {
        return false;
    }
    tokio::io::copy(&mut file, &mut stream).await.is_ok()
}

async fn run_lan_share(
    app: AppHandle,
    manager_state: Arc<Mutex<Option<ActiveLanShare>>>,
    listener: TcpListener,
    share_id: String,
    token: String,
    path: PathBuf,
    item: TransferItem,
    duration: Duration,
    mut cancel: oneshot::Receiver<()>,
) {
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    let reason = loop {
        tokio::select! {
            _ = &mut cancel => break "stopped",
            _ = &mut deadline => break "expired",
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        if serve_download(stream, &token, &path, &item).await {
                            break "downloaded";
                        }
                    }
                    Err(_) => break "failed",
                }
            }
        }
    };
    let mut active = manager_state.lock().await;
    if active
        .as_ref()
        .is_some_and(|share| share.info.share_id == share_id)
    {
        active.take();
    }
    drop(active);
    let _ = app.emit(
        "lan-share-stopped",
        serde_json::json!({ "shareId": share_id, "reason": reason }),
    );
}

#[tauri::command]
pub(crate) async fn get_lan_share(
    manager: tauri::State<'_, TransferStationManager>,
) -> Result<Option<LanShareInfo>, String> {
    Ok(manager.current_share().await)
}

#[tauri::command]
pub(crate) async fn stop_lan_share(
    manager: tauri::State<'_, TransferStationManager>,
) -> Result<bool, String> {
    Ok(manager.stop_share().await.is_some())
}

#[tauri::command]
pub(crate) async fn start_lan_share(
    app: AppHandle,
    manager: tauri::State<'_, TransferStationManager>,
    item_id: String,
    duration_seconds: u64,
) -> Result<LanShareInfo, String> {
    if !(60..=3600).contains(&duration_seconds) {
        return Err("局域网分享时间必须在 1 到 60 分钟之间".to_string());
    }
    let (item, path) = resolve_item(&app, &item_id)?;
    if item.expires_at
        <= Utc::now()
            .timestamp_millis()
            .saturating_add((duration_seconds as i64).saturating_mul(1_000))
    {
        return Err("文件会在分享结束前过期，请重新导入并选择更长保存时间".to_string());
    }
    manager.stop_share().await;
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|error| format!("启动局域网分享失败: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取分享端口失败: {error}"))?
        .port();
    let address = local_ipv4()?;
    let share_id = uuid::Uuid::new_v4().to_string();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let expires_at = Utc::now()
        .timestamp_millis()
        .saturating_add((duration_seconds as i64).saturating_mul(1_000));
    let info = LanShareInfo {
        share_id: share_id.clone(),
        item_id,
        item_name: item.name.clone(),
        url: format!("http://{address}:{port}/download?token={token}"),
        expires_at,
    };
    let (cancel_sender, cancel_receiver) = oneshot::channel();
    *manager.active_share.lock().await = Some(ActiveLanShare {
        info: info.clone(),
        cancel: Some(cancel_sender),
    });
    let manager_state = manager.active_share.clone();
    let run_app = app.clone();
    tauri::async_runtime::spawn(run_lan_share(
        run_app,
        manager_state,
        listener,
        share_id,
        token,
        path,
        item,
        Duration::from_secs(duration_seconds),
        cancel_receiver,
    ));
    Ok(info)
}

pub(crate) fn schedule_transfer_expiry_check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = expire_items(&app) {
            eprintln!("[TransferStation] 启动过期检查失败: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("dtkit-transfer-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn ids_and_retention_bounds_are_strict() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(safe_id(&id));
        assert!(!safe_id("../escape"));
        assert!(safe_batch_id(&format!("transfer-removed-{id}")));
        assert!(!safe_batch_id("cleanup-other"));
        assert_eq!(MIN_TTL_SECONDS, 3600);
        assert_eq!(MAX_STATION_ITEMS, 100);
    }

    #[test]
    fn executable_items_are_not_opened_directly() {
        assert!(!is_safe_to_open("setup.exe"));
        assert!(!is_safe_to_open("launch.PS1"));
        assert!(is_safe_to_open("notes.txt"));
    }

    #[test]
    fn download_header_name_is_ascii_and_extension_only() {
        assert_eq!(ascii_download_name("报告.pdf"), "dtkit-transfer.pdf");
        assert_eq!(ascii_download_name("无扩展名"), "dtkit-transfer.bin");
    }

    #[test]
    fn item_metadata_matches_real_file_and_copy_never_overwrites() {
        let root = temp_root();
        let directory = root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&directory).unwrap();
        fs::write(data_path(&directory), b"temporary").unwrap();
        let item = TransferItem {
            id: directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            name: "notes.txt".into(),
            size: 9,
            created_at: 1,
            expires_at: 2,
        };
        write_item(&directory, &item).unwrap();
        assert_eq!(read_item(&directory).unwrap().name, "notes.txt");

        let target = root.join("export.txt");
        copy_file_create_new(&data_path(&directory), &target).unwrap();
        assert!(copy_file_create_new(&data_path(&directory), &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"temporary");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn lan_download_rejects_wrong_token_and_streams_with_correct_token() {
        let root = temp_root();
        let path = root.join("data");
        fs::write(&path, b"hello-lan").unwrap();
        let item = TransferItem {
            id: uuid::Uuid::new_v4().to_string(),
            name: "hello.txt".into(),
            size: 9,
            created_at: 1,
            expires_at: i64::MAX,
        };

        for (token, expected_success, expected_text) in [
            ("wrong", false, "403 Forbidden"),
            ("correct-token", true, "hello-lan"),
        ] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let serve_path = path.clone();
            let serve_item = item.clone();
            let expected_token = "correct-token".to_string();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                serve_download(stream, &expected_token, &serve_path, &serve_item).await
            });
            let mut client = TcpStream::connect(address).await.unwrap();
            client
                .write_all(
                    format!("GET /download?token={token} HTTP/1.1\r\nHost: localhost\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
            let mut response = Vec::new();
            client.read_to_end(&mut response).await.unwrap();
            assert_eq!(server.await.unwrap(), expected_success);
            assert!(String::from_utf8_lossy(&response).contains(expected_text));
        }
        fs::remove_dir_all(root).unwrap();
    }
}
