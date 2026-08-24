// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

// 桌面整理模块
mod alarm_scheduler;
mod desktop;
mod file_output;
mod infrastructure;
mod path_safety;
mod system_actions;

use alarm_scheduler::{
    create_quick_countdown, sync_alarm_tasks, take_missed_alarm_triggers, AlarmScheduler,
};
use desktop::commands::*;
use desktop::hotzone::{
    get_hotzone_pos, is_hotzone_running, stop_hotzone_monitor, update_hotzone_pos,
    update_panel_bounds, HotZoneConfig, HotZoneMonitor,
};
use file_output::write_qr_code;
use infrastructure::cleanup::{
    get_cleanup_status, restore_latest_cleanup, run_storage_cleanup, schedule_automatic_cleanup,
    set_automatic_cleanup_enabled, set_cleanup_retention_days, CleanupManager,
};
use infrastructure::file_batch::{preview_file_batch, restore_file_batch, start_file_batch};
use infrastructure::jobs::{cancel_job, get_jobs, JobManager};
use infrastructure::palette::{open_local_search_result, search_local_files, LocalSearchManager};
use infrastructure::passwords::{
    audit_password_security, commit_password_import, copy_password, copy_password_field,
    discard_password_import, empty_password_trash, get_password_detail,
    get_password_entry_for_edit, get_password_overview, get_password_settings, list_passwords,
    open_password_url, preview_password_import, remove_password_entry, restore_password_entry,
    save_password_entry, set_password_favorite, set_password_settings,
    update_password_import_entry, PasswordVaultManager,
};
use infrastructure::quick_host::{
    dismiss_quick_host, open_quick_host, touch_quick_host_activity, QuickHostManager,
};
use infrastructure::resources::{
    get_resource_policy, get_resource_snapshot, release_idle_resources, set_minimize_mode,
    set_resource_policy, MinimizeMode, ResourceGovernor,
};
use infrastructure::screen_color_picker::{
    finish_screen_color_pick, get_screen_color_pick_capture, start_screen_color_pick,
    ScreenColorPickerManager,
};
use infrastructure::screenshot::{
    finish_screen_region_capture, get_screen_region_capture, save_annotated_screenshot,
    start_screen_region_capture, ScreenRegionCaptureManager,
};
use infrastructure::shortcuts::{
    get_shortcut_bindings, handle_shortcut, replace_shortcut_bindings, ShortcutRegistry,
};
use infrastructure::snippets::{delete_snippet, save_snippet, search_snippets, SnippetManager};
use infrastructure::storage::{
    get_storage_layout, get_storage_usage, migrate_storage_root, StorageManager,
};
use infrastructure::system_assistant::{
    reveal_system_startup_item, scan_system_startup_items, set_system_startup_enabled,
    SystemAssistantManager,
};
use infrastructure::tool_modules::{
    get_tool_module_settings, set_tool_module_enabled, ToolModuleManager,
};
use infrastructure::transfer_station::{
    export_transfer_item, get_lan_share, import_transfer_files, list_transfer_items,
    open_transfer_item, remove_transfer_item, restore_transfer_item,
    schedule_transfer_expiry_check, start_lan_share, stop_lan_share, TransferStationManager,
};
use infrastructure::whiteboard::{
    discard_whiteboard_draft, get_whiteboard_thumbnail, list_whiteboards, load_whiteboard,
    release_whiteboard_edit, save_whiteboard, save_whiteboard_draft, take_over_whiteboard_edit,
    WhiteboardEditManager,
};
use system_actions::{lock_screen, open_release_page, run_program, schedule_shutdown};

static APP_SUSPENDED: AtomicBool = AtomicBool::new(false);
static DEEP_SLEEP_CLOSING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MainWindowCloseBehavior {
    HideToTray,
    DestroyWebview,
}

fn main_window_close_behavior(mode: MinimizeMode) -> MainWindowCloseBehavior {
    match mode {
        MinimizeMode::Standard | MinimizeMode::Efficient => MainWindowCloseBehavior::HideToTray,
        MinimizeMode::Deep => MainWindowCloseBehavior::DestroyWebview,
    }
}

fn emit_main_power_state(app: &AppHandle, suspended: bool, closing: bool) {
    let mode = app.state::<ResourceGovernor>().mode();
    let _ = app.emit_to(
        "main",
        "app-power-state",
        serde_json::json!({
            "suspended": suspended,
            "mode": mode,
            "closing": closing
        }),
    );
}

#[cfg(target_os = "windows")]
fn set_webview_memory_target(window: &WebviewWindow, low_memory: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_webview2::core::Interface;

    let _ = window.with_webview(move |platform_webview| {
        let controller = platform_webview.controller();
        let result = unsafe {
            controller
                .CoreWebView2()
                .and_then(|webview| webview.cast::<ICoreWebView2_19>())
                .and_then(|webview| {
                    webview.SetMemoryUsageTargetLevel(if low_memory {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    })
                })
        };

        if let Err(error) = result {
            eprintln!("[PowerLifecycle] 设置 WebView2 内存目标失败: {error}");
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn set_webview_memory_target(_window: &WebviewWindow, _low_memory: bool) {}

fn ensure_desktop_organizer_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("desktop-organizer") {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        "desktop-organizer",
        WebviewUrl::App("desktop-organizer/index.html".into()),
    )
    .title("桌面整理")
    .inner_size(550.0, 450.0)
    .min_inner_size(400.0, 300.0)
    .resizable(true)
    .transparent(false)
    .decorations(false)
    .always_on_top(true)
    .visible(false)
    .skip_taskbar(true)
    .shadow(false)
    .build()
    .map_err(|error| format!("创建桌面整理窗口失败: {error}"))?;
    position_desktop_organizer_at_top_right(&window)?;
    Ok(window)
}

fn fit_window_rect(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitor_position: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    margin: u32,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let max_width = monitor_size
        .width
        .saturating_sub(margin.saturating_mul(2))
        .max(1);
    let max_height = monitor_size
        .height
        .saturating_sub(margin.saturating_mul(2))
        .max(1);
    let fitted_size = PhysicalSize::new(size.width.min(max_width), size.height.min(max_height));
    let min_x = monitor_position.x.saturating_add(margin as i32);
    let min_y = monitor_position.y.saturating_add(margin as i32);
    let max_x = monitor_position
        .x
        .saturating_add(monitor_size.width as i32)
        .saturating_sub(fitted_size.width as i32)
        .saturating_sub(margin as i32)
        .max(min_x);
    let max_y = monitor_position
        .y
        .saturating_add(monitor_size.height as i32)
        .saturating_sub(fitted_size.height as i32)
        .saturating_sub(margin as i32)
        .max(min_y);
    (
        PhysicalPosition::new(
            position.x.clamp(min_x, max_x),
            position.y.clamp(min_y, max_y),
        ),
        fitted_size,
    )
}

fn organizer_monitor(window: &WebviewWindow) -> Result<tauri::Monitor, String> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "无法获取桌面整理所在显示器".to_string())
}

fn fit_desktop_organizer_to_screen(window: &WebviewWindow) -> Result<(), String> {
    let monitor = organizer_monitor(window)?;
    let position = window
        .outer_position()
        .map_err(|error| format!("读取桌面整理位置失败: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("读取桌面整理尺寸失败: {error}"))?;
    let (position, size) =
        fit_window_rect(position, size, *monitor.position(), *monitor.size(), 12);
    window
        .set_size(size)
        .map_err(|error| format!("调整桌面整理尺寸失败: {error}"))?;
    window
        .set_position(position)
        .map_err(|error| format!("调整桌面整理位置失败: {error}"))
}

fn position_desktop_organizer_at_top_right(window: &WebviewWindow) -> Result<(), String> {
    let monitor = organizer_monitor(window)?;
    let size = window
        .outer_size()
        .map_err(|error| format!("读取桌面整理尺寸失败: {error}"))?;
    let preferred = PhysicalPosition::new(
        monitor.position().x + monitor.size().width as i32 - size.width as i32 - 12,
        monitor.position().y + 12,
    );
    let (position, size) =
        fit_window_rect(preferred, size, *monitor.position(), *monitor.size(), 12);
    window
        .set_size(size)
        .map_err(|error| format!("调整桌面整理尺寸失败: {error}"))?;
    window
        .set_position(position)
        .map_err(|error| format!("设置桌面整理初始位置失败: {error}"))
}

fn ensure_main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    APP_SUSPENDED.store(false, Ordering::Relaxed);
    DEEP_SLEEP_CLOSING.store(false, Ordering::Relaxed);

    if let Some(window) = app.get_webview_window("main") {
        set_webview_memory_target(&window, false);
        // 先解除前端休眠状态，再显示窗口，避免入场动画停在透明首帧。
        emit_main_power_state(window.app_handle(), false, false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(window);
    }

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("DtKit")
        .inner_size(1000.0, 600.0)
        .min_inner_size(760.0, 480.0)
        .build()
        .map_err(|error| format!("恢复 DtKit 主窗口失败: {error}"))
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show-main", "显示 DtKit", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("dtkit-tray")
        .tooltip("DtKit")
        .menu(&menu)
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// 哈希计算相关
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// ============================================
// 哈希计算相关命令
// ============================================

/// 计算文本的哈希值
#[tauri::command]
fn calculate_text_hash(
    text: String,
    algorithms: Vec<String>,
    uppercase: bool,
) -> Result<HashMap<String, String>, String> {
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
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|e| format!("读取文件失败: {}", e))?;
        if bytes_read == 0 {
            break;
        }

        let chunk = &buffer[..bytes_read];

        // 更新所有 hasher
        if let Some(ref mut h) = md5_hasher {
            h.update(chunk);
        }
        if let Some(ref mut h) = sha1_hasher {
            h.update(chunk);
        }
        if let Some(ref mut h) = sha256_hasher {
            h.update(chunk);
        }
        if let Some(ref mut h) = sha512_hasher {
            h.update(chunk);
        }

        total_read += bytes_read as u64;

        // 每 1MB 发送一次进度更新
        if total_read - last_progress > 1048576 || total_read == file_size {
            let progress = if file_size > 0 {
                (total_read as f64 / file_size as f64) * 100.0
            } else {
                100.0
            };
            let _ = app.emit(
                "hash-progress",
                serde_json::json!({
                    "taskId": task_id,
                    "progress": progress,
                    "bytesProcessed": total_read,
                    "totalBytes": file_size
                }),
            );
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

// ============================================
// 闹钟音频文件管理
// ============================================

#[derive(Serialize, Deserialize)]
struct AudioFileInfo {
    name: String,
    path: String,
    size: u64,
}

/// 扫描托管数据目录中的 Kits/Alarm 音频文件夹
#[tauri::command]
fn scan_audio_files(app: AppHandle) -> Result<Vec<AudioFileInfo>, String> {
    let audio_dir = app.state::<StorageManager>().layout()?.kits.join("Alarm");

    // 如果目录不存在，创建它
    if !audio_dir.exists() {
        fs::create_dir_all(&audio_dir).map_err(|e| format!("创建音频目录失败: {}", e))?;
    }

    let mut audio_files = Vec::new();

    // 支持的音频格式
    let supported_extensions = ["wav", "mp3", "ogg", "m4a"];

    // 读取目录
    let entries = fs::read_dir(&audio_dir).map_err(|e| format!("读取音频目录失败: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();

        // 只处理文件
        if path.is_file() {
            if let Some(ext) = path.extension() {
                let extension = ext.to_string_lossy().to_ascii_lowercase();

                // 检查是否为支持的音频格式
                if supported_extensions.contains(&extension.as_str()) {
                    let metadata = entry
                        .metadata()
                        .map_err(|e| format!("读取文件元数据失败: {}", e))?;

                    let file_name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("未知文件")
                        .to_string();

                    audio_files.push(AudioFileInfo {
                        name: file_name,
                        path: path.to_string_lossy().to_string(),
                        size: metadata.len(),
                    });
                }
            }
        }
    }

    // 按文件名排序
    audio_files.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(audio_files)
}

/// 打开音频文件夹
#[tauri::command]
fn open_audio_folder(app: AppHandle) -> Result<(), String> {
    let audio_dir = app.state::<StorageManager>().layout()?.kits.join("Alarm");

    // 如果目录不存在，创建它
    if !audio_dir.exists() {
        fs::create_dir_all(&audio_dir).map_err(|e| format!("创建音频目录失败: {}", e))?;
    }

    // 使用Windows资源管理器打开文件夹
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(audio_dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Err("此功能仅支持Windows系统".to_string());
    }

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
    // 如果已经在运行，不要重复启动
    if is_hotzone_running() {
        return Ok(());
    }

    let config = HotZoneConfig::default();
    let monitor = HotZoneMonitor::new(config);

    let app_handle = app.clone();
    monitor.start(move |show| {
        if show {
            if let Ok(window) = ensure_desktop_organizer_window(&app_handle) {
                if let Ok(monitor) = organizer_monitor(&window) {
                    let monitor_pos = monitor.position();
                    let scale_factor = monitor.scale_factor();
                    let margin_top = (10.0 * scale_factor) as i32;
                    let (stored_x, _stored_width) = get_hotzone_pos();
                    if stored_x >= 0 {
                        let panel_y = monitor_pos.y + margin_top;
                        let _ = window.set_position(PhysicalPosition::new(stored_x, panel_y));
                    }
                }
                let _ = fit_desktop_organizer_to_screen(&window);
                if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
                    update_hotzone_pos(position.x, size.width as i32);
                    update_panel_bounds(
                        position.x,
                        position.y,
                        size.width as i32,
                        size.height as i32,
                    );
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
        } else if let Some(window) = app_handle.get_webview_window("desktop-organizer") {
            if APP_SUSPENDED.load(Ordering::Relaxed) {
                let _ = window.close();
            } else {
                let _ = window.hide();
            }
        }
    });

    Ok(())
}

// 更新热区位置（从前端调用）
#[tauri::command]
fn update_hotzone_position(
    x: i32,
    width: i32,
    y: Option<i32>,
    height: Option<i32>,
) -> Result<(), String> {
    update_hotzone_pos(x, width);
    if let (Some(y), Some(height)) = (y, height) {
        update_panel_bounds(x, y, width, height);
    }
    Ok(())
}

#[tauri::command]
fn clamp_desktop_organizer_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("desktop-organizer")
        .ok_or_else(|| "桌面整理窗口尚未创建".to_string())?;
    fit_desktop_organizer_to_screen(&window)
}

// 停止桌面整理热区监听
#[tauri::command]
fn stop_hotzone(app: AppHandle) -> Result<(), String> {
    stop_hotzone_monitor();
    if let Some(window) = app.get_webview_window("desktop-organizer") {
        let _ = window.close();
    }
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
    if show {
        let window = ensure_desktop_organizer_window(&app)?;
        fit_desktop_organizer_to_screen(&window)?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else if let Some(window) = app.get_webview_window("desktop-organizer") {
        if APP_SUSPENDED.load(Ordering::Relaxed) {
            window.close().map_err(|e| e.to_string())?;
        } else {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 必须最先注册：第二个进程只负责唤醒现有窗口，不初始化托盘、快捷键或 WebView。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = ensure_main_window(app) {
                eprintln!("[SingleInstance] 恢复现有窗口失败: {error}");
            }
        }))
        .manage(AlarmScheduler::default())
        .manage(StorageManager::default())
        .manage(CleanupManager::default())
        .manage(JobManager::default())
        .manage(LocalSearchManager::default())
        .manage(TransferStationManager::default())
        .manage(ResourceGovernor::default())
        .manage(ShortcutRegistry::default())
        .manage(QuickHostManager::default())
        .manage(ScreenColorPickerManager::default())
        .manage(ScreenRegionCaptureManager::default())
        .manage(WhiteboardEditManager::default())
        .manage(PasswordVaultManager::default())
        .manage(SnippetManager::default())
        .manage(SystemAssistantManager::default())
        .manage(ToolModuleManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    handle_shortcut(app, shortcut, event.state());
                })
                .build(),
        )
        .setup(|app| {
            setup_tray(app)?;
            app.state::<StorageManager>()
                .initialize(app.handle())
                .map_err(std::io::Error::other)?;
            if let Err(error) = app.state::<ResourceGovernor>().restore(app.handle()) {
                eprintln!("[ResourceGovernor] 忽略无效的已保存策略: {error}");
            }
            if let Err(error) = app.state::<CleanupManager>().restore(app.handle()) {
                eprintln!("[CleanupManager] 忽略无效的已保存策略: {error}");
            }
            if let Err(error) = app.state::<ToolModuleManager>().restore(app.handle()) {
                eprintln!("[ToolModuleManager] 忽略无效的已保存配置: {error}");
            }
            if let Err(error) = app.state::<ShortcutRegistry>().restore(app.handle()) {
                eprintln!("[ShortcutRegistry] 忽略无效的已保存配置: {error}");
            }
            schedule_automatic_cleanup(app.handle());
            schedule_transfer_expiry_check(app.handle());
            // 注意：热区监听现在通过前端调用 start_hotzone_monitor 命令启动
            // 不再在启动时自动启动，由用户设置控制
            // 这样可以避免不必要的资源消耗
            let _ = app; // 消除未使用警告
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-main" => {
                if let Err(error) = ensure_main_window(app) {
                    eprintln!("[PowerLifecycle] {error}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|app, event| {
            let should_restore = matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } | TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            );
            if should_restore {
                if let Err(error) = ensure_main_window(app) {
                    eprintln!("[PowerLifecycle] {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Resized(_)) {
                let minimized = window.is_minimized().unwrap_or(false);
                let mode = window.state::<ResourceGovernor>().mode();
                let suspended = minimized && mode != MinimizeMode::Standard;
                let was_suspended = APP_SUSPENDED.swap(suspended, Ordering::Relaxed);
                if suspended != was_suspended {
                    emit_main_power_state(
                        window.app_handle(),
                        suspended,
                        minimized && mode == MinimizeMode::Deep,
                    );

                    if let Some(main_window) = window.app_handle().get_webview_window("main") {
                        set_webview_memory_target(
                            &main_window,
                            minimized && mode == MinimizeMode::Efficient,
                        );
                    }
                }

                if minimized {
                    if mode != MinimizeMode::Standard {
                        window
                            .state::<QuickHostManager>()
                            .release_now(window.app_handle());
                    }
                    if let Some(organizer_window) =
                        window.app_handle().get_webview_window("desktop-organizer")
                    {
                        if mode == MinimizeMode::Standard {
                            let _ = organizer_window.hide();
                        } else {
                            let _ = organizer_window.close();
                        }
                    }

                    if mode == MinimizeMode::Deep
                        && !DEEP_SLEEP_CLOSING.swap(true, Ordering::Relaxed)
                    {
                        window.state::<PasswordVaultManager>().release_idle_state();
                        let app = window.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                            if let Some(main_window) = app.get_webview_window("main") {
                                let _ = main_window.close();
                            }
                        });
                    }
                }
            }

            // 右上角关闭只进入托盘；真正退出只允许由托盘菜单触发。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                // 深度休眠由最小化流程主动销毁 WebView，此时允许窗口正常关闭。
                if DEEP_SLEEP_CLOSING.swap(false, Ordering::Relaxed) {
                    return;
                }

                let mode = window.state::<ResourceGovernor>().mode();
                let close_behavior = main_window_close_behavior(mode);
                let suspended = mode != MinimizeMode::Standard;
                APP_SUSPENDED.store(suspended, Ordering::Relaxed);
                emit_main_power_state(window.app_handle(), suspended, mode == MinimizeMode::Deep);

                let app = window.app_handle();
                if mode == MinimizeMode::Deep {
                    window.state::<PasswordVaultManager>().release_idle_state();
                }
                if mode == MinimizeMode::Standard {
                    if let Some(organizer_window) = app.get_webview_window("desktop-organizer") {
                        let _ = organizer_window.hide();
                    }
                } else {
                    window.state::<QuickHostManager>().release_now(app);
                    if let Some(organizer_window) = app.get_webview_window("desktop-organizer") {
                        let _ = organizer_window.close();
                    }
                }

                if close_behavior == MainWindowCloseBehavior::DestroyWebview {
                    // 销毁主 WebView，但 APP_SUSPENDED 会阻止无窗口时退出事件终止后端。
                    return;
                }

                api.prevent_close();
                if mode == MinimizeMode::Efficient {
                    if let Some(main_window) = app.get_webview_window("main") {
                        set_webview_memory_target(&main_window, true);
                    }
                }
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            write_qr_code,
            run_program,
            open_release_page,
            schedule_shutdown,
            lock_screen,
            calculate_text_hash,
            calculate_file_hash,
            open_file_location,
            open_file,
            scan_audio_files,
            open_audio_folder,
            sync_alarm_tasks,
            create_quick_countdown,
            search_local_files,
            open_local_search_result,
            take_missed_alarm_triggers,
            set_minimize_mode,
            get_storage_layout,
            get_storage_usage,
            migrate_storage_root,
            get_cleanup_status,
            set_automatic_cleanup_enabled,
            set_cleanup_retention_days,
            run_storage_cleanup,
            restore_latest_cleanup,
            preview_file_batch,
            start_file_batch,
            restore_file_batch,
            list_transfer_items,
            import_transfer_files,
            export_transfer_item,
            open_transfer_item,
            remove_transfer_item,
            restore_transfer_item,
            get_lan_share,
            start_lan_share,
            stop_lan_share,
            get_jobs,
            cancel_job,
            get_resource_policy,
            set_resource_policy,
            get_resource_snapshot,
            release_idle_resources,
            get_shortcut_bindings,
            replace_shortcut_bindings,
            open_quick_host,
            dismiss_quick_host,
            touch_quick_host_activity,
            list_whiteboards,
            load_whiteboard,
            save_whiteboard,
            save_whiteboard_draft,
            discard_whiteboard_draft,
            get_whiteboard_thumbnail,
            take_over_whiteboard_edit,
            release_whiteboard_edit,
            list_passwords,
            get_password_overview,
            get_password_detail,
            get_password_entry_for_edit,
            save_password_entry,
            remove_password_entry,
            restore_password_entry,
            empty_password_trash,
            preview_password_import,
            update_password_import_entry,
            commit_password_import,
            discard_password_import,
            copy_password,
            copy_password_field,
            open_password_url,
            set_password_favorite,
            audit_password_security,
            get_password_settings,
            set_password_settings,
            scan_system_startup_items,
            set_system_startup_enabled,
            reveal_system_startup_item,
            search_snippets,
            save_snippet,
            delete_snippet,
            start_screen_region_capture,
            get_screen_region_capture,
            finish_screen_region_capture,
            save_annotated_screenshot,
            start_screen_color_pick,
            get_screen_color_pick_capture,
            finish_screen_color_pick,
            get_tool_module_settings,
            set_tool_module_enabled,
            // 桌面整理命令
            desktop_scan,
            desktop_search,
            desktop_list_folder,
            desktop_open_file,
            desktop_locate_file,
            desktop_rename_file,
            desktop_get_file_path,
            desktop_get_path,
            desktop_get_icon,
            desktop_list_apps,
            desktop_save_app,
            desktop_reset_app,
            desktop_open_app,
            desktop_locate_app,
            desktop_get_app_icon,
            start_hotzone_monitor,
            stop_hotzone,
            get_hotzone_status,
            toggle_desktop_organizer,
            update_hotzone_position,
            clamp_desktop_organizer_window,
            get_screen_bounds,
            set_user_interacting
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                if APP_SUSPENDED.load(Ordering::Relaxed) {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod window_bounds_tests {
    use super::{fit_window_rect, main_window_close_behavior, MainWindowCloseBehavior};
    use crate::infrastructure::resources::MinimizeMode;
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn organizer_is_pulled_back_inside_a_small_primary_monitor() {
        let (position, size) = fit_window_rect(
            PhysicalPosition::new(1350, 10),
            PhysicalSize::new(550, 450),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1366, 768),
            12,
        );

        assert_eq!(position, PhysicalPosition::new(804, 12));
        assert_eq!(size, PhysicalSize::new(550, 450));
    }

    #[test]
    fn organizer_supports_negative_monitor_origins_and_oversized_preferences() {
        let (position, size) = fit_window_rect(
            PhysicalPosition::new(-2100, -50),
            PhysicalSize::new(2200, 1200),
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1920, 1080),
            12,
        );

        assert_eq!(position, PhysicalPosition::new(-1908, 12));
        assert_eq!(size, PhysicalSize::new(1896, 1056));
    }

    #[test]
    fn close_behavior_keeps_every_mode_alive_in_the_tray() {
        assert_eq!(
            main_window_close_behavior(MinimizeMode::Standard),
            MainWindowCloseBehavior::HideToTray
        );
        assert_eq!(
            main_window_close_behavior(MinimizeMode::Efficient),
            MainWindowCloseBehavior::HideToTray
        );
        assert_eq!(
            main_window_close_behavior(MinimizeMode::Deep),
            MainWindowCloseBehavior::DestroyWebview
        );
    }
}
