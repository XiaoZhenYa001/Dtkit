use super::quick_host::{is_supported_tool_id, QuickHostManager, QuickHostTarget};
use super::storage::StorageManager;
use super::tool_modules::ToolModuleManager;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::str::FromStr;
use std::sync::RwLock;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const SHORTCUT_CONFIG_FILE: &str = "tool-shortcuts.json";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ShortcutTarget {
    Tool { tool_id: String },
    Palette,
}

impl ShortcutTarget {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Tool { tool_id } if is_supported_tool_id(tool_id) => Ok(()),
            Self::Palette => Ok(()),
            _ => Err("快捷键目标无效".to_string()),
        }
    }

    fn quick_target(&self) -> Result<QuickHostTarget, String> {
        match self {
            Self::Tool { tool_id } => QuickHostTarget::tool(tool_id.clone()),
            Self::Palette => Ok(QuickHostTarget::palette()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutBinding {
    pub(crate) accelerator: String,
    pub(crate) target: ShortcutTarget,
    #[serde(default = "default_enabled")]
    pub(crate) enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Default)]
pub(crate) struct ShortcutRegistry(RwLock<HashMap<String, ShortcutBinding>>);

impl ShortcutRegistry {
    pub(crate) fn binding_count(&self) -> usize {
        self.0.read().map(|bindings| bindings.len()).unwrap_or(0)
    }

    pub(crate) fn bindings(&self) -> Vec<ShortcutBinding> {
        let mut bindings = self
            .0
            .read()
            .map(|bindings| bindings.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        bindings.sort_by(|left, right| left.accelerator.cmp(&right.accelerator));
        bindings
    }

    pub(crate) fn resolve(&self, accelerator: &str) -> Option<ShortcutTarget> {
        self.0
            .read()
            .ok()?
            .get(accelerator)
            .map(|binding| binding.target.clone())
    }

    pub(crate) fn restore(&self, app: &AppHandle) -> Result<(), String> {
        let path = app
            .state::<StorageManager>()
            .config_file(SHORTCUT_CONFIG_FILE)?;
        if !path.is_file() {
            return Ok(());
        }
        let serialized =
            fs::read_to_string(&path).map_err(|error| format!("读取快捷键配置失败: {error}"))?;
        let mut bindings: Vec<ShortcutBinding> = serde_json::from_str(&serialized)
            .map_err(|error| format!("快捷键配置格式无效: {error}"))?;
        let modules = app.state::<ToolModuleManager>();
        bindings.retain(|binding| match &binding.target {
            ShortcutTarget::Tool { tool_id } => modules.is_enabled(tool_id),
            ShortcutTarget::Palette => true,
        });
        self.replace(app, bindings, false).map(|_| ())
    }

    pub(crate) fn replace(
        &self,
        app: &AppHandle,
        bindings: Vec<ShortcutBinding>,
        persist: bool,
    ) -> Result<Vec<ShortcutBinding>, String> {
        let normalized = normalize_bindings(bindings)?;
        let previous = self.bindings();

        app.global_shortcut()
            .unregister_all()
            .map_err(|error| format!("注销旧快捷键失败: {error}"))?;

        if let Err(error) = register_bindings(app, &normalized) {
            let _ = app.global_shortcut().unregister_all();
            let _ = register_bindings(app, &previous);
            return Err(error);
        }

        let next_map = normalized
            .iter()
            .cloned()
            .map(|binding| (binding.accelerator.clone(), binding))
            .collect();
        *self
            .0
            .write()
            .map_err(|_| "快捷键注册表状态不可用".to_string())? = next_map;

        if persist {
            let path = app
                .state::<StorageManager>()
                .config_file(SHORTCUT_CONFIG_FILE)?;
            let serialized = serde_json::to_vec_pretty(&normalized)
                .map_err(|error| format!("序列化快捷键配置失败: {error}"))?;
            if let Err(error) = fs::write(path, serialized) {
                let _ = app.global_shortcut().unregister_all();
                let _ = register_bindings(app, &previous);
                let previous_map = previous
                    .iter()
                    .cloned()
                    .map(|binding| (binding.accelerator.clone(), binding))
                    .collect();
                if let Ok(mut current) = self.0.write() {
                    *current = previous_map;
                }
                return Err(format!("保存快捷键配置失败: {error}"));
            }
        }

        Ok(normalized)
    }
}

fn normalize_bindings(bindings: Vec<ShortcutBinding>) -> Result<Vec<ShortcutBinding>, String> {
    let mut accelerators = HashSet::new();
    let mut targets = HashSet::new();
    let mut normalized = Vec::new();

    for mut binding in bindings.into_iter().filter(|binding| binding.enabled) {
        binding.target.validate()?;
        let parsed = Shortcut::from_str(binding.accelerator.trim())
            .map_err(|error| format!("快捷键格式无效（{}）: {error}", binding.accelerator))?;
        if parsed.mods.is_empty() {
            return Err("系统级快捷键至少需要一个修饰键".to_string());
        }
        binding.accelerator = parsed.to_string();
        if !accelerators.insert(binding.accelerator.clone()) {
            return Err(format!("快捷键重复: {}", binding.accelerator));
        }
        if !targets.insert(binding.target.clone()) {
            return Err("同一工具或命令不能绑定多个快捷键".to_string());
        }
        normalized.push(binding);
    }

    normalized.sort_by(|left, right| left.accelerator.cmp(&right.accelerator));
    Ok(normalized)
}

fn register_bindings(app: &AppHandle, bindings: &[ShortcutBinding]) -> Result<(), String> {
    for binding in bindings {
        app.global_shortcut()
            .register(binding.accelerator.as_str())
            .map_err(|error| format!("注册快捷键失败（{}）: {error}", binding.accelerator))?;
    }
    Ok(())
}

pub(crate) fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let accelerator = shortcut.to_string();
    let registry = app.state::<ShortcutRegistry>();
    let Some(target) = registry.resolve(&accelerator) else {
        return;
    };
    if let ShortcutTarget::Tool { tool_id } = &target {
        if !app.state::<ToolModuleManager>().is_enabled(tool_id) {
            return;
        }
    }
    let quick_target = match target.quick_target() {
        Ok(target) => target,
        Err(error) => {
            eprintln!("[ShortcutRegistry] {error}");
            return;
        }
    };
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = app_handle
            .state::<QuickHostManager>()
            .open(&app_handle, quick_target)
        {
            eprintln!("[ShortcutRegistry] 打开快捷宿主失败: {error}");
        }
    });
}

#[tauri::command]
pub(crate) fn get_shortcut_bindings(
    registry: tauri::State<'_, ShortcutRegistry>,
) -> Vec<ShortcutBinding> {
    registry.bindings()
}

#[tauri::command]
pub(crate) fn replace_shortcut_bindings(
    app: AppHandle,
    registry: tauri::State<'_, ShortcutRegistry>,
    modules: tauri::State<'_, ToolModuleManager>,
    bindings: Vec<ShortcutBinding>,
) -> Result<Vec<ShortcutBinding>, String> {
    if bindings.iter().any(|binding| {
        matches!(
            &binding.target,
            ShortcutTarget::Tool { tool_id } if !modules.is_enabled(tool_id)
        )
    }) {
        return Err("已停用的工具不能绑定快捷键".to_string());
    }
    registry.replace(&app, bindings, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_binding(accelerator: &str, tool_id: &str) -> ShortcutBinding {
        ShortcutBinding {
            accelerator: accelerator.into(),
            target: ShortcutTarget::Tool {
                tool_id: tool_id.into(),
            },
            enabled: true,
        }
    }

    #[test]
    fn no_shortcuts_are_bound_by_default() {
        assert_eq!(ShortcutRegistry::default().binding_count(), 0);
    }

    #[test]
    fn disabled_bindings_are_not_registered() {
        let mut disabled = tool_binding("Ctrl+Alt+J", "json-formatter");
        disabled.enabled = false;
        assert!(normalize_bindings(vec![disabled]).unwrap().is_empty());
    }

    #[test]
    fn duplicate_shortcuts_and_targets_are_rejected() {
        assert!(normalize_bindings(vec![
            tool_binding("Ctrl+Alt+J", "json-formatter"),
            tool_binding("Ctrl+Alt+J", "timestamp-converter")
        ])
        .is_err());
        assert!(normalize_bindings(vec![
            tool_binding("Ctrl+Alt+J", "json-formatter"),
            tool_binding("Ctrl+Alt+K", "json-formatter")
        ])
        .is_err());
    }

    #[test]
    fn unsafe_tool_targets_are_rejected() {
        assert!(normalize_bindings(vec![tool_binding("Ctrl+Alt+J", "../settings")]).is_err());
        assert!(normalize_bindings(vec![tool_binding("J", "json-formatter")]).is_err());
    }

    #[test]
    fn tool_targets_use_camel_case_at_the_ipc_boundary() {
        let target = ShortcutTarget::Tool {
            tool_id: "json-formatter".into(),
        };
        assert_eq!(
            serde_json::to_value(target).unwrap(),
            serde_json::json!({ "kind": "tool", "toolId": "json-formatter" })
        );
    }
}
