use super::quick_host::{is_supported_tool_id, QuickHostManager, QuickHostTarget};
use super::storage::StorageManager;
use super::tool_modules::ToolModuleManager;
use crate::desktop::space::DesktopSpaceManager;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::str::FromStr;
use std::sync::{Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const SHORTCUT_CONFIG_FILE: &str = "tool-shortcuts.json";
const DESKTOP_SPACE_DEFAULT_ACCELERATOR: &str = "Ctrl+Alt+D";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ShortcutTarget {
    Tool { tool_id: String },
    Palette,
    DesktopSpace,
}

impl ShortcutTarget {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Tool { tool_id } if is_supported_tool_id(tool_id) => Ok(()),
            Self::Palette | Self::DesktopSpace => Ok(()),
            _ => Err("快捷键目标无效".to_string()),
        }
    }

    fn quick_target(&self) -> Result<QuickHostTarget, String> {
        match self {
            Self::Tool { tool_id } => QuickHostTarget::tool(tool_id.clone()),
            Self::Palette => Ok(QuickHostTarget::palette()),
            Self::DesktopSpace => Err("桌面空间使用独立窗口".to_string()),
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutBindingStatus {
    #[serde(flatten)]
    binding: ShortcutBinding,
    registered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    registration_error: Option<String>,
}

#[derive(Default, Clone)]
struct RegistryState {
    configured: Vec<ShortcutBinding>,
    active: HashMap<String, ShortcutBinding>,
    errors: HashMap<ShortcutTarget, String>,
}

#[derive(Default)]
pub(crate) struct ShortcutRegistry(RwLock<RegistryState>, Mutex<()>);

impl ShortcutRegistry {
    pub(crate) fn binding_count(&self) -> usize {
        self.0.read().map(|state| state.active.len()).unwrap_or(0)
    }

    pub(crate) fn bindings(&self) -> Vec<ShortcutBinding> {
        let mut bindings = self
            .0
            .read()
            .map(|state| state.configured.clone())
            .unwrap_or_default();
        bindings.sort_by(|left, right| left.accelerator.cmp(&right.accelerator));
        bindings
    }

    pub(crate) fn is_registered(&self, target: &ShortcutTarget) -> bool {
        self.0
            .read()
            .map(|state| {
                state
                    .active
                    .values()
                    .any(|binding| &binding.target == target)
            })
            .unwrap_or(false)
    }

    pub(crate) fn registration_error(&self, target: &ShortcutTarget) -> Option<String> {
        self.0.read().ok()?.errors.get(target).cloned()
    }

    fn statuses(&self) -> Vec<ShortcutBindingStatus> {
        let Ok(state) = self.0.read() else {
            return Vec::new();
        };
        state
            .configured
            .iter()
            .map(|binding| ShortcutBindingStatus {
                binding: binding.clone(),
                registered: state.active.get(&binding.accelerator) == Some(binding),
                registration_error: state.errors.get(&binding.target).cloned(),
            })
            .collect()
    }

    fn announce(&self, app: &AppHandle) {
        let _ = app.emit("shortcut-bindings-changed", self.statuses());
    }

    pub(crate) fn resolve(&self, accelerator: &str) -> Option<ShortcutTarget> {
        self.0
            .read()
            .ok()?
            .active
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
            ShortcutTarget::Palette | ShortcutTarget::DesktopSpace => true,
        });
        let normalized = normalize_bindings(bindings)?;
        let _guard = self.1.lock().map_err(|_| "快捷键注册表状态不可用")?;
        app.global_shortcut()
            .unregister_all()
            .map_err(|error| format!("注销旧快捷键失败: {error}"))?;
        // A startup conflict affects only that shortcut. The desired bindings
        // remain intact so a later restart or edit can recover them.
        let state = restore_individually(normalized, |binding| register_binding(app, binding));
        *self.0.write().map_err(|_| "快捷键注册表状态不可用")? = state;
        self.announce(app);
        Ok(())
    }

    /// Add the first space binding through the shared registry so later shortcut
    /// edits cannot silently unregister a separately registered global hotkey.
    pub(crate) fn ensure_desktop_space_binding(&self, app: &AppHandle) -> Result<bool, String> {
        let _guard = self.1.lock().map_err(|_| "快捷键注册表状态不可用")?;
        let Some(bindings) = with_desktop_space_default(self.bindings())? else {
            return Ok(false);
        };
        let binding = bindings
            .into_iter()
            .find(|binding| binding.target == ShortcutTarget::DesktopSpace)
            .ok_or("桌面空间快捷键缺失")?;
        self.change_target_locked(app, ShortcutTarget::DesktopSpace, Some(binding))
            .map(|_| true)
            .map_err(|error| {
                format!("无法注册桌面空间快捷键 {DESKTOP_SPACE_DEFAULT_ACCELERATOR}: {error}")
            })
    }

    pub(crate) fn remove_desktop_space_binding(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.1.lock().map_err(|_| "快捷键注册表状态不可用")?;
        let bindings = self.bindings();
        let default_accelerator = Shortcut::from_str(DESKTOP_SPACE_DEFAULT_ACCELERATOR)
            .map_err(|error| error.to_string())?
            .to_string();
        // A user can edit shortcuts while window creation is in progress. A
        // failed enable must only undo its own default, never a newer binding.
        if bindings.iter().any(|binding| {
            binding.target == ShortcutTarget::DesktopSpace
                && binding.accelerator == default_accelerator
        }) {
            self.change_target_locked(app, ShortcutTarget::DesktopSpace, None)?;
        }
        Ok(())
    }

    pub(crate) fn replace(
        &self,
        app: &AppHandle,
        bindings: Vec<ShortcutBinding>,
        persist: bool,
    ) -> Result<Vec<ShortcutBinding>, String> {
        let _guard = self.1.lock().map_err(|_| "快捷键注册表状态不可用")?;
        self.replace_locked(app, bindings, persist)
    }

    fn replace_locked(
        &self,
        app: &AppHandle,
        bindings: Vec<ShortcutBinding>,
        persist: bool,
    ) -> Result<Vec<ShortcutBinding>, String> {
        let normalized = normalize_bindings(bindings)?;
        let previous = self.0.read().map_err(|_| "快捷键注册表状态不可用")?.clone();

        app.global_shortcut()
            .unregister_all()
            .map_err(|error| format!("注销旧快捷键失败: {error}"))?;

        if let Err(error) = register_bindings(app, &normalized) {
            let _ = app.global_shortcut().unregister_all();
            let restored = restore_individually(previous.configured.clone(), |binding| {
                register_binding(app, binding)
            });
            *self.0.write().map_err(|_| "快捷键注册表状态不可用")? = restored;
            self.announce(app);
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
            .map_err(|_| "快捷键注册表状态不可用".to_string())? = RegistryState {
            configured: normalized.clone(),
            active: next_map,
            errors: HashMap::new(),
        };

        if persist {
            if let Err(error) = persist_bindings(app, &normalized) {
                let _ = app.global_shortcut().unregister_all();
                let restored = restore_individually(previous.configured.clone(), |binding| {
                    register_binding(app, binding)
                });
                if let Ok(mut current) = self.0.write() {
                    *current = restored;
                }
                self.announce(app);
                return Err(error);
            }
        }

        self.announce(app);
        Ok(normalized)
    }

    fn change_target(
        &self,
        app: &AppHandle,
        target: ShortcutTarget,
        binding: Option<ShortcutBinding>,
    ) -> Result<Vec<ShortcutBindingStatus>, String> {
        let _guard = self.1.lock().map_err(|_| "快捷键注册表状态不可用")?;
        self.change_target_locked(app, target, binding)?;
        Ok(self.statuses())
    }

    fn change_target_locked(
        &self,
        app: &AppHandle,
        target: ShortcutTarget,
        binding: Option<ShortcutBinding>,
    ) -> Result<(), String> {
        target.validate()?;
        let previous = self.0.read().map_err(|_| "快捷键注册表状态不可用")?.clone();
        // Read and merge inside the same native transaction. Two WebViews may
        // edit different targets without submitting or overwriting old snapshots.
        let configured = updated_target(&previous.configured, &target, binding)?;
        let next = configured
            .iter()
            .find(|binding| binding.target == target)
            .cloned();
        let old_active = previous
            .active
            .values()
            .find(|binding| binding.target == target)
            .cloned();
        let new_registration = next
            .as_ref()
            .filter(|binding| old_active.as_ref() != Some(binding));
        if let Some(binding) = new_registration {
            register_binding(app, binding)?;
        }
        let persisted = persist_bindings(app, &configured);
        if let Err(error) = persisted {
            if let Some(binding) = new_registration {
                let _ = app
                    .global_shortcut()
                    .unregister(binding.accelerator.as_str());
            }
            return Err(error);
        }
        if let Some(old) = old_active.as_ref().filter(|old| next.as_ref() != Some(old)) {
            if let Err(error) = app.global_shortcut().unregister(old.accelerator.as_str()) {
                if let Some(binding) = new_registration {
                    let _ = app
                        .global_shortcut()
                        .unregister(binding.accelerator.as_str());
                }
                let _ = persist_bindings(app, &previous.configured);
                return Err(format!("注销旧快捷键失败: {error}"));
            }
        }
        let mut state = previous;
        state.configured = configured;
        state.active.retain(|_, binding| binding.target != target);
        state.errors.remove(&target);
        if let Some(binding) = next {
            state.active.insert(binding.accelerator.clone(), binding);
        }
        *self.0.write().map_err(|_| "快捷键注册表状态不可用")? = state;
        self.announce(app);
        Ok(())
    }
}

fn updated_target(
    bindings: &[ShortcutBinding],
    target: &ShortcutTarget,
    binding: Option<ShortcutBinding>,
) -> Result<Vec<ShortcutBinding>, String> {
    let mut next: Vec<_> = bindings
        .iter()
        .filter(|binding| &binding.target != target)
        .cloned()
        .collect();
    if let Some(binding) = binding {
        if &binding.target != target {
            return Err("快捷键目标不一致".into());
        }
        next.push(binding);
    }
    normalize_bindings(next)
}

fn restore_individually(
    bindings: Vec<ShortcutBinding>,
    mut register: impl FnMut(&ShortcutBinding) -> Result<(), String>,
) -> RegistryState {
    let mut state = RegistryState {
        configured: bindings,
        ..RegistryState::default()
    };
    for binding in &state.configured {
        match register(binding) {
            Ok(()) => {
                state
                    .active
                    .insert(binding.accelerator.clone(), binding.clone());
            }
            Err(error) => {
                state.errors.insert(binding.target.clone(), error);
            }
        }
    }
    state
}

fn persist_bindings(app: &AppHandle, bindings: &[ShortcutBinding]) -> Result<(), String> {
    let path = app
        .state::<StorageManager>()
        .config_file(SHORTCUT_CONFIG_FILE)?;
    let serialized = serde_json::to_vec_pretty(bindings)
        .map_err(|error| format!("序列化快捷键配置失败: {error}"))?;
    let temporary = path.with_file_name(format!(".tool-shortcuts-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&serialized)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("保存快捷键配置失败: {error}"));
    }
    Ok(())
}

fn with_desktop_space_default(
    mut bindings: Vec<ShortcutBinding>,
) -> Result<Option<Vec<ShortcutBinding>>, String> {
    if bindings
        .iter()
        .any(|binding| binding.target == ShortcutTarget::DesktopSpace)
    {
        return Ok(None);
    }
    bindings.push(ShortcutBinding {
        accelerator: DESKTOP_SPACE_DEFAULT_ACCELERATOR.into(),
        target: ShortcutTarget::DesktopSpace,
        enabled: true,
    });
    normalize_bindings(bindings).map(Some)
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
        register_binding(app, binding)?;
    }
    Ok(())
}

fn register_binding(app: &AppHandle, binding: &ShortcutBinding) -> Result<(), String> {
    app.global_shortcut()
        .register(binding.accelerator.as_str())
        .map_err(|error| format!("注册快捷键失败（{}）: {error}", binding.accelerator))
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
    if target == ShortcutTarget::DesktopSpace {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = app.state::<DesktopSpaceManager>().toggle(&app).await {
                eprintln!("[ShortcutRegistry] 呼出桌面空间失败: {error}");
            }
        });
        return;
    }
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
) -> Vec<ShortcutBindingStatus> {
    registry.statuses()
}

#[tauri::command]
pub(crate) async fn upsert_shortcut_binding(
    app: AppHandle,
    registry: tauri::State<'_, ShortcutRegistry>,
    modules: tauri::State<'_, ToolModuleManager>,
    binding: ShortcutBinding,
) -> Result<Vec<ShortcutBindingStatus>, String> {
    if matches!(&binding.target, ShortcutTarget::Tool { tool_id } if !modules.is_enabled(tool_id)) {
        return Err("已停用的工具不能绑定快捷键".into());
    }
    registry.change_target(
        &app,
        binding.target.clone(),
        binding.enabled.then_some(binding),
    )
}

#[tauri::command]
pub(crate) async fn remove_shortcut_binding(
    app: AppHandle,
    registry: tauri::State<'_, ShortcutRegistry>,
    target: ShortcutTarget,
) -> Result<Vec<ShortcutBindingStatus>, String> {
    registry.change_target(&app, target, None)
}

#[tauri::command]
pub(crate) async fn replace_shortcut_bindings(
    app: AppHandle,
    registry: tauri::State<'_, ShortcutRegistry>,
    modules: tauri::State<'_, ToolModuleManager>,
    bindings: Vec<ShortcutBinding>,
) -> Result<Vec<ShortcutBindingStatus>, String> {
    if bindings.iter().any(|binding| {
        matches!(
            &binding.target,
            ShortcutTarget::Tool { tool_id } if !modules.is_enabled(tool_id)
        )
    }) {
        return Err("已停用的工具不能绑定快捷键".to_string());
    }
    registry.replace(&app, bindings, true)?;
    Ok(registry.statuses())
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

    #[test]
    fn desktop_space_target_round_trips_and_conflicts_with_other_bindings() {
        let target = ShortcutTarget::DesktopSpace;
        assert_eq!(
            serde_json::to_value(&target).unwrap(),
            serde_json::json!({"kind": "desktopSpace"})
        );
        let binding = ShortcutBinding {
            accelerator: "Ctrl+Alt+Space".into(),
            target,
            enabled: true,
        };
        assert!(normalize_bindings(vec![binding.clone()]).is_ok());
        assert!(normalize_bindings(vec![
            binding,
            tool_binding("Ctrl+Alt+Space", "json-formatter")
        ])
        .is_err());
    }

    #[test]
    fn first_desktop_space_default_preserves_existing_palette_and_tool_bindings() {
        let existing = vec![
            ShortcutBinding {
                accelerator: "control+alt+Space".into(),
                target: ShortcutTarget::Palette,
                enabled: true,
            },
            tool_binding("Ctrl+Alt+K", "html-preview"),
            tool_binding("Ctrl+Alt+P", "whiteboard"),
        ];
        let normalized = with_desktop_space_default(existing.clone())
            .expect("space must have an independent default")
            .unwrap();
        assert_eq!(normalized.len(), existing.len() + 1);
        for binding in normalize_bindings(existing).unwrap() {
            assert!(normalized.contains(&binding));
        }
    }

    #[test]
    fn existing_space_shortcut_is_preserved_and_default_conflicts_are_canonical() {
        let existing = vec![ShortcutBinding {
            accelerator: "Ctrl+Shift+F23".into(),
            target: ShortcutTarget::DesktopSpace,
            enabled: true,
        }];
        assert!(with_desktop_space_default(existing).unwrap().is_none());
        let occupied = vec![ShortcutBinding {
            accelerator: "control+alt+KeyD".into(),
            target: ShortcutTarget::Palette,
            enabled: true,
        }];
        assert!(with_desktop_space_default(occupied)
            .unwrap_err()
            .contains("快捷键重复"));
    }

    #[test]
    fn restoring_one_occupied_key_preserves_usable_keys_and_saved_choices() {
        let bindings = normalize_bindings(vec![
            tool_binding("Ctrl+Alt+Shift+F23", "timestamp-converter"),
            ShortcutBinding {
                accelerator: "Ctrl+Alt+Shift+F24".into(),
                target: ShortcutTarget::DesktopSpace,
                enabled: true,
            },
        ])
        .unwrap();
        let saved = bindings.clone();
        let state = restore_individually(bindings, |binding| {
            if binding.target == ShortcutTarget::DesktopSpace {
                Err("occupied by another application".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(state.configured, saved);
        assert_eq!(state.active.len(), 1);
        assert!(state.active.values().any(|binding| matches!(&binding.target, ShortcutTarget::Tool { tool_id } if tool_id == "timestamp-converter")));
        assert!(state
            .errors
            .get(&ShortcutTarget::DesktopSpace)
            .unwrap()
            .contains("occupied"));
        let recovered = restore_individually(state.configured, |_| Ok(()));
        assert_eq!(recovered.active.len(), 2);
        assert!(recovered.errors.is_empty());
    }

    #[test]
    fn registration_status_keeps_failed_desired_bindings_visible() {
        let binding = ShortcutBinding {
            accelerator: "Ctrl+Alt+D".into(),
            target: ShortcutTarget::DesktopSpace,
            enabled: true,
        };
        let registry = ShortcutRegistry(
            RwLock::new(restore_individually(vec![binding.clone()], |_| {
                Err("occupied".into())
            })),
            Mutex::new(()),
        );
        assert_eq!(registry.bindings(), vec![binding]);
        assert_eq!(registry.binding_count(), 0);
        assert!(!registry.is_registered(&ShortcutTarget::DesktopSpace));
        let status = serde_json::to_value(registry.statuses()).unwrap();
        assert_eq!(status[0]["registered"], false);
        assert_eq!(status[0]["registrationError"], "occupied");
        assert!(registry.resolve("Ctrl+Alt+D").is_none());
    }

    #[test]
    fn target_updates_merge_against_latest_state_and_keep_unrelated_failures() {
        use std::sync::{Arc, Barrier};
        let original = vec![tool_binding("Ctrl+Alt+T", "timestamp-converter")];
        let shared = Arc::new(Mutex::new(normalize_bindings(original).unwrap()));
        let barrier = Arc::new(Barrier::new(3));
        let edits = [
            ShortcutBinding {
                accelerator: "Ctrl+Alt+Y".into(),
                target: ShortcutTarget::DesktopSpace,
                enabled: true,
            },
            ShortcutBinding {
                accelerator: "Ctrl+Alt+U".into(),
                target: ShortcutTarget::Palette,
                enabled: true,
            },
        ];
        let workers: Vec<_> = edits
            .into_iter()
            .map(|binding| {
                let current = shared.clone();
                let start = barrier.clone();
                std::thread::spawn(move || {
                    start.wait();
                    let mut current = current.lock().unwrap();
                    *current =
                        updated_target(&current, &binding.target, Some(binding.clone())).unwrap();
                })
            })
            .collect();
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        let final_bindings = shared.lock().unwrap();
        assert_eq!(final_bindings.len(), 3);
        assert!(final_bindings
            .iter()
            .any(|binding| binding.target == ShortcutTarget::DesktopSpace));
        assert!(final_bindings
            .iter()
            .any(|binding| binding.target == ShortcutTarget::Palette));
        let removed = updated_target(&final_bindings, &ShortcutTarget::DesktopSpace, None).unwrap();
        assert_eq!(removed.len(), 2);
        assert!(removed.iter().any(|binding| matches!(&binding.target, ShortcutTarget::Tool { tool_id } if tool_id == "timestamp-converter")));
    }
}
