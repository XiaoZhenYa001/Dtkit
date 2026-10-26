//! Keep the native blur surface and the WebView on the same rounded outline.
#[cfg(windows)]
#[path = "space_composition.rs"]
mod composition;
#[cfg(windows)]
pub(crate) fn configure(window: &tauri::WebviewWindow) -> Result<(), String> {
    // Window creation can return to a blocking worker; subclass installation
    // must run on the thread that owns the HWND. Tauri executes this inline
    // when the caller already is the UI thread.
    let (sender, receiver) = std::sync::mpsc::channel();
    let surface = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(configure_on_ui(&surface));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("桌面空间外观更新未完成: {error}"))?
}

#[cfg(windows)]
fn configure_on_ui(window: &tauri::WebviewWindow) -> Result<(), String> {
    use std::mem::size_of_val;
    use windows::Win32::{
        Foundation::{BOOL, HWND},
        Graphics::{
            Dwm::{
                DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
                DWMWA_NCRENDERING_POLICY, DWMWA_TRANSITIONS_FORCEDISABLED,
                DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
            },
            Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ},
        },
        UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_MAXIMIZEBOX,
            WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
        },
    };
    let handle = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd = HWND(handle.0);
    unsafe {
        if !windows::Win32::UI::Shell::SetWindowSubclass(
            hwnd,
            Some(surface_proc),
            SURFACE_SUBCLASS,
            0,
        )
        .as_bool()
        {
            return Err("无法关闭桌面空间的系统边框绘制".into());
        }
    }
    // Composition can invalidate its clipping surface. Apply it before removing
    // native chrome and installing the final outline, including on DPI changes.
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let available = match apply_live_glass(hwnd).and_then(|_| {
        composition::configure(hwnd, size.width, size.height, (28.0 * scale) as f32)
            .map_err(|error| error.to_string())
    }) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("桌面空间背景模糊不可用: {error}");
            false
        }
    };
    // A transparent WebView without native scattering cannot protect text from
    // the windows behind it. Let the shared material use its opaque fallback.
    use tauri::Emitter;
    let _ = window.emit(
        "desktop-space-material",
        serde_json::json!({ "available": available }),
    );
    unsafe {
        // Tao retains caption/control style bits even on undecorated windows.
        // Accent composition can expose that non-client strip. Remove it from
        // the actual HWND, not just from the framework's decoration setting.
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let chrome =
            (WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU).0 as isize;
        if style & chrome != 0 {
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !chrome);
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|error| error.to_string())?;
        }
    }
    let diameter = (56.0 * scale).round().max(2.0) as i32;
    unsafe {
        // DWM's optional outline/rounding uses a different radius from our glass.
        // Older Windows versions may not support these hints; the region below
        // supplies the actual clipping on both Windows 10 and 11.
        let border = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &border as *const _ as _,
            size_of_val(&border) as u32,
        );
        let corner = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner as *const _ as _,
            size_of_val(&corner) as u32,
        );
        let nonclient = DWMNCRP_DISABLED;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_NCRENDERING_POLICY,
            &nonclient as *const _ as _,
            size_of_val(&nonclient) as u32,
        );
        let disabled = BOOL(1);
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &disabled as *const _ as _,
            size_of_val(&disabled) as u32,
        );
        let region = CreateRoundRectRgn(
            0,
            0,
            size.width as i32 + 1,
            size.height as i32 + 1,
            diameter,
            diameter,
        );
        if region.0.is_null() {
            return Err("创建桌面空间圆角失败".into());
        }
        if SetWindowRgn(hwnd, region, true) == 0 {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return Err("应用桌面空间圆角失败".into());
        }
        // Windows owns the region after a successful SetWindowRgn call.
    }
    Ok(())
}

#[cfg(windows)]
const SURFACE_SUBCLASS: usize = 0x4454_4b47;

/// Choose legible ink from a few desktop pixels while the launcher is hidden.
/// No screenshot is retained, and sampling never includes the launcher's text.
#[cfg(windows)]
pub(crate) fn background_contrast(
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
) -> Option<(bool, Vec<f64>)> {
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
    unsafe {
        let dc = GetDC(None);
        if dc.is_invalid() {
            return None;
        }
        let mut luminance = 0.0;
        let mut count = 0;
        // 9 x 5 samples keep sharp changes between neighboring windows local.
        let mut grid = Vec::with_capacity(45);
        for row in 0..5 {
            let y = 0.05 + f64::from(row) * 0.225;
            for column in 0..9 {
                let x = 0.05 + f64::from(column) * 0.1125;
                let pixel = GetPixel(
                    dc,
                    position.x + (size.width as f64 * x) as i32,
                    position.y + (size.height as f64 * y) as i32,
                )
                .0;
                if pixel == u32::MAX {
                    grid.push(f64::NAN);
                    continue;
                }
                let linear = |channel: u32| {
                    let value = (channel & 255) as f64 / 255.0;
                    if value <= 0.04045 {
                        value / 12.92
                    } else {
                        ((value + 0.055) / 1.055).powf(2.4)
                    }
                };
                let value = 0.2126 * linear(pixel)
                    + 0.7152 * linear(pixel >> 8)
                    + 0.0722 * linear(pixel >> 16);
                luminance += value;
                grid.push(value);
                count += 1;
            }
        }
        let _ = ReleaseDC(None, dc);
        (count > 0).then(|| {
            let average = luminance / f64::from(count);
            for value in &mut grid {
                if !value.is_finite() {
                    *value = average;
                }
            }
            (average > 0.28, grid)
        })
    }
}

#[cfg(windows)]
unsafe extern "system" fn surface_proc(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::{
        Foundation::{LPARAM, LRESULT},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass},
            WindowsAndMessaging::{WM_ERASEBKGND, WM_NCACTIVATE, WM_NCDESTROY, WM_NCPAINT},
        },
    };
    match message {
        // There is no native frame. Default painting can leave a light caption
        // strip or rectangular class-brush fill beneath the transparent WebView.
        WM_NCPAINT => LRESULT(0),
        WM_ERASEBKGND => LRESULT(1),
        // Keep Tao's activation/focus bookkeeping, while telling DefWindowProc
        // not to repaint a non-client area (the documented -1 LPARAM behavior).
        WM_NCACTIVATE => DefSubclassProc(hwnd, message, wparam, LPARAM(-1)),
        WM_NCDESTROY => {
            composition::release(hwnd);
            let _ = RemoveWindowSubclass(hwnd, Some(surface_proc), SURFACE_SUBCLASS);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, message, wparam, lparam),
    }
}

#[cfg(windows)]
fn apply_live_glass(hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
    use std::{
        ffi::c_void,
        mem::{size_of, transmute},
    };
    use windows::{
        core::{s, w},
        Win32::{
            Foundation::{BOOL, HWND},
            System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
        },
    };
    #[repr(C)]
    struct AccentPolicy {
        state: i32,
        flags: u32,
        color: u32,
        animation: u32,
    }
    #[repr(C)]
    struct CompositionData {
        attribute: u32,
        data: *const c_void,
        size: usize,
    }
    type SetComposition = unsafe extern "system" fn(HWND, *const CompositionData) -> BOOL;
    unsafe {
        let module = GetModuleHandleW(w!("user32.dll")).map_err(|error| error.to_string())?;
        let procedure = GetProcAddress(module, s!("SetWindowCompositionAttribute"))
            .ok_or("背景合成接口不可用")?;
        let set_composition: SetComposition = transmute(procedure);
        // Host backdrop exposes the desktop only to the explicitly clipped
        // composition visual. Accent blur (state 3) paints an independent
        // rectangular tint/noise layer outside the HWND's rounded region.
        let policy = AccentPolicy {
            state: 5,
            flags: 0,
            color: 0,
            animation: 0,
        };
        let data = CompositionData {
            attribute: 19,
            data: &policy as *const _ as _,
            size: size_of::<AccentPolicy>(),
        };
        if !set_composition(hwnd, &data).as_bool() {
            return Err("Windows 未启用背景模糊".into());
        }
    }
    Ok(())
}
