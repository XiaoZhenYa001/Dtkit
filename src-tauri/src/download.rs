use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::path_safety::validate_leaf_filename;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct DownloadTask {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub save_path: String,
    pub total_size: u64,
    pub downloaded: u64,
    pub status: String,
    pub error_message: Option<String>,
    pub speed: f64,
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total_size: u64,
    speed: f64,
    percentage: u8,
}

#[derive(Debug)]
enum DownloadError {
    Cancelled,
    Failed(String),
}

impl From<std::io::Error> for DownloadError {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

lazy_static::lazy_static! {
    static ref DOWNLOAD_TASKS: Arc<Mutex<HashMap<String, DownloadTask>>> =
        Arc::new(Mutex::new(HashMap::new()));
    static ref DOWNLOAD_CANCELLATIONS: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
}

fn lock_error(name: &str) -> String {
    format!("{name}状态锁已损坏")
}

fn validate_download_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "下载地址格式无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("下载地址仅支持 HTTP 或 HTTPS".to_string());
    }
    Ok(parsed)
}

fn resolve_download_filename(url: &reqwest::Url, custom: Option<String>) -> Result<String, String> {
    let filename = custom.unwrap_or_else(|| {
        url.path_segments()
            .and_then(|mut segments| segments.next_back())
            .filter(|segment| !segment.is_empty())
            .unwrap_or("download")
            .to_string()
    });
    validate_leaf_filename(&filename)?;
    Ok(filename)
}

fn temporary_path(final_path: &Path, task_id: &str) -> PathBuf {
    let filename = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    final_path.with_file_name(format!(".{filename}.{task_id}.part"))
}

fn is_cancelled(cancellation: &AtomicBool) -> bool {
    cancellation.load(Ordering::Acquire)
}

fn referer_for_url(url: &reqwest::Url) -> Option<&'static str> {
    let host = url.host_str()?;
    let matches_host = |expected: &str| host == expected || host.ends_with(&format!(".{expected}"));

    if matches_host("nuaa.cf") {
        Some("https://hub.nuaa.cf/")
    } else if matches_host("yzuu.cf") {
        Some("https://hub.yzuu.cf/")
    } else if matches_host("kkgithub.com") {
        Some("https://kkgithub.com/")
    } else if matches_host("ghproxy.net") {
        Some("https://ghproxy.net/")
    } else if matches_host("gh-proxy.com") {
        Some("https://gh-proxy.com/")
    } else if matches_host("github.com") {
        Some("https://github.com/")
    } else {
        None
    }
}

#[tauri::command]
pub(crate) async fn start_download(
    app: AppHandle,
    url: String,
    save_path: String,
    custom_filename: Option<String>,
    mirror_urls: Option<Vec<String>>,
) -> Result<String, String> {
    let primary_url = validate_download_url(&url)?;
    let filename = resolve_download_filename(&primary_url, custom_filename)?;

    let save_directory = PathBuf::from(save_path);
    if save_directory.as_os_str().is_empty() {
        return Err("保存目录不能为空".to_string());
    }
    if save_directory.exists() && !save_directory.is_dir() {
        return Err("保存路径不是目录".to_string());
    }
    fs::create_dir_all(&save_directory).map_err(|error| format!("创建目录失败: {error}"))?;

    let mut urls_to_try = vec![primary_url];
    for mirror in mirror_urls.unwrap_or_default() {
        urls_to_try.push(validate_download_url(&mirror)?);
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("DtKit/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("创建下载客户端失败: {error}"))?;

    let task_id = uuid::Uuid::new_v4().to_string();
    let final_path = save_directory.join(&filename);
    let temp_path = temporary_path(&final_path, &task_id);
    let cancellation = Arc::new(AtomicBool::new(false));

    let task = DownloadTask {
        id: task_id.clone(),
        url,
        filename,
        save_path: final_path.to_string_lossy().into_owned(),
        total_size: 0,
        downloaded: 0,
        status: "downloading".to_string(),
        error_message: None,
        speed: 0.0,
    };

    DOWNLOAD_TASKS
        .lock()
        .map_err(|_| lock_error("下载任务"))?
        .insert(task_id.clone(), task.clone());
    DOWNLOAD_CANCELLATIONS
        .lock()
        .map_err(|_| lock_error("下载取消"))?
        .insert(task_id.clone(), cancellation.clone());

    let _ = app.emit("download-started", &task);

    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = download_with_mirrors(
            &app_clone,
            &client,
            &task_id_clone,
            &urls_to_try,
            &temp_path,
            &final_path,
            &cancellation,
        )
        .await;

        match result {
            Ok(()) if is_cancelled(&cancellation) => {
                let _ = tokio::fs::remove_file(&final_path).await;
            }
            Ok(()) => update_task_status(&app_clone, &task_id_clone, "completed", None),
            Err(DownloadError::Cancelled) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
            }
            Err(DownloadError::Failed(error)) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                update_task_status(&app_clone, &task_id_clone, "error", Some(error));
            }
        }

        if let Ok(mut cancellations) = DOWNLOAD_CANCELLATIONS.lock() {
            cancellations.remove(&task_id_clone);
        }
    });

    Ok(task_id)
}

async fn download_with_mirrors(
    app: &AppHandle,
    client: &reqwest::Client,
    task_id: &str,
    urls: &[reqwest::Url],
    temp_path: &Path,
    final_path: &Path,
    cancellation: &AtomicBool,
) -> Result<(), DownloadError> {
    let mut last_error = "没有可用的下载地址".to_string();

    for (index, url) in urls.iter().enumerate() {
        if is_cancelled(cancellation) {
            return Err(DownloadError::Cancelled);
        }

        if index > 0 {
            let _ = app.emit(
                "download-retry",
                serde_json::json!({
                    "id": task_id,
                    "attempt": index + 1,
                    "url": url.as_str(),
                    "message": format!("正在尝试镜像 {} ...", index + 1)
                }),
            );
        }

        match download_once(app, client, task_id, url, temp_path, cancellation).await {
            Ok(()) => {
                if is_cancelled(cancellation) {
                    return Err(DownloadError::Cancelled);
                }

                if final_path.exists() {
                    tokio::fs::remove_file(final_path).await.map_err(|error| {
                        DownloadError::Failed(format!("替换已有文件失败: {error}"))
                    })?;
                }
                tokio::fs::rename(temp_path, final_path)
                    .await
                    .map_err(|error| DownloadError::Failed(format!("提交下载文件失败: {error}")))?;

                if is_cancelled(cancellation) {
                    let _ = tokio::fs::remove_file(final_path).await;
                    return Err(DownloadError::Cancelled);
                }
                return Ok(());
            }
            Err(DownloadError::Cancelled) => return Err(DownloadError::Cancelled),
            Err(DownloadError::Failed(error)) => {
                last_error = error;
                let _ = tokio::fs::remove_file(temp_path).await;
            }
        }
    }

    Err(DownloadError::Failed(format!(
        "所有镜像均失败: {last_error}"
    )))
}

async fn download_once(
    app: &AppHandle,
    client: &reqwest::Client,
    task_id: &str,
    url: &reqwest::Url,
    temp_path: &Path,
    cancellation: &AtomicBool,
) -> Result<(), DownloadError> {
    let mut request = client.get(url.clone()).header("Accept", "*/*");
    if let Some(referer) = referer_for_url(url) {
        request = request.header("Referer", referer);
    }

    let response = request
        .send()
        .await
        .map_err(|error| DownloadError::Failed(format!("请求失败: {error}")))?;

    if !response.status().is_success() {
        return Err(DownloadError::Failed(format!(
            "HTTP 错误: {}",
            response.status()
        )));
    }

    let total_size = response.content_length().unwrap_or(0);
    if let Ok(mut tasks) = DOWNLOAD_TASKS.lock() {
        if let Some(task) = tasks.get_mut(task_id) {
            task.total_size = total_size;
        }
    }

    let mut file = tokio::fs::File::create(temp_path)
        .await
        .map_err(|error| DownloadError::Failed(format!("创建临时文件失败: {error}")))?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0_u64;
    let mut last_emit_time = Instant::now();
    let mut last_downloaded = 0_u64;

    while let Some(chunk) = stream.next().await {
        if is_cancelled(cancellation) {
            return Err(DownloadError::Cancelled);
        }

        let chunk =
            chunk.map_err(|error| DownloadError::Failed(format!("读取数据失败: {error}")))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| DownloadError::Failed(format!("写入文件失败: {error}")))?;
        downloaded += chunk.len() as u64;

        let now = Instant::now();
        if now.duration_since(last_emit_time).as_millis() >= 200 {
            let elapsed = now.duration_since(last_emit_time).as_secs_f64();
            let speed = if elapsed > 0.0 {
                (downloaded - last_downloaded) as f64 / elapsed
            } else {
                0.0
            };

            if let Ok(mut tasks) = DOWNLOAD_TASKS.lock() {
                if let Some(task) = tasks.get_mut(task_id) {
                    task.downloaded = downloaded;
                    task.speed = speed;
                }
            }

            let _ = app.emit(
                "download-progress",
                DownloadProgress {
                    id: task_id.to_string(),
                    downloaded,
                    total_size,
                    speed,
                    percentage: if total_size > 0 {
                        ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u8
                    } else {
                        0
                    },
                },
            );
            last_emit_time = now;
            last_downloaded = downloaded;
        }
    }

    file.flush()
        .await
        .map_err(|error| DownloadError::Failed(format!("刷新下载文件失败: {error}")))?;
    Ok(())
}

fn update_task_status(app: &AppHandle, task_id: &str, status: &str, error: Option<String>) {
    let task = DOWNLOAD_TASKS.lock().ok().and_then(|mut tasks| {
        tasks.get_mut(task_id).map(|task| {
            task.status = status.to_string();
            task.error_message = error;
            if status == "completed" {
                task.downloaded = task.total_size;
                task.speed = 0.0;
            }
            task.clone()
        })
    });

    if let Some(task) = task {
        let _ = app.emit("download-status-changed", task);
    }
}

#[tauri::command]
pub(crate) fn get_download_tasks() -> Vec<DownloadTask> {
    DOWNLOAD_TASKS
        .lock()
        .map(|tasks| tasks.values().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn cancel_download(app: AppHandle, task_id: String) -> Result<(), String> {
    if let Some(cancellation) = DOWNLOAD_CANCELLATIONS
        .lock()
        .map_err(|_| lock_error("下载取消"))?
        .get(&task_id)
        .cloned()
    {
        cancellation.store(true, Ordering::Release);
    }

    let task = DOWNLOAD_TASKS
        .lock()
        .map_err(|_| lock_error("下载任务"))?
        .remove(&task_id);

    if let Some(mut task) = task {
        task.status = "cancelled".to_string();
        task.speed = 0.0;
        let temp_path = temporary_path(Path::new(&task.save_path), &task_id);
        let _ = fs::remove_file(temp_path);
        let _ = app.emit("download-status-changed", task);
    }

    Ok(())
}

#[tauri::command]
pub(crate) fn remove_download_record(task_id: String) -> Result<(), String> {
    DOWNLOAD_TASKS
        .lock()
        .map_err(|_| lock_error("下载任务"))?
        .remove(&task_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        referer_for_url, resolve_download_filename, temporary_path, validate_download_url,
    };
    use std::path::Path;

    #[test]
    fn resolves_a_safe_filename_from_the_url() {
        let url = validate_download_url("https://example.com/releases/app.zip?token=abc").unwrap();
        assert_eq!(resolve_download_filename(&url, None).unwrap(), "app.zip");
    }

    #[test]
    fn rejects_unsupported_schemes_and_traversal() {
        assert!(validate_download_url("file:///etc/passwd").is_err());
        let url = validate_download_url("https://example.com/app.zip").unwrap();
        assert!(resolve_download_filename(&url, Some("../escape.zip".to_string())).is_err());
    }

    #[test]
    fn creates_a_task_specific_partial_file_name() {
        let final_path = Path::new("Downloads").join("app.zip");
        assert_eq!(
            temporary_path(&final_path, "task-1"),
            Path::new("Downloads").join(".app.zip.task-1.part")
        );
    }

    #[test]
    fn applies_referers_only_to_expected_hosts() {
        let github = validate_download_url("https://objects.githubusercontent.com/file").unwrap();
        let github_page = validate_download_url("https://github.com/example/release").unwrap();
        let spoofed = validate_download_url("https://github.com.attacker.test/file").unwrap();

        assert_eq!(referer_for_url(&github), None);
        assert_eq!(referer_for_url(&github_page), Some("https://github.com/"));
        assert_eq!(referer_for_url(&spoofed), None);
    }
}
