//! Animate the complete classic HWND, including its opaque WebView background.
//! No renderer acknowledgement is needed to finish hiding the window.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, PhysicalPosition, WebviewWindow};

static REDUCED_MOTION: AtomicBool = AtomicBool::new(false);
static READY_WINDOW: AtomicIsize = AtomicIsize::new(0);
static MOTION: Mutex<MotionState> = Mutex::new(MotionState {
    revision: 0,
    key: 0,
    rest: (0, 0),
    progress: 0.0,
    target: false,
    running: false,
});

struct MotionState {
    revision: u64,
    key: isize,
    rest: (i32, i32),
    progress: f64,
    target: bool,
    running: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisibilityEvent {
    visible: bool,
    phase: &'static str,
    revision: u64,
}

fn emit(window: &WebviewWindow, visible: bool, phase: &'static str, revision: u64) {
    let _ = window.emit(
        "desktop-organizer-visibility",
        VisibilityEvent {
            visible,
            phase,
            revision,
        },
    );
}

// The drawer curve used by the frontend motion tokens: (0.32, 0.72, 0, 1).
fn eased_progress(time: f64) -> f64 {
    if time <= 0.0 || time >= 1.0 {
        return time.clamp(0.0, 1.0);
    }
    let mut lo: f64 = 0.0;
    let mut hi: f64 = 1.0;
    for _ in 0..16 {
        let t = (lo + hi) * 0.5;
        let x = 3.0 * (1.0 - t).powi(2) * t * 0.32 + t.powi(3);
        if x < time {
            lo = t;
        } else {
            hi = t;
        }
    }
    let t = (lo + hi) * 0.5;
    3.0 * (1.0 - t).powi(2) * t * 0.72 + 3.0 * (1.0 - t) * t.powi(2) + t.powi(3)
}

#[cfg(windows)]
fn platform_reduced_motion() -> bool {
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    let mut enabled = BOOL(1);
    unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some((&mut enabled as *mut BOOL).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
            && !enabled.as_bool()
    }
}

#[cfg(not(windows))]
fn platform_reduced_motion() -> bool {
    false
}

#[cfg(windows)]
fn window_key(window: &WebviewWindow) -> Result<isize, String> {
    window
        .hwnd()
        .map(|hwnd| hwnd.0 as isize)
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn window_key(_window: &WebviewWindow) -> Result<isize, String> {
    Ok(1)
}

#[cfg(windows)]
fn paint(
    window: &WebviewWindow,
    rest: (i32, i32),
    progress: f64,
    travel: f64,
) -> Result<(), String> {
    use windows::Win32::Foundation::{COLORREF, HWND};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos,
        GWL_EXSTYLE, LWA_ALPHA, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_LAYERED,
    };
    let hwnd = HWND(window.hwnd().map_err(|error| error.to_string())?.0);
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if style & WS_EX_LAYERED.0 as isize == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as isize);
        }
        SetLayeredWindowAttributes(
            hwnd,
            COLORREF(0),
            (progress * 255.0).round() as u8,
            LWA_ALPHA,
        )
        .map_err(|error| format!("分类侧栏透明度更新失败: {error}"))?;
        SetWindowPos(
            hwnd,
            HWND::default(),
            rest.0,
            rest.1 - ((1.0 - progress) * travel).round() as i32,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(|error| error.to_string())
    }
}

#[cfg(not(windows))]
fn paint(
    window: &WebviewWindow,
    rest: (i32, i32),
    progress: f64,
    travel: f64,
) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(
            rest.0,
            rest.1 - ((1.0 - progress) * travel).round() as i32,
        ))
        .map_err(|error| error.to_string())
}

pub(crate) fn set_reduced_motion(reduced: bool) {
    REDUCED_MOTION.store(reduced, Ordering::Release);
}

pub(crate) fn mark_ready(window: &WebviewWindow) {
    if let Ok(key) = window_key(window) {
        READY_WINDOW.store(key, Ordering::Release);
    }
}

pub(crate) fn is_transitioning(window: &WebviewWindow) -> bool {
    window_key(window).ok().is_some_and(|key| {
        MOTION
            .lock()
            .map(|state| state.key == key && state.running)
            .unwrap_or(false)
    })
}

/// Mode handoffs invalidate delayed first shows and restore the resting geometry.
pub(crate) fn cancel(window: &WebviewWindow) {
    let Ok(key) = window_key(window) else {
        return;
    };
    let was_visible = window.is_visible().unwrap_or(false);
    let rest = MOTION.lock().ok().and_then(|mut state| {
        if state.key != key || !state.running {
            return None;
        }
        state.revision = state.revision.wrapping_add(1);
        state.running = false;
        state.target = false;
        state.progress = 0.0;
        // A hidden pending first show has not painted anything; its initial
        // rest may predate the frontend restoring saved geometry.
        was_visible.then_some(state.rest)
    });
    if let Some((x, y)) = rest {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

pub(crate) async fn request_visible(window: WebviewWindow, show: bool) -> Result<(), String> {
    let app = window.app_handle().clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(set_visible(&window, show));
    })
    .map_err(|error| error.to_string())?;
    receive
        .await
        .map_err(|_| "分类侧栏窗口线程已结束".to_string())?
}

/// Call on the UI thread. Reversals start at the most recently painted position.
pub(crate) fn set_visible(window: &WebviewWindow, show: bool) -> Result<(), String> {
    let key = window_key(window)?;
    let visible = window.is_visible().unwrap_or(false);
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let (revision, from, rest) = {
        let mut state = MOTION.lock().map_err(|_| "分类侧栏动效状态不可用")?;
        if state.key == key && state.running && state.target == show {
            return Ok(());
        }
        let continuing = state.key == key && state.running;
        let from = if continuing {
            state.progress
        } else if visible {
            1.0
        } else {
            0.0
        };
        let rest = if continuing {
            state.rest
        } else {
            (position.x, position.y)
        };
        state.revision = state.revision.wrapping_add(1);
        state.key = key;
        state.rest = rest;
        state.progress = from;
        state.target = show;
        state.running = true;
        (state.revision, from, rest)
    };
    let target = if show { 1.0 } else { 0.0 };
    if show && !visible && READY_WINDOW.load(Ordering::Acquire) != key {
        // A new hidden WebView restores its saved size/position before entering.
        // Do not fight those IPC geometry updates on the first animation frames.
        let app = window.app_handle().clone();
        let waiting_window = window.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            while READY_WINDOW.load(Ordering::Acquire) != key
                && started.elapsed() < Duration::from_millis(1500)
            {
                std::thread::sleep(Duration::from_millis(16));
            }
            let _ = app.run_on_main_thread(move || {
                let current = MOTION
                    .lock()
                    .map(|mut state| {
                        if state.revision != revision || state.key != key || !state.target {
                            return false;
                        }
                        state.running = false;
                        true
                    })
                    .unwrap_or(false);
                if current {
                    READY_WINDOW.store(key, Ordering::Release);
                    let _ = set_visible(&waiting_window, true);
                }
            });
        });
        return Ok(());
    }
    let reduced = REDUCED_MOTION.load(Ordering::Acquire) || platform_reduced_motion();
    let travel = if reduced {
        0.0
    } else {
        24.0 * window.scale_factor().unwrap_or(1.0)
    };
    // Prepare the native opacity before ShowWindow so its first frame is transparent.
    if let Err(error) = paint(window, rest, from, travel) {
        eprintln!("[ClassicMotion] 原生动画不可用，恢复直接显示: {error}");
        if let Ok(mut state) = MOTION.lock() {
            state.running = false;
            state.progress = target;
        }
        let _ = window.set_position(PhysicalPosition::new(rest.0, rest.1));
        if show {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        } else {
            window.hide().map_err(|error| error.to_string())?;
        }
        emit(window, show, if show { "open" } else { "closed" }, revision);
        return Ok(());
    }
    if show {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    emit(
        window,
        show,
        if show { "opening" } else { "closing" },
        revision,
    );
    let duration = if reduced {
        0.0
    } else {
        (if show { 220.0 } else { 180.0 }) * (target - from).abs()
    };
    let app = window.app_handle().clone();
    let frame_window = window.clone();
    let started = Instant::now();
    std::thread::spawn(move || loop {
        let window = frame_window.clone();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        if app
            .run_on_main_thread(move || {
                let current = MOTION
                    .lock()
                    .map(|state| state.key == key && state.revision == revision && state.running)
                    .unwrap_or(false);
                if !current {
                    let _ = send.send(false);
                    return;
                }
                let time = if duration == 0.0 || REDUCED_MOTION.load(Ordering::Acquire) {
                    1.0
                } else {
                    (started.elapsed().as_secs_f64() * 1000.0 / duration).min(1.0)
                };
                let progress = from + (target - from) * eased_progress(time);
                let painted = paint(&window, rest, progress, travel).is_ok();
                let done = time >= 1.0 || !painted;
                if let Ok(mut state) = MOTION.lock() {
                    if state.key != key || state.revision != revision {
                        let _ = send.send(false);
                        return;
                    }
                    state.progress = if done { target } else { progress };
                    state.running = !done;
                } else {
                    let _ = send.send(false);
                    return;
                }
                if done {
                    if !show {
                        let _ = window.hide();
                    }
                    let _ = window.set_position(PhysicalPosition::new(rest.0, rest.1));
                    let _ = paint(&window, rest, target, 0.0);
                    emit(
                        &window,
                        show,
                        if show { "open" } else { "closed" },
                        revision,
                    );
                }
                let _ = send.send(!done);
            })
            .is_err()
        {
            break;
        }
        if !receive.recv().unwrap_or(false) {
            break;
        }
        std::thread::sleep(Duration::from_millis(16));
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::eased_progress;

    #[test]
    fn drawer_curve_is_monotonic_and_has_exact_endpoints() {
        assert_eq!(eased_progress(0.0), 0.0);
        assert_eq!(eased_progress(1.0), 1.0);
        let values = (0..=100)
            .map(|step| eased_progress(step as f64 / 100.0))
            .collect::<Vec<_>>();
        assert!(values.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(eased_progress(0.5) > 0.9);
    }
}
