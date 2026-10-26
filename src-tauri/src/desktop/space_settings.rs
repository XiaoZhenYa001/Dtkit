use crate::infrastructure::storage::StorageManager;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const SETTINGS_FILE: &str = "desktop-space-settings.json";
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct SpaceSettings {
    pub version: u32,
    pub revision: u64,
    pub glass_opacity: u16,
    pub blur: u16,
    pub icon_size: String,
    pub window_width: u16,
    pub window_height: u16,
    pub close_on_blur: bool,
    pub close_after_open: bool,
    pub reduced_motion: bool,
}

impl Default for SpaceSettings {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            glass_opacity: 68,
            blur: 30,
            icon_size: "medium".into(),
            window_width: 90,
            window_height: 70,
            close_on_blur: true,
            close_after_open: true,
            reduced_motion: false,
        }
    }
}

impl SpaceSettings {
    fn normalize(mut self) -> Result<Self, String> {
        if self.version != 1 {
            return Err("桌面空间设置版本不受支持，原配置已保留".into());
        }
        self.glass_opacity = self.glass_opacity.clamp(40, 90);
        self.blur = self.blur.clamp(12, 48);
        self.window_width = self.window_width.clamp(60, 96);
        self.window_height = self.window_height.clamp(45, 90);
        if !["small", "medium", "large"].contains(&self.icon_size.as_str()) {
            return Err("图标大小无效".into());
        }
        Ok(self)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpaceSettingsPatch {
    glass_opacity: Option<u16>,
    blur: Option<u16>,
    icon_size: Option<String>,
    window_width: Option<u16>,
    window_height: Option<u16>,
    close_on_blur: Option<bool>,
    close_after_open: Option<bool>,
    reduced_motion: Option<bool>,
}

fn merge(mut current: SpaceSettings, patch: SpaceSettingsPatch) -> Result<SpaceSettings, String> {
    if let Some(value) = patch.glass_opacity {
        current.glass_opacity = value;
    }
    if let Some(value) = patch.blur {
        current.blur = value;
    }
    if let Some(value) = patch.icon_size {
        current.icon_size = value;
    }
    if let Some(value) = patch.window_width {
        current.window_width = value;
    }
    if let Some(value) = patch.window_height {
        current.window_height = value;
    }
    if let Some(value) = patch.close_on_blur {
        current.close_on_blur = value;
    }
    if let Some(value) = patch.close_after_open {
        current.close_after_open = value;
    }
    if let Some(value) = patch.reduced_motion {
        current.reduced_motion = value;
    }
    current.normalize()
}

fn read_file(path: &std::path::Path) -> Result<SpaceSettings, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<SpaceSettings>(&bytes)
            .map_err(|error| format!("桌面空间设置读取失败，原配置已保留：{error}"))?
            .normalize(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SpaceSettings::default()),
        Err(error) => Err(format!("无法读取桌面空间设置：{error}")),
    }
}

pub(crate) fn read_settings(app: &AppHandle) -> Result<SpaceSettings, String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| "桌面空间设置不可用")?;
    read_file(&app.state::<StorageManager>().config_file(SETTINGS_FILE)?)
}

fn validate_window(window: &WebviewWindow) -> Result<(), String> {
    if ["main", "desktop-space"].contains(&window.label()) {
        Ok(())
    } else {
        Err("此窗口不能更改桌面空间设置".into())
    }
}

#[tauri::command]
pub(crate) fn get_desktop_space_settings(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<SpaceSettings, String> {
    validate_window(&window)?;
    read_settings(&app)
}

#[tauri::command]
pub(crate) async fn update_desktop_space_settings(
    app: AppHandle,
    window: WebviewWindow,
    patch: SpaceSettingsPatch,
) -> Result<SpaceSettings, String> {
    validate_window(&window)?;
    let worker_app = app.clone();
    let settings = tauri::async_runtime::spawn_blocking(move || {
        let _guard = SETTINGS_LOCK.lock().map_err(|_| "桌面空间设置不可用")?;
        let path = worker_app
            .state::<StorageManager>()
            .config_file(SETTINGS_FILE)?;
        let mut next = merge(read_file(&path)?, patch)?;
        next.revision = next.revision.saturating_add(1);
        let bytes = serde_json::to_vec_pretty(&next).map_err(|error| error.to_string())?;
        let temporary = path.with_file_name(format!(
            ".desktop-space-settings-{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &path)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(format!("保存桌面空间设置失败：{error}"));
        }
        Ok(next)
    })
    .await
    .map_err(|error| format!("空间设置任务异常结束：{error}"))??;
    let _ = app.emit("desktop-space-settings-changed", &settings);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_updates_preserve_behavior_and_enforce_ranges() {
        let original = SpaceSettings {
            close_on_blur: false,
            ..Default::default()
        };
        let patch = serde_json::from_value(serde_json::json!({"glassOpacity": 200, "blur": 2, "windowWidth": 1, "iconSize": "large"})).unwrap();
        let next = merge(original, patch).unwrap();
        assert_eq!(next.glass_opacity, 90);
        assert_eq!(next.blur, 12);
        assert_eq!(next.window_width, 60);
        assert_eq!(next.icon_size, "large");
        assert!(!next.close_on_blur);
        assert!(next.close_after_open);
    }
    #[test]
    fn invalid_or_future_configuration_is_not_silently_reset() {
        assert!(SpaceSettings {
            version: 2,
            ..Default::default()
        }
        .normalize()
        .is_err());
        assert!(serde_json::from_value::<SpaceSettingsPatch>(
            serde_json::json!({"eraseFiles": true})
        )
        .is_err());
        assert!(merge(
            SpaceSettings::default(),
            serde_json::from_value(serde_json::json!({"iconSize": "unknown"})).unwrap()
        )
        .is_err());
    }
}
