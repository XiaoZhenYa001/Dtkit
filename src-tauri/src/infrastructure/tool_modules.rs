use super::quick_host::is_supported_tool_id;
use super::storage::StorageManager;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::sync::RwLock;
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "tool-modules.json";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModuleConfig {
    #[serde(default)]
    disabled_tool_ids: Vec<String>,
}

#[derive(Default)]
pub(crate) struct ToolModuleManager(RwLock<HashSet<String>>);

impl ToolModuleManager {
    pub(crate) fn restore(&self, app: &AppHandle) -> Result<(), String> {
        let path = app.state::<StorageManager>().config_file(CONFIG_FILE)?;
        let config = if path.is_file() {
            serde_json::from_slice::<ModuleConfig>(
                &fs::read(&path).map_err(|error| format!("读取工具模块配置失败: {error}"))?,
            )
            .map_err(|error| format!("工具模块配置无效: {error}"))?
        } else {
            ModuleConfig::default()
        };
        let disabled = config
            .disabled_tool_ids
            .into_iter()
            .filter(|id| is_supported_tool_id(id))
            .collect();
        *self
            .0
            .write()
            .map_err(|_| "工具模块状态不可用".to_string())? = disabled;
        Ok(())
    }

    pub(crate) fn is_enabled(&self, tool_id: &str) -> bool {
        self.0
            .read()
            .map(|disabled| !disabled.contains(tool_id))
            .unwrap_or(false)
    }

    fn disabled_ids(&self) -> Vec<String> {
        let mut ids = self
            .0
            .read()
            .map(|disabled| disabled.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    fn set_enabled(
        &self,
        app: &AppHandle,
        tool_id: &str,
        enabled: bool,
    ) -> Result<Vec<String>, String> {
        if !is_supported_tool_id(tool_id) {
            return Err("不能管理未知工具模块".to_string());
        }
        let previous = self.disabled_ids();
        {
            let mut disabled = self
                .0
                .write()
                .map_err(|_| "工具模块状态不可用".to_string())?;
            if enabled {
                disabled.remove(tool_id);
            } else {
                disabled.insert(tool_id.to_string());
            }
        }
        let next = self.disabled_ids();
        if let Err(error) = persist(app, &next) {
            if let Ok(mut disabled) = self.0.write() {
                *disabled = previous.into_iter().collect();
            }
            return Err(error);
        }
        Ok(next)
    }
}

fn persist(app: &AppHandle, disabled_tool_ids: &[String]) -> Result<(), String> {
    let path = app.state::<StorageManager>().config_file(CONFIG_FILE)?;
    let bytes = serde_json::to_vec_pretty(&ModuleConfig {
        disabled_tool_ids: disabled_tool_ids.to_vec(),
    })
    .map_err(|error| format!("序列化工具模块配置失败: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    fs::write(&temporary, bytes).map_err(|error| format!("写入工具模块配置失败: {error}"))?;
    if path.is_file() {
        let _ = fs::remove_file(&backup);
        fs::rename(&path, &backup).map_err(|error| format!("备份工具模块配置失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.is_file() {
            let _ = fs::rename(&backup, &path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("提交工具模块配置失败: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[tauri::command]
pub(crate) fn get_tool_module_settings(
    manager: tauri::State<'_, ToolModuleManager>,
) -> Vec<String> {
    manager.disabled_ids()
}

#[tauri::command]
pub(crate) fn set_tool_module_enabled(
    app: AppHandle,
    manager: tauri::State<'_, ToolModuleManager>,
    tool_id: String,
    enabled: bool,
) -> Result<Vec<String>, String> {
    manager.set_enabled(&app, &tool_id, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_modules_are_never_treated_as_enabled() {
        let manager = ToolModuleManager::default();
        assert!(!is_supported_tool_id("../settings"));
        assert!(manager.is_enabled("whiteboard"));
    }
}
