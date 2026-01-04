// 热区监听模块
// Hot Zone Monitor - 监听鼠标位置触发侧边栏
// 
// 修复说明：
// 1. GetDC 需要配对 ReleaseDC 释放资源
// 2. 降低检测频率到 50ms（20fps）减少 CPU 占用
// 3. 添加全局停止机制

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT;

// 全局停止标志
lazy_static::lazy_static! {
    pub static ref HOTZONE_RUNNING: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    // 用户交互标志：当用户正在拖动或调整窗口大小时，不应该隐藏窗口
    pub static ref USER_INTERACTING: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
}

// 热区配置
#[derive(Clone)]
pub struct HotZoneConfig {
    pub top_offset: i32,     // 距顶边缘距离 (0px)
    pub width: i32,          // 热区宽度 (300px)
    pub height: i32,         // 热区高度 (5px)
    pub trigger_delay: u64,  // 触发延迟 (300ms)
    pub hide_delay: u64,     // 隐藏延迟 (500ms)
}

impl Default for HotZoneConfig {
    fn default() -> Self {
        Self {
            top_offset: 0,
            width: 500,         // 宽 300px
            height: 10,          // 高 10px (从3px改为10px，更容易触发)
            trigger_delay: 300,
            hide_delay: 500,
        }
    }
}

// 全局热区位置（用于动态更新）
lazy_static::lazy_static! {
    pub static ref HOTZONE_X_POSITION: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);
    pub static ref HOTZONE_WIDTH: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(300);
}

/// 更新热区位置
pub fn update_hotzone_pos(x: i32, width: i32) {
    HOTZONE_X_POSITION.store(x, std::sync::atomic::Ordering::SeqCst);
    HOTZONE_WIDTH.store(width, std::sync::atomic::Ordering::SeqCst);
}

/// 获取当前热区位置
pub fn get_hotzone_pos() -> (i32, i32) {
    (
        HOTZONE_X_POSITION.load(std::sync::atomic::Ordering::SeqCst),
        HOTZONE_WIDTH.load(std::sync::atomic::Ordering::SeqCst),
    )
}

/// 检查坐标是否在热区内
pub fn is_in_hotzone(mouse_x: i32, mouse_y: i32, screen_width: i32, config: &HotZoneConfig) -> bool {
    let (stored_x, stored_width) = get_hotzone_pos();
    
    // 计算热区位置 - 只考虑顶部边缘的热区
    let (hotzone_left, hotzone_width) = if stored_x >= 0 {
        // 使用存储的位置，热区居中于窗口
        let center_x = stored_x + stored_width / 2;
        let hz_width = config.width;
        (center_x - hz_width / 2, hz_width)
    } else {
        // 默认位置：屏幕右侧
        (screen_width - config.width, config.width)
    };
    
    let hotzone_right = hotzone_left + hotzone_width;
    let hotzone_top = config.top_offset;
    let hotzone_bottom = config.top_offset + config.height;
    
    // 精确判断：鼠标必须在热区范围内
    mouse_x >= hotzone_left && mouse_x <= hotzone_right &&
    mouse_y >= hotzone_top && mouse_y <= hotzone_bottom
}

/// 检查坐标是否在侧边栏区域内（动态计算，更宽松的判断用于保持显示）
pub fn is_in_panel_dynamic(mouse_x: i32, mouse_y: i32, primary_width: i32, primary_height: i32) -> bool {
    let (stored_x, stored_width) = get_hotzone_pos();
    
    // 面板区域参数 - 稍微扩大边界以提供更好的体验
    let panel_height = 800;  // 覆盖面板高度
    let edge_margin = 30;    // 边缘容错边距
    
    let (panel_left, panel_right) = if stored_x >= 0 {
        // 使用存储的位置，左右各留容错边距
        (stored_x - edge_margin, stored_x + stored_width + edge_margin)
    } else {
        // 默认：屏幕右侧
        let panel_width = 800;
        (primary_width - panel_width - edge_margin, primary_width + edge_margin)
    };
    
    let panel_top = -10; // 顶部容错
    let panel_bottom = (panel_top + panel_height).min(primary_height);
    
    mouse_x >= panel_left && mouse_x <= panel_right &&
    mouse_y >= panel_top && mouse_y <= panel_bottom
}

/// 获取屏幕尺寸（使用虚拟屏幕尺寸，支持多显示器）
#[cfg(target_os = "windows")]
pub fn get_screen_size() -> (i32, i32) {
    unsafe {
        // SM_CXVIRTUALSCREEN/SM_CYVIRTUALSCREEN 返回虚拟屏幕尺寸（所有显示器的合并区域）
        // 这对于鼠标位置检测更准确
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        // 如果虚拟屏幕尺寸无效，回退到主屏幕尺寸
        if width <= 0 || height <= 0 {
            let width = GetSystemMetrics(SM_CXSCREEN);
            let height = GetSystemMetrics(SM_CYSCREEN);
            return (width, height);
        }
        (width, height)
    }
}

/// 获取主屏幕尺寸
#[cfg(target_os = "windows")]
pub fn get_primary_screen_size() -> (i32, i32) {
    unsafe {
        let width = GetSystemMetrics(SM_CXSCREEN);
        let height = GetSystemMetrics(SM_CYSCREEN);
        (width, height)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_screen_size() -> (i32, i32) {
    (1920, 1080) // 默认值
}

/// 获取当前鼠标位置
#[cfg(target_os = "windows")]
pub fn get_mouse_position() -> (i32, i32) {
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        (point.x, point.y)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_mouse_position() -> (i32, i32) {
    (0, 0)
}

/// 停止全局热区监听
pub fn stop_hotzone_monitor() {
    HOTZONE_RUNNING.store(false, Ordering::SeqCst);
}

/// 检查热区监听是否运行中
pub fn is_hotzone_running() -> bool {
    HOTZONE_RUNNING.load(Ordering::SeqCst)
}

/// 设置用户交互状态
pub fn set_user_interacting(interacting: bool) {
    USER_INTERACTING.store(interacting, Ordering::SeqCst);
}

/// 检查用户是否正在交互
pub fn is_user_interacting() -> bool {
    USER_INTERACTING.load(Ordering::SeqCst)
}

/// 热区监听器状态
pub struct HotZoneMonitor {
    config: HotZoneConfig,
}

impl HotZoneMonitor {
    pub fn new(config: HotZoneConfig) -> Self {
        Self { config }
    }

    /// 启动热区监听
    pub fn start<F>(&self, on_trigger: F)
    where
        F: Fn(bool) + Send + 'static,
    {
        // 如果已经在运行，不要重复启动
        if HOTZONE_RUNNING.load(Ordering::SeqCst) {
            return;
        }
        
        let config = self.config.clone();
        HOTZONE_RUNNING.store(true, Ordering::SeqCst);
        
        thread::spawn(move || {
            let mut in_hotzone_since: Option<Instant> = None;
            let mut is_panel_visible = false;
            let mut left_panel_since: Option<Instant> = None;
            let mut consecutive_outside_checks = 0; // 连续在外部的检测次数
            
            // 获取主屏幕尺寸
            let (primary_width, primary_height) = get_primary_screen_size();
            
            while HOTZONE_RUNNING.load(Ordering::SeqCst) {
                let (mouse_x, mouse_y) = get_mouse_position();
                
                let in_hotzone = is_in_hotzone(mouse_x, mouse_y, primary_width, &config);
                // 使用动态面板检测（根据保存的窗口位置）
                let in_panel = is_in_panel_dynamic(mouse_x, mouse_y, primary_width, primary_height);
                
                if !is_panel_visible {
                    // 面板未显示时，检测热区
                    if in_hotzone {
                        if in_hotzone_since.is_none() {
                            in_hotzone_since = Some(Instant::now());
                        } else if in_hotzone_since.unwrap().elapsed().as_millis() >= config.trigger_delay as u128 {
                            // 触发显示
                            is_panel_visible = true;
                            on_trigger(true);
                            in_hotzone_since = None;
                            consecutive_outside_checks = 0;
                        }
                    } else {
                        in_hotzone_since = None;
                    }
                } else {
                    // 面板已显示时，检测是否离开
                    // 关键修复：如果用户正在交互（拖动/调整大小），不要隐藏窗口
                    let user_interacting = is_user_interacting();
                    
                    if !in_panel && !in_hotzone && !user_interacting {
                        // 增加连续检测计数，避免误触发
                        consecutive_outside_checks += 1;
                        
                        if left_panel_since.is_none() && consecutive_outside_checks >= 2 {
                            // 至少连续2次检测都在外部才开始计时
                            left_panel_since = Some(Instant::now());
                        } else if let Some(since) = left_panel_since {
                            if since.elapsed().as_millis() >= config.hide_delay as u128 {
                                // 触发隐藏
                                is_panel_visible = false;
                                on_trigger(false);
                                left_panel_since = None;
                                consecutive_outside_checks = 0;
                            }
                        }
                    } else {
                        // 鼠标回到面板或热区，或者用户正在交互，重置计数器
                        left_panel_since = None;
                        consecutive_outside_checks = 0;
                    }
                }
                
                // 优化检测频率：100ms（10fps），在响应性和性能间取得平衡
                thread::sleep(Duration::from_millis(100));
            }
            
            // 线程结束时隐藏面板
            if is_panel_visible {
                on_trigger(false);
            }
        });
    }
}

