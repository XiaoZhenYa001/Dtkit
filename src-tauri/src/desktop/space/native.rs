use super::{DesktopDisplay, PixelRect};
use std::hash::{Hash, Hasher};
use tauri::WebviewWindow;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_EXCLUDED_FROM_PEEK};
use windows::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, EnumDisplayMonitors, GetMonitorInfoW,
    SetWindowRgn, HDC, HMONITOR, MONITORINFOEXW, RGN_ERROR, RGN_OR,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetClassNameW, GetWindowLongPtrW,
    GetWindowThreadProcessId, IsWindow, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, GWLP_HWNDPARENT, HWND_BOTTOM, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WINDOWPOS, WM_NCDESTROY,
    WM_WINDOWPOSCHANGING, WS_CAPTION, WS_CHILD, WS_THICKFRAME, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX,
    WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_WINDOWEDGE, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_POPUP,
};

const DESKTOP_Z_ORDER_SUBCLASS: usize = 0x44544b53;

unsafe extern "system" fn keep_desktop_z_order(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, id: usize, _: usize) -> LRESULT {
    if message == WM_WINDOWPOSCHANGING && lparam.0 != 0 {
        let position = &mut *(lparam.0 as *mut WINDOWPOS);
        // Activation may focus the editor, but must never lift the desktop
        // furniture above unrelated application windows.
        if position.hwndInsertAfter != HWND_BOTTOM { position.flags |= SWP_NOZORDER; }
    } else if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(window, Some(keep_desktop_z_order), id);
    }
    DefSubclassProc(window, message, wparam, lparam)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Desktop {
    pub(super) parent: usize,
    icons: usize,
    explorer_pid: u32,
    work: PixelRect,
    layout_stamp: u64,
}

impl Desktop {
    pub(super) fn width(self) -> i32 { self.work.right - self.work.left }
    pub(super) fn height(self) -> i32 { self.work.bottom - self.work.top }
}

fn hwnd(raw: usize) -> HWND { HWND(raw as *mut std::ffi::c_void) }

fn class_name(window: HWND) -> String {
    let mut buffer = [0_u16; 128];
    let length = unsafe { GetClassNameW(window, &mut buffer) }.max(0) as usize;
    String::from_utf16_lossy(&buffer[..length])
}

unsafe extern "system" fn find_desktop_callback(window: HWND, data: LPARAM) -> BOOL {
    // Explorer can move SHELLDLL_DefView from Progman to a WorkerW. Find the
    // current desktop rather than spawning or assuming a particular WorkerW.
    let class = class_name(window);
    if class != "Progman" && class != "WorkerW" { return BOOL(1); }
    if let Ok(view) = FindWindowExW(window, HWND::default(), w!("SHELLDLL_DefView"), PCWSTR::null()) {
        if let Ok(icons) = FindWindowExW(view, HWND::default(), w!("SysListView32"), PCWSTR::null()) {
            let found = &mut *(data.0 as *mut Option<(usize, usize)>);
            *found = Some((window.0 as usize, icons.0 as usize));
            return BOOL(0);
        }
    }
    BOOL(1)
}

#[derive(Clone)]
struct DisplayWork { id: String, work: PixelRect, primary: bool }

unsafe extern "system" fn collect_display(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(monitor, &mut info.monitorInfo).as_bool() {
        let RECT { left, top, right, bottom } = info.monitorInfo.rcWork;
        if right > left && bottom > top {
            let length = info.szDevice.iter().position(|item| *item == 0).unwrap_or(info.szDevice.len());
            let displays = &mut *(data.0 as *mut Vec<DisplayWork>);
            displays.push(DisplayWork { id: String::from_utf16_lossy(&info.szDevice[..length]), work: PixelRect { left, top, right, bottom }, primary: info.monitorInfo.dwFlags & 1 != 0 });
        }
    }
    BOOL(1)
}

fn display_work_areas() -> Result<Vec<DisplayWork>, String> {
    let mut displays: Vec<DisplayWork> = Vec::new();
    unsafe { let _ = EnumDisplayMonitors(HDC::default(), None, Some(collect_display), LPARAM(&mut displays as *mut _ as isize)); }
    if displays.is_empty() { return Err("无法读取显示器工作区域".into()); }
    displays.sort_by(|left, right| right.primary.cmp(&left.primary).then_with(|| left.id.cmp(&right.id)));
    Ok(displays)
}

fn virtual_work(displays: &[DisplayWork]) -> PixelRect {
    PixelRect { left: displays.iter().map(|item| item.work.left).min().unwrap_or(0), top: displays.iter().map(|item| item.work.top).min().unwrap_or(0),
        right: displays.iter().map(|item| item.work.right).max().unwrap_or(0), bottom: displays.iter().map(|item| item.work.bottom).max().unwrap_or(0) }
}

pub(super) fn logical_displays(scale: f64) -> Result<Vec<DesktopDisplay>, String> {
    let displays = display_work_areas()?;
    let virtual_area = virtual_work(&displays);
    Ok(displays.into_iter().map(|item| DesktopDisplay { id: item.id,
        x: (item.work.left - virtual_area.left) as f64 / scale, y: (item.work.top - virtual_area.top) as f64 / scale,
        width: (item.work.right - item.work.left) as f64 / scale, height: (item.work.bottom - item.work.top) as f64 / scale }).collect())
}

pub(super) fn find_desktop() -> Result<Desktop, String> {
    let mut found: Option<(usize, usize)> = None;
    unsafe {
        let _ = EnumWindows(Some(find_desktop_callback), LPARAM(&mut found as *mut _ as isize));
        let (parent, icons) = found.ok_or("Explorer 桌面尚未就绪")?;
        let mut explorer_pid = 0;
        GetWindowThreadProcessId(hwnd(parent), Some(&mut explorer_pid));
        let displays = display_work_areas()?;
        let work = virtual_work(&displays);
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        for item in &displays { item.id.hash(&mut hash); [item.work.left, item.work.top, item.work.right, item.work.bottom].hash(&mut hash); }
        Ok(Desktop { parent, icons, explorer_pid, work, layout_stamp: hash.finish() })
    }
}

fn window_hwnd(window: &WebviewWindow) -> Result<HWND, String> {
    window.hwnd().map(|native| HWND(native.0)).map_err(|error| error.to_string())
}

pub(super) fn window_exists(window: &WebviewWindow) -> bool {
    window_hwnd(window).map(|handle| unsafe { IsWindow(handle).as_bool() }).unwrap_or(false)
}

pub(super) fn attach(window: &WebviewWindow, desktop: &Desktop) -> Result<(), String> {
    let child = window_hwnd(window)?;
    unsafe {
        if !IsWindow(hwnd(desktop.parent)).as_bool() { return Err("Explorer 桌面已重新启动".into()); }
        let style = GetWindowLongPtrW(child, GWL_STYLE) as u32;
        // Tao's transparent HWND uses DwmEnableBlurBehindWindow, which Windows
        // supports only on top-level windows. Explorer-child WebViews lose that
        // alpha surface and paint their otherwise-transparent area black.
        // Tao keeps caption bits on an undecorated top-level HWND and suppresses
        // its non-client area in WM_NCCALCSIZE. Changing a shaped window region
        // can still make DWM paint that frame as a pale strip above the controls.
        // This permanent desktop surface has no native frame to paint.
        let frame = WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0;
        SetWindowLongPtrW(child, GWL_STYLE, ((style & !(WS_CHILD.0 | frame)) | WS_POPUP.0) as isize);
        let extended = GetWindowLongPtrW(child, GWL_EXSTYLE) as u32;
        let edges = WS_EX_WINDOWEDGE.0 | WS_EX_CLIENTEDGE.0 | WS_EX_DLGMODALFRAME.0;
        SetWindowLongPtrW(child, GWL_EXSTYLE, ((extended & !(WS_EX_TOPMOST.0 | WS_EX_APPWINDOW.0 | edges)) | WS_EX_TOOLWINDOW.0) as isize);
        SetWindowLongPtrW(child, GWLP_HWNDPARENT, desktop.parent as isize);
        SetWindowPos(child, HWND_BOTTOM, desktop.work.left, desktop.work.top, desktop.width(), desktop.height(), SWP_NOACTIVATE | SWP_FRAMECHANGED)
            .map_err(|error| format!("定位桌面空间失败: {error}"))?;
        if !SetWindowSubclass(child, Some(keep_desktop_z_order), DESKTOP_Z_ORDER_SUBCLASS, 0).as_bool() {
            return Err("无法固定桌面空间层级".into());
        }
        let excluded = BOOL(1);
        let _ = DwmSetWindowAttribute(child, DWMWA_EXCLUDED_FROM_PEEK, &excluded as *const _ as *const _, std::mem::size_of::<BOOL>() as u32);
    }
    Ok(())
}

pub(super) fn set_region(window: &WebviewWindow, rectangles: &[PixelRect]) -> Result<(), String> {
    let child = window_hwnd(window)?;
    unsafe {
        let union = CreateRectRgn(0, 0, 0, 0);
        if union.is_invalid() { return Err("无法创建桌面交互区域".into()); }
        for rect in rectangles {
            let cell = CreateRectRgn(rect.left, rect.top, rect.right, rect.bottom);
            if cell.is_invalid() {
                let _ = DeleteObject(union);
                return Err("无法创建桌面交互区域".into());
            }
            let combined = CombineRgn(union, union, cell, RGN_OR);
            let _ = DeleteObject(cell);
            if combined == RGN_ERROR {
                let _ = DeleteObject(union);
                return Err("无法合并桌面交互区域".into());
            }
        }
        // Windows takes ownership on success; never delete a transferred HRGN.
        if SetWindowRgn(child, union, true) == 0 {
            let _ = DeleteObject(union);
            return Err("无法应用桌面交互区域".into());
        }
    }
    Ok(())
}

pub(super) fn show(window: &WebviewWindow) {
    if let Ok(window) = window_hwnd(window) { unsafe { let _ = ShowWindow(window, SW_SHOWNOACTIVATE); } }
}

#[derive(Debug)]
pub(super) struct Attachment { desktop: Desktop }

impl Attachment {
    pub(super) fn new(desktop: Desktop) -> Self { Self { desktop } }
    pub(super) fn matches(&self, desktop: &Desktop) -> bool { self.desktop == *desktop }
}
