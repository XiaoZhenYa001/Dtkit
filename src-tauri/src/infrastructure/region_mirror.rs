//! Live window regions. Pixels stay in DWM: no capture loop, encoder, or WebView.
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(target_os = "windows")]
#[path = "region_mirror/native.rs"]
mod native;

const MAX_MIRRORS: usize = 6;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MirrorInfo {
    id: u64,
    title: String,
    width: i32,
    height: i32,
    pinned: bool,
    status: String,
    #[serde(skip)]
    hwnd: usize,
}

#[derive(Default)]
struct Sessions {
    next_id: u64,
    selecting: bool,
    entries: BTreeMap<u64, MirrorInfo>,
}

#[derive(Default, Clone)]
pub(crate) struct RegionMirrorManager(Arc<Mutex<Sessions>>);

impl RegionMirrorManager {
    pub(crate) fn has_active_mirrors(&self) -> bool {
        self.0
            .lock()
            .map(|sessions| !sessions.entries.is_empty())
            .unwrap_or(true)
    }

    fn snapshot(&self) -> Vec<MirrorInfo> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .values()
            .cloned()
            .collect()
    }

    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("region-mirrors-changed", self.snapshot());
    }

    fn reserve(&self) -> Result<u64, String> {
        let mut sessions = self.0.lock().map_err(|_| "悬浮窗口状态不可用")?;
        if sessions.selecting {
            return Err("请先完成当前选区，或按 Esc 取消".into());
        }
        if sessions.entries.len() >= MAX_MIRRORS {
            return Err("最多同时打开 6 个悬浮窗口，请先关闭不需要的窗口".into());
        }
        sessions.next_id += 1;
        let id = sessions.next_id;
        sessions.selecting = true;
        sessions.entries.insert(
            id,
            MirrorInfo {
                id,
                title: "正在选择区域…".into(),
                width: 0,
                height: 0,
                pinned: true,
                status: "selecting".into(),
                hwnd: 0,
            },
        );
        Ok(id)
    }

    fn remove(&self, id: u64, app: &AppHandle) {
        let mut sessions = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = sessions.entries.remove(&id) {
            if entry.status == "selecting" {
                sessions.selecting = false;
            }
        }
        drop(sessions);
        self.emit(app);
        let app_handle = app.clone();
        tauri::async_runtime::spawn(super::launch::finish_tool_only_if_idle(app_handle));
    }
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" && !window.label().starts_with("quick-host-") {
        return Err("当前窗口不能管理区域悬浮".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn list_region_mirrors(
    window: WebviewWindow,
    manager: tauri::State<'_, RegionMirrorManager>,
) -> Result<Vec<MirrorInfo>, String> {
    authorize(&window)?;
    Ok(manager.snapshot())
}

#[tauri::command]
pub(crate) async fn start_region_mirror(
    window: WebviewWindow,
    manager: tauri::State<'_, RegionMirrorManager>,
) -> Result<(), String> {
    authorize(&window)?;
    if !window
        .app_handle()
        .state::<super::tool_modules::ToolModuleManager>()
        .is_enabled("region-mirror")
    {
        return Err("区域悬浮工具已停用".into());
    }
    #[cfg(target_os = "windows")]
    {
        let id = manager.reserve()?;
        let app = window.app_handle().clone();
        if let Err(error) = window.hide() {
            manager.remove(id, &app);
            return Err(format!("无法进入选区: {error}"));
        }
        manager.emit(&app);
        let manager_clone = (*manager).clone();
        let thread_app = app.clone();
        let owner = window.clone();
        let (ready, result) = tokio::sync::oneshot::channel();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("region-mirror-{id}"))
            .spawn(move || {
                native::run(thread_app.clone(), manager_clone.clone(), id, owner, ready);
                manager_clone.remove(id, &thread_app);
            })
        {
            manager.remove(id, &app);
            let _ = window.show();
            return Err(format!("无法启动选区: {error}"));
        }
        result.await.map_err(|_| "区域悬浮启动失败".to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("区域悬浮当前仅支持 Windows".into())
    }
}

#[tauri::command]
pub(crate) fn control_region_mirror(
    window: WebviewWindow,
    manager: tauri::State<'_, RegionMirrorManager>,
    id: u64,
    action: String,
) -> Result<(), String> {
    authorize(&window)?;
    let message = match action.as_str() {
        "show" => 1,
        "close" => 2,
        "source" => 3,
        "pin" => 4,
        _ => return Err("不支持的悬浮窗口操作".into()),
    };
    // Hold the registry lock through PostMessage so WM_NCDESTROY cannot recycle
    // the HWND between lookup and posting. Never synchronously send under it.
    let sessions = manager.0.lock().map_err(|_| "悬浮窗口状态不可用")?;
    let entry = sessions.entries.get(&id).ok_or("悬浮窗口已关闭")?;
    #[cfg(target_os = "windows")]
    {
        native::post(entry.hwnd, message)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (entry, message);
        Err("区域悬浮当前仅支持 Windows".into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Rect {
    fn width(self) -> i32 {
        self.right - self.left
    }
    fn height(self) -> i32 {
        self.bottom - self.top
    }
    fn from_points(a: (i32, i32), b: (i32, i32)) -> Self {
        Self {
            left: a.0.min(b.0),
            top: a.1.min(b.1),
            right: a.0.max(b.0),
            bottom: a.1.max(b.1),
        }
    }
    fn contains(self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

fn source_crop(selection: Rect, source: Rect) -> Result<Rect, String> {
    if selection.width() < 24 || selection.height() < 24 {
        return Err("请框选至少 24 × 24 像素的区域".into());
    }
    if selection.left < source.left
        || selection.top < source.top
        || selection.right > source.right
        || selection.bottom > source.bottom
    {
        return Err("请选择同一个窗口内部的区域，不要跨越多个窗口".into());
    }
    Ok(Rect {
        left: selection.left - source.left,
        top: selection.top - source.top,
        right: selection.right - source.left,
        bottom: selection.bottom - source.top,
    })
}

fn fit_content(
    width: i32,
    height: i32,
    source_width: i32,
    source_height: i32,
    header: i32,
) -> Rect {
    let available_width = (width - 2).max(1);
    let available_height = (height - header - 1).max(1);
    let scale = (available_width as f64 / source_width.max(1) as f64)
        .min(available_height as f64 / source_height.max(1) as f64);
    let w = (source_width as f64 * scale).round().max(1.0) as i32;
    let h = (source_height as f64 * scale).round().max(1.0) as i32;
    let left = 1 + (available_width - w) / 2;
    let top = header + (available_height - h) / 2;
    Rect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_monitor_coordinates_and_reverse_drag_stay_physical() {
        let selected = Rect::from_points((-400, 600), (-1400, 100));
        assert_eq!(
            source_crop(
                selected,
                Rect {
                    left: -1600,
                    top: 0,
                    right: 0,
                    bottom: 900
                }
            )
            .unwrap(),
            Rect {
                left: 200,
                top: 100,
                right: 1200,
                bottom: 600
            }
        );
    }
    #[test]
    fn selection_cannot_cross_windows_or_be_accidentally_tiny() {
        let source = Rect {
            left: 100,
            top: 100,
            right: 900,
            bottom: 600,
        };
        assert!(source_crop(Rect::from_points((99, 100), (500, 500)), source).is_err());
        assert!(source_crop(Rect::from_points((100, 100), (120, 500)), source).is_err());
    }
    #[test]
    fn resizing_letterboxes_instead_of_stretching_or_covering_controls() {
        assert_eq!(
            fit_content(802, 601, 1600, 900, 40),
            Rect {
                left: 1,
                top: 95,
                right: 801,
                bottom: 545
            }
        );
        assert_eq!(
            fit_content(402, 401, 400, 800, 0),
            Rect {
                left: 101,
                top: 0,
                right: 301,
                bottom: 400
            }
        );
    }
    #[test]
    fn concurrent_selection_and_unbounded_windows_are_rejected() {
        let manager = RegionMirrorManager::default();
        manager.reserve().unwrap();
        assert!(manager.reserve().is_err());
        for _ in 1..MAX_MIRRORS {
            manager.0.lock().unwrap().selecting = false;
            manager.reserve().unwrap();
        }
        manager.0.lock().unwrap().selecting = false;
        assert!(manager.reserve().is_err());
    }
}
