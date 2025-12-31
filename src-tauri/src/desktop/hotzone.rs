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
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT;
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{GetDC, ReleaseDC, GetDeviceCaps, HORZRES, VERTRES};

// 全局停止标志
lazy_static::lazy_static! {
    pub static ref HOTZONE_RUNNING: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
}

// 热区配置
#[derive(Clone)]
pub struct HotZoneConfig {
    pub right_offset: i32,   // 距右边缘距离 (0px，热区紧贴右边)
    pub top_offset: i32,     // 距顶边缘距离 (0px)
    pub width: i32,          // 热区宽度 (240px)
    pub height: i32,         // 热区高度 (5px)
    pub trigger_delay: u64,  // 触发延迟 (300ms)
    pub hide_delay: u64,     // 隐藏延迟 (200ms)
}

impl Default for HotZoneConfig {
    fn default() -> Self {
        Self {
            right_offset: 0,    // 紧贴右边缘
            top_offset: 0,
            width: 240,         // 宽 240px
            height: 5,          // 高 5px
            trigger_delay: 300,
            hide_delay: 200,
        }
    }
}

/// 检查坐标是否在热区内
pub fn is_in_hotzone(mouse_x: i32, mouse_y: i32, screen_width: i32, config: &HotZoneConfig) -> bool {
    let hotzone_left = screen_width - config.right_offset - config.width;
    let hotzone_right = screen_width - config.right_offset;
    let hotzone_top = config.top_offset;
    let hotzone_bottom = config.top_offset + config.height;
    
    mouse_x >= hotzone_left && mouse_x <= hotzone_right &&
    mouse_y >= hotzone_top && mouse_y <= hotzone_bottom
}

/// 检查坐标是否在侧边栏区域内
pub fn is_in_panel(mouse_x: i32, mouse_y: i32, panel_rect: (i32, i32, i32, i32)) -> bool {
    let (left, top, right, bottom) = panel_rect;
    mouse_x >= left && mouse_x <= right && mouse_y >= top && mouse_y <= bottom
}

/// 获取屏幕尺寸（修复内存泄漏）
#[cfg(target_os = "windows")]
pub fn get_screen_size() -> (i32, i32) {
    unsafe {
        let hdc = GetDC(None);
        let width = GetDeviceCaps(hdc, HORZRES);
        let height = GetDeviceCaps(hdc, VERTRES);
        // 重要：释放 DC，防止内存泄漏
        let _ = ReleaseDC(None, hdc);
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
            
            // 获取屏幕尺寸（只获取一次，减少资源消耗）
            let (screen_width, _screen_height) = get_screen_size();
            
            // 侧边栏位置在右侧（与热区位置一致）
            let panel_width = 550;
            let panel_height = 450;
            let panel_left = screen_width - panel_width - 75;  // 距右边缘 75px
            let panel_top = 10;
            let panel_rect = (
                panel_left,
                panel_top,
                panel_left + panel_width,
                panel_top + panel_height,
            );
            
            while HOTZONE_RUNNING.load(Ordering::SeqCst) {
                let (mouse_x, mouse_y) = get_mouse_position();
                
                let in_hotzone = is_in_hotzone(mouse_x, mouse_y, screen_width, &config);
                let in_panel = is_in_panel(mouse_x, mouse_y, panel_rect);
                
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
                        }
                    } else {
                        in_hotzone_since = None;
                    }
                } else {
                    // 面板已显示时，检测是否离开
                    if !in_panel && !in_hotzone {
                        if left_panel_since.is_none() {
                            left_panel_since = Some(Instant::now());
                        } else if left_panel_since.unwrap().elapsed().as_millis() >= config.hide_delay as u128 {
                            // 触发隐藏
                            is_panel_visible = false;
                            on_trigger(false);
                            left_panel_since = None;
                        }
                    } else {
                        left_panel_since = None;
                    }
                }
                
                // 降低检测频率：100ms（10fps），减少 CPU 占用
                thread::sleep(Duration::from_millis(100));
            }
            
            // 线程结束时隐藏面板
            if is_panel_visible {
                on_trigger(false);
            }
        });
    }
}

