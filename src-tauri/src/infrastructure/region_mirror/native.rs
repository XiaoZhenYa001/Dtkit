//! Each live mirror owns a small native message loop, which ends with the window.
//! A 1 Hz timer only checks window metadata; DWM independently presents pixels.
use super::{crop_fits, fit_content, source_crop, Rect, RegionMirrorManager};
use std::sync::OnceLock;
use tauri::{AppHandle, WebviewWindow};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{BOOL, COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::*;

const CONTROL: u32 = WM_APP + 51;
const STATUS_TIMER: usize = 1;
const CLASS: PCWSTR = w!("DtKitRegionMirror");

struct State {
    app: AppHandle,
    manager: RegionMirrorManager,
    id: u64,
    replace_id: Option<u64>,
    owner: Option<WebviewWindow>,
    selecting: bool,
    dragging: bool,
    start: POINT,
    end: POINT,
    origin: POINT,
    source: HWND,
    source_pid: u32,
    thumbnail: isize,
    crop: Rect,
    title: String,
    hint: String,
    status: &'static str,
    pinned: bool,
    compact: bool,
    click_through: bool,
    opacity: i32,
    error: Option<String>,
    dpi: u32,
    font: HFONT,
}

impl State {
    fn px(&self, value: i32) -> i32 {
        (value as i64 * self.dpi as i64 / 96) as i32
    }
    fn header(&self) -> i32 {
        if self.compact {
            0
        } else {
            self.px(36)
        }
    }

    fn publish(&self, hwnd: HWND) {
        {
            let mut sessions = self.manager.0.lock().unwrap_or_else(|e| e.into_inner());
            let finished_selection = sessions
                .entries
                .get(&self.id)
                .map(|entry| entry.status == "selecting" && !self.selecting)
                .unwrap_or(false);
            if finished_selection {
                sessions.selecting = false;
            }
            if let Some(entry) = sessions.entries.get_mut(&self.id) {
                entry.hwnd = hwnd.0 as usize;
                entry.title = self.title.clone();
                entry.width = self.crop.width();
                entry.height = self.crop.height();
                entry.status = self.status.into();
                entry.pinned = self.pinned;
                entry.compact = self.compact;
                entry.click_through = self.click_through;
                entry.opacity = self.opacity;
                entry.error = self.error.clone();
            }
        }
        self.manager.emit(&self.app);
    }

    fn restore_owner(&mut self, focus: bool) {
        if let Some(owner) = self.owner.take() {
            let _ = owner.show();
            if focus {
                let _ = owner.set_focus();
            }
        }
    }

    fn report(&mut self, hwnd: HWND, result: Result<(), String>) {
        self.error = result.err();
        self.publish(hwnd);
    }
}

impl Drop for State {
    fn drop(&mut self) {
        unsafe {
            if self.thumbnail != 0 {
                let _ = DwmUnregisterThumbnail(self.thumbnail);
            }
            if !self.font.is_invalid() {
                let _ = DeleteObject(self.font);
            }
        }
        self.restore_owner(true);
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn native_rect(value: Rect) -> RECT {
    RECT {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
    }
}
fn rect(value: RECT) -> Rect {
    Rect {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
    }
}
fn rgb(r: u32, g: u32, b: u32) -> COLORREF {
    COLORREF(r | (g << 8) | (b << 16))
}

pub(super) fn post(hwnd: usize, action: usize, value: i32) -> Result<(), String> {
    if hwnd == 0 {
        return Err("悬浮窗口正在启动，请稍后重试".into());
    }
    unsafe {
        PostMessageW(
            HWND(hwnd as *mut _),
            CONTROL,
            WPARAM(action),
            LPARAM(value as isize),
        )
    }
    .map_err(|e| format!("窗口操作失败: {e}"))
}

pub(super) fn run(
    app: AppHandle,
    manager: RegionMirrorManager,
    id: u64,
    replace_id: Option<u64>,
    owner: WebviewWindow,
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let mut state = Box::new(State {
            app,
            manager,
            id,
            replace_id,
            owner: Some(owner),
            selecting: true,
            dragging: false,
            start: POINT::default(),
            end: POINT::default(),
            origin: POINT::default(),
            source: HWND::default(),
            source_pid: 0,
            thumbnail: 0,
            crop: Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            title: "正在选择区域…".into(),
            hint: "拖动框选窗口中的区域 · Enter 确认 · Esc / 右键取消".into(),
            status: "selecting",
            pinned: true,
            compact: false,
            click_through: false,
            opacity: 100,
            error: None,
            dpi: 96,
            font: HFONT::default(),
        });
        match create_picker(&mut state) {
            Ok(hwnd) => {
                state.publish(hwnd);
                let _ = ready.send(Ok(()));
                let mut message = MSG::default();
                while GetMessageW(&mut message, HWND::default(), 0, 0).0 > 0 {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                if IsWindow(hwnd).as_bool() {
                    let _ = DestroyWindow(hwnd);
                }
            }
            Err(error) => {
                let _ = ready.send(Err(error));
            }
        }
    }
}

unsafe fn create_picker(state: &mut State) -> Result<HWND, String> {
    static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
    REGISTERED
        .get_or_init(|| {
            let class = WNDCLASSW {
                style: CS_DBLCLKS,
                lpfnWndProc: Some(window_proc),
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                lpszClassName: CLASS,
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                Err(format!(
                    "注册悬浮窗口失败: {}",
                    windows::core::Error::from_win32()
                ))
            } else {
                Ok(())
            }
        })
        .clone()?;
    state.origin = POINT {
        x: GetSystemMetrics(SM_XVIRTUALSCREEN),
        y: GetSystemMetrics(SM_YVIRTUALSCREEN),
    };
    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
        CLASS,
        w!("DtKit · 框选悬浮区域"),
        WS_POPUP,
        state.origin.x,
        state.origin.y,
        GetSystemMetrics(SM_CXVIRTUALSCREEN),
        GetSystemMetrics(SM_CYVIRTUALSCREEN),
        None,
        None,
        None,
        Some((state as *mut State).cast()),
    )
    .map_err(|e| format!("创建区域选择器失败: {e}"))?;
    // Keep the desktop live beneath a lightweight native selection overlay.
    // Color-key holes also pass mouse input to the source. Keep a translucent
    // surface across the whole desktop so clicking inside a previous selection
    // can start a new one without losing focus or activating the source app.
    if let Err(e) = SetLayeredWindowAttributes(hwnd, COLORREF(0), 110, LWA_ALPHA) {
        let _ = DestroyWindow(hwnd);
        return Err(format!("无法显示区域选择器: {e}"));
    }
    refresh_font(hwnd);
    let _ = ShowWindow(hwnd, SW_SHOW);
    let _ = SetForegroundWindow(hwnd);
    // The picker timeout is one-shot cleanup, never a screen-capture loop.
    SetTimer(hwnd, 2, 120_000, None);
    Ok(hwnd)
}

unsafe fn state_ptr(hwnd: HWND) -> *mut State {
    GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State
}

unsafe fn refresh_font(hwnd: HWND) {
    let s = &mut *state_ptr(hwnd);
    s.dpi = GetDpiForWindow(hwnd).max(96);
    if !s.font.is_invalid() {
        let _ = DeleteObject(s.font);
    }
    s.font = CreateFontW(
        -s.px(13),
        0,
        0,
        0,
        400,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        0,
        0,
        CLEARTYPE_QUALITY.0 as u32,
        0,
        w!("Microsoft YaHei UI"),
    );
}

struct Hit {
    point: POINT,
    result: HWND,
}

unsafe extern "system" fn find_source(hwnd: HWND, parameter: LPARAM) -> BOOL {
    let hit = &mut *(parameter.0 as *mut Hit);
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4);
    if cloaked != 0 {
        return BOOL(1);
    }
    let mut name = [0u16; 128];
    let count = GetClassNameW(hwnd, &mut name);
    let class = String::from_utf16_lossy(&name[..count.max(0) as usize]);
    if matches!(
        class.as_str(),
        "DtKitRegionMirror" | "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    ) {
        return BOOL(1);
    }
    let mut bounds = RECT::default();
    if GetWindowRect(hwnd, &mut bounds).is_ok() && rect(bounds).contains(hit.point.x, hit.point.y) {
        hit.result = hwnd;
        return BOOL(0);
    }
    BOOL(1)
}

unsafe fn source_at(point: POINT) -> HWND {
    let mut hit = Hit {
        point,
        result: HWND::default(),
    };
    let _ = EnumWindows(Some(find_source), LPARAM((&mut hit as *mut Hit) as isize));
    hit.result
}

unsafe fn begin_mirror(hwnd: HWND) -> Result<(), String> {
    let pointer = state_ptr(hwnd);
    let source = (*pointer).source;
    if !IsWindow(source).as_bool() {
        return Err("请在要悬浮的应用窗口内部开始框选".into());
    }
    let selection = Rect::from_points(
        ((*pointer).start.x, (*pointer).start.y),
        ((*pointer).end.x, (*pointer).end.y),
    );
    let mut bounds = RECT::default();
    GetWindowRect(source, &mut bounds).map_err(|_| "无法读取源窗口")?;
    let thumbnail =
        DwmRegisterThumbnail(hwnd, source).map_err(|e| format!("此窗口无法实时映射: {e}"))?;
    let setup = (|| -> Result<Rect, String> {
        let size = DwmQueryThumbnailSourceSize(thumbnail).map_err(|_| "无法读取源窗口尺寸")?;
        if size.cx <= 0 || size.cy <= 0 {
            return Err("源窗口当前没有可显示的画面".into());
        }
        // rcSource uses GetWindowRect coordinates, including invisible resize
        // borders. DwmQueryThumbnailSourceSize may exclude those borders, so
        // neither its size nor EXTENDED_FRAME_BOUNDS can choose the crop origin.
        source_crop(selection, rect(bounds))
    })();
    let crop = match setup {
        Ok(value) => value,
        Err(error) => {
            let _ = DwmUnregisterThumbnail(thumbnail);
            return Err(error);
        }
    };
    {
        let s = &mut *pointer;
        s.thumbnail = thumbnail;
        s.crop = crop;
        s.selecting = false;
        s.dragging = false;
        s.status = "live";
        let mut title = [0u16; 512];
        let count = GetWindowTextW(source, &mut title);
        s.title = String::from_utf16_lossy(&title[..count.max(0) as usize]);
        if s.title.is_empty() {
            s.title = "未命名窗口".into();
        }
        GetWindowThreadProcessId(source, Some(&mut s.source_pid));
    }
    let _ = ReleaseCapture();
    let _ = KillTimer(hwnd, 2);
    let _ = ShowWindow(hwnd, SW_HIDE);
    SetWindowLongPtrW(
        hwnd,
        GWL_EXSTYLE,
        (WS_EX_TOPMOST | WS_EX_TOOLWINDOW).0 as isize,
    );
    SetWindowLongPtrW(
        hwnd,
        GWL_STYLE,
        (WS_POPUP | WS_THICKFRAME | WS_SYSMENU).0 as isize,
    );
    let title = wide(&format!("区域悬浮 · {}", (*pointer).title));
    let _ = SetWindowTextW(hwnd, PCWSTR(title.as_ptr()));
    let mut monitor = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(
        MonitorFromPoint((*pointer).start, MONITOR_DEFAULTTONEAREST),
        &mut monitor,
    );
    let work = monitor.rcWork;
    let max_w = (work.right - work.left - 32).max(240);
    let max_h = (work.bottom - work.top - 32).max(140);
    let scale = (640.0 / crop.width() as f64)
        .min(1.0)
        .min(max_w as f64 / crop.width() as f64)
        .min((max_h - (*pointer).header()) as f64 / crop.height() as f64);
    let width = ((crop.width() as f64 * scale) as i32 + 2)
        .max((*pointer).px(260))
        .min(max_w);
    let height = ((crop.height() as f64 * scale) as i32 + (*pointer).header() + 1)
        .max((*pointer).px(140))
        .min(max_h);
    let x = (selection.right + 16)
        .min(work.right - width - 16)
        .max(work.left);
    let y = selection.top.min(work.bottom - height - 16).max(work.top);
    let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_FRAMECHANGED);
    (*pointer).restore_owner(false);
    let _ = ShowWindow(hwnd, SW_SHOW);
    let _ = SetForegroundWindow(hwnd);
    if let Err(error) = update_thumbnail(hwnd) {
        (*pointer).error = Some(error.clone());
        (*pointer).publish(hwnd);
        let _ = DestroyWindow(hwnd);
        return Err(error);
    }
    (*pointer).publish(hwnd);
    SetTimer(hwnd, STATUS_TIMER, 1000, None);
    // Keep the previous live region until its replacement is fully displayed.
    if let Some(replace_id) = (*pointer).replace_id.take() {
        let sessions = (*pointer)
            .manager
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = sessions.entries.get(&replace_id) {
            if let Err(error) = post(entry.hwnd, 2, 0) {
                drop(sessions);
                (*pointer).error = Some(format!("新区域已创建，关闭旧区域失败: {error}"));
                (*pointer).publish(hwnd);
            }
        }
    }
    Ok(())
}

unsafe fn update_thumbnail(hwnd: HWND) -> Result<(), String> {
    let s = &*state_ptr(hwnd);
    if s.selecting || s.thumbnail == 0 {
        return Ok(());
    }
    let mut bounds = RECT::default();
    let _ = GetClientRect(hwnd, &mut bounds);
    let destination = fit_content(
        bounds.right,
        bounds.bottom,
        s.crop.width(),
        s.crop.height(),
        s.header(),
    );
    let props = DWM_THUMBNAIL_PROPERTIES {
        dwFlags: DWM_TNP_RECTDESTINATION
            | DWM_TNP_RECTSOURCE
            | DWM_TNP_VISIBLE
            | DWM_TNP_OPACITY
            | DWM_TNP_SOURCECLIENTAREAONLY,
        rcDestination: native_rect(destination),
        rcSource: native_rect(s.crop),
        opacity: 255,
        fVisible: BOOL((s.status == "live" && !IsIconic(hwnd).as_bool()) as i32),
        fSourceClientAreaOnly: BOOL(0),
    };
    DwmUpdateThumbnailProperties(s.thumbnail, &props)
        .map_err(|e| format!("无法更新实时画面: {e}"))?;
    let _ = InvalidateRect(hwnd, None, false);
    Ok(())
}

unsafe fn check_source(hwnd: HWND) {
    let pointer = state_ptr(hwnd);
    let mut pid = 0;
    GetWindowThreadProcessId((*pointer).source, Some(&mut pid));
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(
        (*pointer).source,
        DWMWA_CLOAKED,
        (&mut cloaked as *mut u32).cast(),
        4,
    );
    let mut source_bounds = RECT::default();
    let bounds = GetWindowRect((*pointer).source, &mut source_bounds);
    let status = if !IsWindow((*pointer).source).as_bool() || pid != (*pointer).source_pid {
        "closed"
    } else if IsIconic((*pointer).source).as_bool() {
        "minimized"
    } else if !IsWindowVisible((*pointer).source).as_bool() || cloaked != 0 {
        "hidden"
    } else if bounds
        .map(|_| {
            !crop_fits(
                (*pointer).crop,
                source_bounds.right - source_bounds.left,
                source_bounds.bottom - source_bounds.top,
            )
        })
        .unwrap_or(true)
    {
        "resized"
    } else {
        "live"
    };
    let mut title_changed = false;
    if status != "closed" {
        let mut title = [0u16; 512];
        let count = GetWindowTextW((*pointer).source, &mut title);
        let title = String::from_utf16_lossy(&title[..count.max(0) as usize]);
        let title = if title.is_empty() {
            "未命名窗口".into()
        } else {
            title
        };
        if title != (*pointer).title {
            (*pointer).title = title;
            let value = wide(&format!("区域悬浮 · {}", (*pointer).title));
            let _ = SetWindowTextW(hwnd, PCWSTR(value.as_ptr()));
            title_changed = true;
        }
    }
    if status != (*pointer).status || title_changed {
        (*pointer).status = status;
        if let Err(error) = update_thumbnail(hwnd) {
            (*pointer).error = Some(error);
        }
        (*pointer).publish(hwnd);
    }
    if status == "closed" {
        let _ = KillTimer(hwnd, STATUS_TIMER);
        if (*pointer).thumbnail != 0 {
            let _ = DwmUnregisterThumbnail((*pointer).thumbnail);
            (*pointer).thumbnail = 0;
        }
    }
}

unsafe fn fill(dc: HDC, bounds: &RECT, color: COLORREF) {
    let brush = CreateSolidBrush(color);
    FillRect(dc, bounds, brush);
    let _ = DeleteObject(brush);
}

unsafe fn text(dc: HDC, value: &str, mut bounds: RECT, color: COLORREF, flags: DRAW_TEXT_FORMAT) {
    SetTextColor(dc, color);
    let mut value: Vec<u16> = value.encode_utf16().collect();
    DrawTextW(dc, &mut value, &mut bounds, flags | DT_NOPREFIX);
}

unsafe fn paint(hwnd: HWND) {
    let s = &*state_ptr(hwnd);
    let mut ps = PAINTSTRUCT::default();
    let dc = BeginPaint(hwnd, &mut ps);
    let mut bounds = RECT::default();
    let _ = GetClientRect(hwnd, &mut bounds);
    let old = SelectObject(dc, s.font);
    SetBkMode(dc, TRANSPARENT);
    fill(dc, &bounds, rgb(18, 21, 29));
    if s.selecting {
        let selected = Rect::from_points(
            (s.start.x - s.origin.x, s.start.y - s.origin.y),
            (s.end.x - s.origin.x, s.end.y - s.origin.y),
        );
        if selected.width() > 0 && selected.height() > 0 {
            let selection = native_rect(selected);
            fill(dc, &selection, rgb(58, 77, 68));
            let brush = CreateSolidBrush(rgb(129, 233, 194));
            FrameRect(dc, &selection, brush);
            let _ = DeleteObject(brush);
        }
        // Anchor help to the pointer's monitor, not the virtual desktop center.
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(
            MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST),
            &mut info,
        );
        let left = (info.rcWork.left - s.origin.x + 24).max(0);
        let top = (info.rcWork.top - s.origin.y + 24).max(0);
        let help = RECT {
            left,
            top,
            right: (left + s.px(660)).min(bounds.right),
            bottom: top + s.px(64),
        };
        fill(dc, &help, rgb(10, 12, 18));
        let label = format!(
            "{}\n{} × {} 像素 · 松开后可重新框选",
            s.hint,
            selected.width(),
            selected.height()
        );
        let label_bounds = RECT {
            left: help.left + 12,
            top: help.top + 8,
            right: help.right - 12,
            bottom: help.bottom - 4,
        };
        text(
            dc,
            &label,
            label_bounds,
            rgb(239, 246, 250),
            DT_LEFT | DT_WORDBREAK,
        );
    } else {
        let header = s.header();
        if header > 0 {
            let toolbar = RECT {
                bottom: header,
                ..bounds
            };
            fill(dc, &toolbar, rgb(32, 37, 47));
            let button = s.px(52);
            let title_bounds = RECT {
                left: s.px(12),
                top: 0,
                right: (bounds.right - button * 3 - 6).max(12),
                bottom: header,
            };
            text(
                dc,
                &s.title,
                title_bounds,
                rgb(217, 225, 232),
                DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS,
            );
            for (index, label) in [if s.pinned { "已置顶" } else { "置顶" }, "源窗口", "×"]
                .iter()
                .enumerate()
            {
                let area = RECT {
                    left: bounds.right - button * (3 - index as i32),
                    top: 0,
                    right: bounds.right - button * (2 - index as i32),
                    bottom: header,
                };
                text(
                    dc,
                    label,
                    area,
                    if index == 0 && s.pinned {
                        rgb(132, 226, 193)
                    } else {
                        rgb(225, 232, 239)
                    },
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                );
            }
        }
        let hint = match s.status {
            "minimized" => "源窗口已最小化\n按 Enter 恢复源窗口后继续播放",
            "hidden" => "源窗口当前不可见\n按 Enter 返回源窗口",
            "resized" => "选区超出源窗口边界\n放大源窗口，或在工具页重新框选",
            "closed" => "源窗口已关闭\n请关闭此悬浮窗并重新框选",
            _ if s.error.is_some() => "操作未完成\n请在工具页查看详情或重试",
            _ => "",
        };
        if !hint.is_empty() {
            let area = RECT {
                left: 12,
                top: header + (bounds.bottom - header) / 2 - s.px(24),
                right: bounds.right - 12,
                bottom: bounds.bottom,
            };
            text(dc, hint, area, rgb(213, 222, 230), DT_CENTER | DT_WORDBREAK);
        }
    }
    SelectObject(dc, old);
    let _ = EndPaint(hwnd, &ps);
}

unsafe fn activate_source(hwnd: HWND) -> Result<(), String> {
    let source = (*state_ptr(hwnd)).source;
    let mut pid = 0;
    GetWindowThreadProcessId(source, Some(&mut pid));
    if pid != (*state_ptr(hwnd)).source_pid || !IsWindow(source).as_bool() {
        return Err("源窗口已关闭，请重新框选".into());
    }
    if IsIconic(source).as_bool() {
        let _ = ShowWindowAsync(source, SW_RESTORE);
    } else if !IsWindowVisible(source).as_bool() {
        let _ = ShowWindowAsync(source, SW_SHOW);
    }
    if !SetForegroundWindow(source).as_bool() {
        return Err("系统未允许切换到源窗口，请从任务栏打开它".into());
    }
    Ok(())
}

unsafe fn toggle_pin(hwnd: HWND) -> Result<(), String> {
    let pointer = state_ptr(hwnd);
    let pinned = !(*pointer).pinned;
    let z = if pinned { HWND_TOPMOST } else { HWND_NOTOPMOST };
    SetWindowPos(
        hwnd,
        z,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    )
    .map_err(|e| format!("无法更改置顶状态: {e}"))?;
    (*pointer).pinned = pinned;
    let _ = InvalidateRect(hwnd, None, false);
    Ok(())
}

unsafe fn toggle_compact(hwnd: HWND) -> Result<(), String> {
    let pointer = state_ptr(hwnd);
    (*pointer).compact = !(*pointer).compact;
    place_mirror(hwnd, None)
}

unsafe fn work_area(hwnd: HWND) -> RECT {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info).as_bool() {
        info.rcWork
    } else {
        RECT {
            left: 0,
            top: 0,
            right: GetSystemMetrics(SM_CXSCREEN),
            bottom: GetSystemMetrics(SM_CYSCREEN),
        }
    }
}

unsafe fn place_mirror(hwnd: HWND, scale: Option<i32>) -> Result<(), String> {
    let pointer = state_ptr(hwnd);
    let work = work_area(hwnd);
    let mut bounds = RECT::default();
    GetWindowRect(hwnd, &mut bounds).map_err(|e| format!("无法读取悬浮窗位置: {e}"))?;
    let max_w = (work.right - work.left - 16).max(1);
    let max_h = (work.bottom - work.top - 16).max(1);
    let (width, height) = if let Some(percent) = scale {
        let factor = if percent == 0 {
            (640.0 / (*pointer).crop.width() as f64).min(1.0)
        } else {
            percent as f64 / 100.0
        };
        let factor = factor
            .min((max_w - 2).max(1) as f64 / (*pointer).crop.width() as f64)
            .min((max_h - (*pointer).header() - 1).max(1) as f64 / (*pointer).crop.height() as f64);
        (
            ((*pointer).crop.width() as f64 * factor).round() as i32 + 2,
            ((*pointer).crop.height() as f64 * factor).round() as i32 + (*pointer).header() + 1,
        )
    } else {
        (bounds.right - bounds.left, bounds.bottom - bounds.top)
    };
    let minimum_width = if (*pointer).compact { 120 } else { 180 };
    let width = width.max((*pointer).px(minimum_width)).min(max_w);
    let height = height
        .max((*pointer).header() + (*pointer).px(48))
        .min(max_h);
    let x = bounds.left.clamp(work.left, work.right - width);
    let y = bounds.top.clamp(work.top, work.bottom - height);
    SetWindowPos(
        hwnd,
        None,
        x,
        y,
        width,
        height,
        SWP_NOZORDER | SWP_NOACTIVATE,
    )
    .map_err(|e| format!("无法调整悬浮窗大小或位置: {e}"))?;
    update_thumbnail(hwnd)
}

unsafe fn apply_visuals(hwnd: HWND, click_through: bool, opacity: i32) -> Result<(), String> {
    let pointer = state_ptr(hwnd);
    let old_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    let mut style = old_style as u32 & !(WS_EX_LAYERED | WS_EX_TRANSPARENT).0;
    if click_through || opacity < 100 {
        style |= WS_EX_LAYERED.0;
    }
    if click_through {
        style |= WS_EX_TRANSPARENT.0;
    }
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);
    if style & WS_EX_LAYERED.0 != 0 {
        if let Err(error) =
            SetLayeredWindowAttributes(hwnd, COLORREF(0), (opacity * 255 / 100) as u8, LWA_ALPHA)
        {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, old_style);
            return Err(format!("无法应用透明度或鼠标穿透: {error}"));
        }
    }
    (*pointer).click_through = click_through;
    (*pointer).opacity = opacity;
    update_thumbnail(hwnd)
}

unsafe fn control(hwnd: HWND, action: usize, value: i32) {
    let pointer = state_ptr(hwnd);
    if (*pointer).selecting {
        match action {
            1 => {
                let _ = ShowWindow(hwnd, SW_SHOW);
                let _ = SetForegroundWindow(hwnd);
            }
            2 => {
                let _ = DestroyWindow(hwnd);
            }
            _ => {}
        }
        return;
    }
    let result = match action {
        1 => {
            let visuals = apply_visuals(hwnd, false, (*pointer).opacity);
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let placement = place_mirror(hwnd, None);
            let _ = SetForegroundWindow(hwnd);
            visuals.and(placement)
        }
        2 => {
            let _ = DestroyWindow(hwnd);
            return;
        }
        3 => activate_source(hwnd),
        4 => toggle_pin(hwnd),
        5 => toggle_compact(hwnd),
        6 => apply_visuals(hwnd, !(*pointer).click_through, (*pointer).opacity),
        7 if (30..=100).contains(&value) => apply_visuals(hwnd, (*pointer).click_through, value),
        8 if matches!(value, 50 | 100 | 150 | 200) => place_mirror(hwnd, Some(value)),
        9 => {
            (*pointer).compact = false;
            let result = apply_visuals(hwnd, false, 100);
            if result.is_ok() {
                place_mirror(hwnd, Some(0))
            } else {
                result
            }
        }
        _ => Err("不支持的悬浮窗口操作".into()),
    };
    (*pointer).report(hwnd, result);
}

unsafe fn menu(hwnd: HWND) {
    let menu = match CreatePopupMenu() {
        Ok(menu) => menu,
        Err(_) => return,
    };
    let s = &*state_ptr(hwnd);
    let _ = AppendMenuW(
        menu,
        MF_STRING | if s.pinned { MF_CHECKED } else { MF_UNCHECKED },
        1,
        w!("置顶\tP"),
    );
    let _ = AppendMenuW(
        menu,
        MF_STRING | if s.compact { MF_CHECKED } else { MF_UNCHECKED },
        2,
        w!("纯画面模式\tC"),
    );
    let _ = AppendMenuW(menu, MF_STRING, 3, w!("返回源窗口\tEnter / 双击"));
    let _ = AppendMenuW(
        menu,
        MF_STRING
            | if s.click_through {
                MF_CHECKED
            } else {
                MF_UNCHECKED
            },
        6,
        w!("鼠标穿透（从工具页恢复）\tT"),
    );
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    let _ = AppendMenuW(menu, MF_STRING, 50, w!("缩放 50%\t1"));
    let _ = AppendMenuW(menu, MF_STRING, 100, w!("缩放 100%\t2"));
    let _ = AppendMenuW(menu, MF_STRING, 150, w!("缩放 150%\t3"));
    let _ = AppendMenuW(menu, MF_STRING, 9, w!("恢复默认外观\tR"));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    let _ = AppendMenuW(menu, MF_STRING, 4, w!("关闭悬浮窗\tEsc"));
    let mut point = POINT::default();
    let _ = GetCursorPos(&mut point);
    // No Rust reference to State is held across this nested message loop.
    let command = TrackPopupMenu(
        menu,
        TPM_RETURNCMD | TPM_RIGHTBUTTON,
        point.x,
        point.y,
        0,
        hwnd,
        None,
    )
    .0;
    let _ = DestroyMenu(menu);
    match command {
        1 => control(hwnd, 4, 0),
        2 => control(hwnd, 5, 0),
        3 => control(hwnd, 3, 0),
        6 => control(hwnd, 6, 0),
        9 => control(hwnd, 9, 0),
        50 | 100 | 150 => control(hwnd, 8, command as i32),
        4 => {
            let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        _ => {}
    }
}

unsafe fn hit_test(hwnd: HWND, parameter: LPARAM) -> LRESULT {
    let s = &*state_ptr(hwnd);
    if s.selecting {
        return LRESULT(HTCLIENT as isize);
    }
    if s.click_through {
        return LRESULT(HTTRANSPARENT as isize);
    }
    let mut point = POINT {
        x: parameter.0 as i16 as i32,
        y: (parameter.0 >> 16) as i16 as i32,
    };
    let _ = ScreenToClient(hwnd, &mut point);
    let mut bounds = RECT::default();
    let _ = GetClientRect(hwnd, &mut bounds);
    let edge = s.px(6);
    let left = point.x < edge;
    let right = point.x >= bounds.right - edge;
    let top = point.y < edge;
    let bottom = point.y >= bounds.bottom - edge;
    let result = match (left, right, top, bottom) {
        (true, _, true, _) => HTTOPLEFT,
        (_, true, true, _) => HTTOPRIGHT,
        (true, _, _, true) => HTBOTTOMLEFT,
        (_, true, _, true) => HTBOTTOMRIGHT,
        (true, _, _, _) => HTLEFT,
        (_, true, _, _) => HTRIGHT,
        (_, _, true, _) => HTTOP,
        (_, _, _, true) => HTBOTTOM,
        _ if point.y < s.header() && point.x >= bounds.right - s.px(52) * 3 => HTCLIENT,
        _ => HTCAPTION,
    };
    LRESULT(result as isize)
}

// State is owned by run() until GetMessage exits. Never keep &mut State across
// Win32 operations that can synchronously re-enter this callback (resize/show).
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    let pointer = state_ptr(hwnd);
    if pointer.is_null() {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    match message {
        WM_NCCALCSIZE => return LRESULT(0),
        WM_ERASEBKGND => return LRESULT(1),
        WM_PAINT => {
            paint(hwnd);
            return LRESULT(0);
        }
        WM_NCHITTEST => return hit_test(hwnd, lparam),
        WM_GETMINMAXINFO if !(*pointer).selecting => {
            let limits = &mut *(lparam.0 as *mut MINMAXINFO);
            limits.ptMinTrackSize = POINT {
                x: (*pointer).px(if (*pointer).compact { 120 } else { 180 }),
                y: (*pointer).header() + (*pointer).px(48),
            };
            return LRESULT(0);
        }
        WM_SETCURSOR if (*pointer).selecting => {
            SetCursor(LoadCursorW(None, IDC_CROSS).unwrap_or_default());
            return LRESULT(1);
        }
        WM_LBUTTONDOWN if (*pointer).selecting => {
            let mut point = POINT::default();
            let _ = GetCursorPos(&mut point);
            (*pointer).start = point;
            (*pointer).end = point;
            (*pointer).dragging = true;
            (*pointer).source = source_at(point);
            (*pointer).hint = if (*pointer).source.is_invalid() {
                "未找到应用窗口，请在窗口内部框选"
            } else {
                "拖动框选窗口中的区域 · Enter 确认 · Esc / 右键取消"
            }
            .into();
            SetCapture(hwnd);
            let _ = InvalidateRect(hwnd, None, false);
            return LRESULT(0);
        }
        WM_MOUSEMOVE if (*pointer).selecting && (*pointer).dragging => {
            let _ = GetCursorPos(&mut (*pointer).end);
            let _ = InvalidateRect(hwnd, None, false);
            return LRESULT(0);
        }
        WM_LBUTTONUP if (*pointer).selecting => {
            if (*pointer).dragging {
                let _ = GetCursorPos(&mut (*pointer).end);
            }
            (*pointer).dragging = false;
            let _ = ReleaseCapture();
            let _ = InvalidateRect(hwnd, None, false);
            return LRESULT(0);
        }
        WM_CAPTURECHANGED => {
            (*pointer).dragging = false;
        }
        WM_LBUTTONUP if !(*pointer).selecting => {
            let x = lparam.0 as i16 as i32;
            let y = (lparam.0 >> 16) as i16 as i32;
            let mut bounds = RECT::default();
            let _ = GetClientRect(hwnd, &mut bounds);
            if y < (*pointer).header() {
                let button = (*pointer).px(52);
                if x >= bounds.right - button {
                    let _ = DestroyWindow(hwnd);
                } else if x >= bounds.right - button * 2 {
                    control(hwnd, 3, 0);
                } else if x >= bounds.right - button * 3 {
                    control(hwnd, 4, 0);
                }
            }
            return LRESULT(0);
        }
        WM_NCLBUTTONDBLCLK if !(*pointer).selecting => {
            control(hwnd, 3, 0);
            return LRESULT(0);
        }
        WM_KEYDOWN => {
            match wparam.0 {
                27 => {
                    let _ = DestroyWindow(hwnd);
                }
                13 if (*pointer).selecting => {
                    if let Err(error) = begin_mirror(hwnd) {
                        (*pointer).hint = error;
                        let _ = InvalidateRect(hwnd, None, false);
                    }
                }
                13 => control(hwnd, 3, 0),
                80 if !(*pointer).selecting => control(hwnd, 4, 0),
                67 if !(*pointer).selecting => control(hwnd, 5, 0),
                84 if !(*pointer).selecting => control(hwnd, 6, 0),
                82 if !(*pointer).selecting => control(hwnd, 9, 0),
                49 if !(*pointer).selecting => control(hwnd, 8, 50),
                50 if !(*pointer).selecting => control(hwnd, 8, 100),
                51 if !(*pointer).selecting => control(hwnd, 8, 150),
                107 | 187 if !(*pointer).selecting => control(hwnd, 8, 150),
                109 | 189 if !(*pointer).selecting => control(hwnd, 8, 50),
                _ => {}
            }
            return LRESULT(0);
        }
        WM_RBUTTONUP | WM_NCRBUTTONUP | WM_CONTEXTMENU => {
            if (*pointer).selecting {
                let _ = DestroyWindow(hwnd);
            } else {
                menu(hwnd);
            }
            return LRESULT(0);
        }
        WM_DPICHANGED => {
            refresh_font(hwnd);
            if !(*pointer).selecting {
                let area = *(lparam.0 as *const RECT);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    area.left,
                    area.top,
                    area.right - area.left,
                    area.bottom - area.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
                if let Err(error) = place_mirror(hwnd, None) {
                    (*pointer).error = Some(error);
                    (*pointer).publish(hwnd);
                }
            }
            return LRESULT(0);
        }
        WM_SIZE => {
            if !(*pointer).selecting {
                let result = update_thumbnail(hwnd);
                if let Err(error) = result {
                    (*pointer).error = Some(error);
                    (*pointer).publish(hwnd);
                }
            }
        }
        WM_TIMER if wparam.0 == STATUS_TIMER => {
            check_source(hwnd);
            return LRESULT(0);
        }
        WM_TIMER if wparam.0 == 2 && (*pointer).selecting => {
            let _ = DestroyWindow(hwnd);
            return LRESULT(0);
        }
        CONTROL => {
            control(hwnd, wparam.0, lparam.0 as i32);
            return LRESULT(0);
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            return LRESULT(0);
        }
        WM_DESTROY => {
            let _ = KillTimer(hwnd, STATUS_TIMER);
            let _ = KillTimer(hwnd, 2);
            if (*pointer).thumbnail != 0 {
                let _ = DwmUnregisterThumbnail((*pointer).thumbnail);
                (*pointer).thumbnail = 0;
            }
            PostQuitMessage(0);
            return LRESULT(0);
        }
        WM_NCDESTROY => {
            // Invalidate the control handle before Windows can recycle it.
            {
                let mut sessions = (*pointer)
                    .manager
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if let Some(entry) = sessions.entries.get_mut(&(*pointer).id) {
                    entry.hwnd = 0;
                }
            }
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}
