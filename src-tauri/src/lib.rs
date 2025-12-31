// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs::{self, File};
use std::io::{Write, Read, BufReader};
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use futures_util::StreamExt;

// 桌面整理模块
mod desktop;
use desktop::commands::*;
use desktop::hotzone::{HotZoneConfig, HotZoneMonitor, stop_hotzone_monitor, is_hotzone_running};

// 哈希计算相关
use md5::Md5;
use sha1::Sha1;
use sha2::{Sha256, Sha512, Digest};

// 下载任务状态
#[derive(Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub save_path: String,
    pub total_size: u64,
    pub downloaded: u64,
    pub status: String, // "downloading" | "completed" | "error" | "paused"
    pub error_message: Option<String>,
    pub speed: f64, // bytes per second
}

// 全局下载任务管理
lazy_static::lazy_static! {
    static ref DOWNLOAD_TASKS: Arc<Mutex<HashMap<String, DownloadTask>>> = Arc::new(Mutex::new(HashMap::new()));
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    // 确保父目录存在
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    
    fs::write(&path, &data).map_err(|e| format!("写入文件失败: {}", e))
}

// ============================================
// 哈希计算相关命令
// ============================================

/// 计算文本的哈希值
#[tauri::command]
fn calculate_text_hash(text: String, algorithms: Vec<String>, uppercase: bool) -> Result<HashMap<String, String>, String> {
    let mut results = HashMap::new();
    let bytes = text.as_bytes();
    
    for algo in algorithms {
        let hash = match algo.to_lowercase().as_str() {
            "md5" => {
                let mut hasher = Md5::new();
                hasher.update(bytes);
                hex::encode(hasher.finalize())
            }
            "sha1" | "sha-1" => {
                let mut hasher = Sha1::new();
                hasher.update(bytes);
                hex::encode(hasher.finalize())
            }
            "sha256" | "sha-256" => {
                let mut hasher = Sha256::new();
                hasher.update(bytes);
                hex::encode(hasher.finalize())
            }
            "sha512" | "sha-512" => {
                let mut hasher = Sha512::new();
                hasher.update(bytes);
                hex::encode(hasher.finalize())
            }
            _ => continue,
        };
        
        let hash = if uppercase { hash.to_uppercase() } else { hash };
        results.insert(algo, hash);
    }
    
    Ok(results)
}

/// 计算文件的哈希值（支持大文件流式处理）
#[tauri::command]
async fn calculate_file_hash(
    app: AppHandle,
    file_path: String,
    algorithms: Vec<String>,
    uppercase: bool,
    task_id: String,
) -> Result<HashMap<String, String>, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("文件不存在".to_string());
    }
    
    let file = File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let file_size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut reader = BufReader::new(file);
    
    // 初始化所有需要的 hasher
    let mut md5_hasher: Option<Md5> = None;
    let mut sha1_hasher: Option<Sha1> = None;
    let mut sha256_hasher: Option<Sha256> = None;
    let mut sha512_hasher: Option<Sha512> = None;
    
    for algo in &algorithms {
        match algo.to_lowercase().as_str() {
            "md5" => md5_hasher = Some(Md5::new()),
            "sha1" | "sha-1" => sha1_hasher = Some(Sha1::new()),
            "sha256" | "sha-256" => sha256_hasher = Some(Sha256::new()),
            "sha512" | "sha-512" => sha512_hasher = Some(Sha512::new()),
            _ => {}
        }
    }
    
    // 流式读取文件
    let mut buffer = [0u8; 65536]; // 64KB 缓冲区
    let mut total_read: u64 = 0;
    let mut last_progress: u64 = 0;
    
    loop {
        let bytes_read = reader.read(&mut buffer).map_err(|e| format!("读取文件失败: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        
        let chunk = &buffer[..bytes_read];
        
        // 更新所有 hasher
        if let Some(ref mut h) = md5_hasher { h.update(chunk); }
        if let Some(ref mut h) = sha1_hasher { h.update(chunk); }
        if let Some(ref mut h) = sha256_hasher { h.update(chunk); }
        if let Some(ref mut h) = sha512_hasher { h.update(chunk); }
        
        total_read += bytes_read as u64;
        
        // 每 1MB 发送一次进度更新
        if total_read - last_progress > 1048576 || total_read == file_size {
            let progress = if file_size > 0 { (total_read as f64 / file_size as f64) * 100.0 } else { 100.0 };
            let _ = app.emit("hash-progress", serde_json::json!({
                "taskId": task_id,
                "progress": progress,
                "bytesProcessed": total_read,
                "totalBytes": file_size
            }));
            last_progress = total_read;
        }
    }
    
    // 收集结果
    let mut results = HashMap::new();
    
    for algo in algorithms {
        let hash = match algo.to_lowercase().as_str() {
            "md5" => md5_hasher.take().map(|h| hex::encode(h.finalize())),
            "sha1" | "sha-1" => sha1_hasher.take().map(|h| hex::encode(h.finalize())),
            "sha256" | "sha-256" => sha256_hasher.take().map(|h| hex::encode(h.finalize())),
            "sha512" | "sha-512" => sha512_hasher.take().map(|h| hex::encode(h.finalize())),
            _ => None,
        };
        
        if let Some(h) = hash {
            let h = if uppercase { h.to_uppercase() } else { h };
            results.insert(algo, h);
        }
    }
    
    Ok(results)
}

#[tauri::command]
fn run_command(cmd: String, args: Vec<String>) -> Result<String, String> {
    let output = Command::new(&cmd)
        .args(&args)
        .output()
        .map_err(|e| format!("执行命令失败: {}", e))?;
    
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// 开始下载文件（支持多镜像自动重试）
#[tauri::command]
async fn start_download(
    app: AppHandle,
    url: String,
    save_path: String,
    custom_filename: Option<String>,
    mirror_urls: Option<Vec<String>>, // 备用镜像 URL 列表
) -> Result<String, String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    
    // 调试日志
    println!("=== 开始下载 ===");
    println!("主 URL: {}", url);
    println!("备用镜像数量: {:?}", mirror_urls.as_ref().map(|v| v.len()));
    if let Some(ref mirrors) = mirror_urls {
        for (i, m) in mirrors.iter().enumerate() {
            println!("  备用镜像 {}: {}", i + 1, m);
        }
    }
    
    // 从 URL 提取文件名
    let filename = custom_filename.unwrap_or_else(|| {
        url.split('/').last().unwrap_or("download").to_string()
    });
    
    // 完整保存路径
    let full_path = Path::new(&save_path).join(&filename);
    let full_path_str = full_path.to_string_lossy().to_string();
    
    // 确保保存目录存在
    if let Some(parent) = full_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    
    // 构建所有要尝试的 URL 列表
    let mut urls_to_try = vec![url.clone()];
    if let Some(mirrors) = mirror_urls {
        urls_to_try.extend(mirrors);
    }
    
    // 创建初始任务
    let task = DownloadTask {
        id: task_id.clone(),
        url: url.clone(),
        filename: filename.clone(),
        save_path: full_path_str.clone(),
        total_size: 0,
        downloaded: 0,
        status: "downloading".to_string(),
        error_message: None,
        speed: 0.0,
    };
    
    // 存储任务
    {
        let mut tasks = DOWNLOAD_TASKS.lock().unwrap();
        tasks.insert(task_id.clone(), task.clone());
    }
    
    // 发送初始状态
    let _ = app.emit("download-started", &task);
    
    // 在后台线程执行下载
    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    
    tauri::async_runtime::spawn(async move {
        // 依次尝试每个 URL
        let mut last_error = String::new();
        
        println!("共有 {} 个 URL 需要尝试", urls_to_try.len());
        
        for (index, try_url) in urls_to_try.iter().enumerate() {
            println!("尝试第 {} 个: {}", index + 1, try_url);
            
            // 发送正在尝试的镜像信息
            if index > 0 {
                let _ = app_clone.emit("download-retry", serde_json::json!({
                    "id": task_id_clone,
                    "attempt": index + 1,
                    "url": try_url,
                    "message": format!("正在尝试镜像 {} ...", index + 1)
                }));
            }
            
            match download_file_internal(&app_clone, &task_id_clone, try_url, &full_path_str).await {
                Ok(_) => {
                    println!("下载成功: {}", try_url);
                    update_task_status(&app_clone, &task_id_clone, "completed", None);
                    return; // 下载成功，退出
                }
                Err(e) => {
                    println!("下载失败: {} - 错误: {}", try_url, e);
                    last_error = e.clone();
                    // 如果还有更多镜像可尝试，继续；否则报错
                    if index < urls_to_try.len() - 1 {
                        println!("将尝试下一个镜像...");
                        // 删除可能存在的不完整文件
                        let _ = fs::remove_file(&full_path_str);
                        continue;
                    }
                }
            }
        }
        
        // 所有镜像都失败了
        println!("所有 {} 个镜像均失败", urls_to_try.len());
        update_task_status(&app_clone, &task_id_clone, "error", Some(format!("所有镜像均失败: {}", last_error)));
    });
    
    Ok(task_id)
}

/// 内部下载实现
async fn download_file_internal(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    save_path: &str,
) -> Result<(), String> {
    // 创建带有自定义 User-Agent 的客户端，并允许重定向
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;
    
    // 根据 URL 设置适当的 Referer
    let referer = if url.contains("nuaa.cf") {
        "https://hub.nuaa.cf/"
    } else if url.contains("yzuu.cf") {
        "https://hub.yzuu.cf/"
    } else if url.contains("kkgithub.com") {
        "https://kkgithub.com/"
    } else if url.contains("ghproxy.net") {
        "https://ghproxy.net/"
    } else if url.contains("gh-proxy.com") {
        "https://gh-proxy.com/"
    } else if url.contains("github.com") {
        "https://github.com/"
    } else {
        ""
    };
    
    let mut request = client
        .get(url)
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Accept-Encoding", "gzip, deflate, br")
        .header("Connection", "keep-alive");
    
    // 添加 Referer 头（如果有）
    if !referer.is_empty() {
        request = request.header("Referer", referer);
    }
    
    let response = request
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("HTTP 错误: {}", response.status()));
    }
    
    let total_size = response.content_length().unwrap_or(0);
    
    // 更新总大小
    {
        let mut tasks = DOWNLOAD_TASKS.lock().unwrap();
        if let Some(task) = tasks.get_mut(task_id) {
            task.total_size = total_size;
        }
    }
    
    let mut file = File::create(save_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit_time = std::time::Instant::now();
    let mut last_downloaded: u64 = 0;
    
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取数据失败: {}", e))?;
        
        file.write_all(&chunk)
            .map_err(|e| format!("写入文件失败: {}", e))?;
        
        downloaded += chunk.len() as u64;
        
        // 每 200ms 发送一次进度更新
        let now = std::time::Instant::now();
        if now.duration_since(last_emit_time).as_millis() >= 200 {
            let elapsed = now.duration_since(last_emit_time).as_secs_f64();
            let speed = if elapsed > 0.0 {
                (downloaded - last_downloaded) as f64 / elapsed
            } else {
                0.0
            };
            
            // 更新任务状态
            {
                let mut tasks = DOWNLOAD_TASKS.lock().unwrap();
                if let Some(task) = tasks.get_mut(task_id) {
                    task.downloaded = downloaded;
                    task.speed = speed;
                }
            }
            
            // 发送进度事件
            let progress = DownloadProgress {
                id: task_id.to_string(),
                downloaded,
                total_size,
                speed,
                percentage: if total_size > 0 {
                    (downloaded as f64 / total_size as f64 * 100.0) as u8
                } else {
                    0
                },
            };
            let _ = app.emit("download-progress", &progress);
            
            last_emit_time = now;
            last_downloaded = downloaded;
        }
    }
    
    Ok(())
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total_size: u64,
    speed: f64,
    percentage: u8,
}

/// 更新任务状态并发送事件
fn update_task_status(app: &AppHandle, task_id: &str, status: &str, error: Option<String>) {
    let task = {
        let mut tasks = DOWNLOAD_TASKS.lock().unwrap();
        if let Some(task) = tasks.get_mut(task_id) {
            task.status = status.to_string();
            task.error_message = error;
            if status == "completed" {
                task.downloaded = task.total_size;
            }
            task.clone()
        } else {
            return;
        }
    };
    
    let _ = app.emit("download-status-changed", &task);
}

/// 获取所有下载任务
#[tauri::command]
fn get_download_tasks() -> Vec<DownloadTask> {
    let tasks = DOWNLOAD_TASKS.lock().unwrap();
    tasks.values().cloned().collect()
}

/// 取消下载任务
#[tauri::command]
fn cancel_download(task_id: String) -> Result<(), String> {
    let mut tasks = DOWNLOAD_TASKS.lock().unwrap();
    if let Some(task) = tasks.get_mut(&task_id) {
        task.status = "cancelled".to_string();
        // 删除未完成的文件
        let _ = fs::remove_file(&task.save_path);
    }
    tasks.remove(&task_id);
    Ok(())
}

/// 删除下载记录
#[tauri::command]
fn remove_download_record(task_id: String) -> Result<(), String> {
    let mut tasks = DOWNLOAD_TASKS.lock().unwrap();
    tasks.remove(&task_id);
    Ok(())
}

/// 打开文件所在目录
#[tauri::command]
fn open_file_location(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("打开目录失败: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("打开目录失败: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = Path::new(&path).parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("打开目录失败: {}", e))?;
        }
    }
    
    Ok(())
}

/// 打开文件
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("打开文件失败: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件失败: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件失败: {}", e))?;
    }
    
    Ok(())
}

// 桌面整理热区监听启动命令
#[tauri::command]
fn start_hotzone_monitor(app: AppHandle) -> Result<(), String> {
    use desktop::hotzone::get_screen_size;
    use tauri::PhysicalPosition;
    
    // 如果已经在运行，不要重复启动
    if is_hotzone_running() {
        return Ok(());
    }
    
    let config = HotZoneConfig::default();
    let monitor = HotZoneMonitor::new(config);
    
    // 获取屏幕尺寸，计算窗口位置（右侧）
    let (screen_width, _) = get_screen_size();
    let panel_width = 550;
    let panel_x = screen_width - panel_width - 20;  // 距右边缘 20px
    let panel_y = 10;
    
    let app_handle = app.clone();
    monitor.start(move |show| {
        if let Some(window) = app_handle.get_webview_window("desktop-organizer") {
            if show {
                // 动态设置窗口位置到屏幕右侧
                let _ = window.set_position(PhysicalPosition::new(panel_x, panel_y));
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                let _ = window.hide();
            }
        }
    });
    
    Ok(())
}

// 停止桌面整理热区监听
#[tauri::command]
fn stop_hotzone() -> Result<(), String> {
    stop_hotzone_monitor();
    Ok(())
}

// 检查热区监听状态
#[tauri::command]
fn get_hotzone_status() -> bool {
    is_hotzone_running()
}

// 显示/隐藏桌面整理窗口
#[tauri::command]
fn toggle_desktop_organizer(app: AppHandle, show: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("desktop-organizer") {
        if show {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        } else {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 注意：热区监听现在通过前端调用 start_hotzone_monitor 命令启动
            // 不再在启动时自动启动，由用户设置控制
            // 这样可以避免不必要的资源消耗
            let _ = app; // 消除未使用警告
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            write_binary_file,
            run_command,
            calculate_text_hash,
            calculate_file_hash,
            start_download,
            get_download_tasks,
            cancel_download,
            remove_download_record,
            open_file_location,
            open_file,
            // 桌面整理命令
            desktop_scan,
            desktop_search,
            desktop_open_file,
            desktop_locate_file,
            desktop_rename_file,
            desktop_get_file_path,
            desktop_get_path,
            start_hotzone_monitor,
            stop_hotzone,
            get_hotzone_status,
            toggle_desktop_organizer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
