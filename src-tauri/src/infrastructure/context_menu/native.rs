use super::*;
use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, KEY_WOW64_32KEY,
    KEY_WOW64_64KEY, REG_SZ,
};
use winreg::{RegKey, RegValue};

pub(super) struct WindowsRegistry;
fn root(system: bool) -> RegKey {
    RegKey::predef(if system {
        HKEY_LOCAL_MACHINE
    } else {
        HKEY_CURRENT_USER
    })
}
fn view(bits: u32) -> u32 {
    if bits == 32 {
        KEY_WOW64_32KEY
    } else {
        KEY_WOW64_64KEY
    }
}
fn label(location: &Location) -> String {
    format!(
        "{}\\{}{}",
        if location.system {
            "HKEY_LOCAL_MACHINE"
        } else {
            "HKEY_CURRENT_USER"
        },
        location.path,
        if location.view == 32 {
            "（32 位）"
        } else {
            ""
        }
    )
}
fn open(location: &Location) -> Result<Option<RegKey>, String> {
    match root(location.system)
        .open_subkey_with_flags(&location.path, KEY_READ | view(location.view))
    {
        Ok(key) => Ok(Some(key)),
        Err(e) if e.raw_os_error() == Some(2) => Ok(None),
        Err(e) => Err(format!("无法读取 {}：{e}", label(location))),
    }
}
fn raw(key: &RegKey, name: &str) -> Result<Option<RawValue>, String> {
    match key.get_raw_value(name) {
        Ok(value) => Ok(Some(RawValue {
            kind: value.vtype as u32,
            bytes: value.bytes,
        })),
        Err(e) if e.raw_os_error() == Some(2) => Ok(None),
        Err(e) => Err(format!("读取注册值 {name} 失败：{e}")),
    }
}
fn text_value(value: &RawValue) -> Option<String> {
    if !matches!(value.kind, 1 | 2) || value.bytes.len() % 2 != 0 {
        return None;
    }
    let bytes: Vec<u16> = value
        .bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    String::from_utf16(&bytes)
        .ok()
        .map(|value| value.trim_end_matches('\0').to_string())
}
fn string(key: &RegKey, name: &str) -> Result<String, String> {
    Ok(raw(key, name)?
        .as_ref()
        .and_then(text_value)
        .unwrap_or_default())
}
fn names(key: &RegKey) -> Result<Vec<String>, String> {
    let names: Result<Vec<_>, _> = key.enum_keys().take(4097).collect();
    let names = names.map_err(|e| format!("枚举注册项失败：{e}"))?;
    if names.len() > 4096 {
        return Err("单个菜单注册位置过大，已停止读取该位置".into());
    }
    Ok(names)
}

impl MarkerIo for WindowsRegistry {
    fn verify_registration(&self, entry: &ContextMenuEntry) -> Result<(), String> {
        let current = if let Some(clsid) = &entry.clsid {
            extension_registration(clsid, &entry.sources)?
        } else {
            registration(entry.sources.first().ok_or("菜单注册来源不完整")?)?
        };
        if current != entry.registration {
            return Err("菜单注册在保存恢复记录期间发生变化，未进行更改，请重新扫描".into());
        }
        Ok(())
    }
    fn read(&self, marker: &Marker) -> Result<Option<RawValue>, String> {
        open(&marker.location)?
            .map(|key| raw(&key, &marker.name))
            .unwrap_or(Ok(None))
    }
    fn write(&self, marker: &Marker, value: Option<&RawValue>) -> Result<(), String> {
        let location = &marker.location;
        let key = if location.path == BLOCKED_PATH && !location.system {
            root(false)
                .create_subkey_with_flags(&location.path, KEY_SET_VALUE | view(location.view))
                .map(|(key, _)| key)
        } else {
            root(location.system)
                .open_subkey_with_flags(&location.path, KEY_SET_VALUE | view(location.view))
        }
        .map_err(|e| {
            format!(
                "无法更改菜单注册项{}：{e}",
                if location.system {
                    "，可能需要以管理员身份运行 DtKit"
                } else {
                    ""
                }
            )
        })?;
        match value {
            Some(value) => {
                if value.kind != REG_SZ as u32 {
                    return Err("关闭标记的类型无效".into());
                }
                key.set_raw_value(
                    &marker.name,
                    &RegValue {
                        vtype: REG_SZ,
                        bytes: value.bytes.clone(),
                    },
                )
            }
            None => key.delete_value(&marker.name),
        }
        .map_err(|e| format!("更改菜单标记失败：{e}"))
    }
}

fn extension_registration(clsid: &str, sources: &[Location]) -> Result<String, String> {
    let (_, _, class_fingerprint) = class_data(clsid)?;
    let registrations = sources
        .iter()
        .map(|location| Ok((label(location), registration(location)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    Ok(hash(
        &serde_json::to_vec(&(class_fingerprint, registrations)).map_err(|e| e.to_string())?,
    ))
}

fn registration(location: &Location) -> Result<String, String> {
    let Some(key) = open(location)? else {
        return Ok("missing".into());
    };
    let mut collected = BTreeMap::<String, RawValue>::new();
    let mut size = 0;
    fn visit(
        key: &RegKey,
        prefix: &str,
        depth: usize,
        size: &mut usize,
        result: &mut BTreeMap<String, RawValue>,
    ) -> Result<(), String> {
        if depth > 6 {
            return Err("菜单注册层级过深，仅支持查看".into());
        }
        for value in key.enum_values().take(4097) {
            let (name, value) = value.map_err(|e| format!("读取菜单元数据失败：{e}"))?;
            if depth == 0 && name.eq_ignore_ascii_case("LegacyDisable") {
                continue;
            }
            *size += value.bytes.len() + name.len();
            if *size > 1024 * 1024 || result.len() >= 4096 {
                return Err("菜单注册数据过大，仅支持查看".into());
            }
            result.insert(
                format!("{prefix}|{}", name.to_lowercase()),
                RawValue {
                    kind: value.vtype as u32,
                    bytes: value.bytes,
                },
            );
        }
        for child in names(key)? {
            let next = key
                .open_subkey_with_flags(&child, KEY_READ)
                .map_err(|e| format!("读取菜单子项失败：{e}"))?;
            visit(
                &next,
                &format!("{prefix}\\{}", child.to_lowercase()),
                depth + 1,
                size,
                result,
            )?;
        }
        Ok(())
    }
    visit(&key, "", 0, &mut size, &mut collected)?;
    Ok(hash(
        &serde_json::to_vec(&collected).map_err(|e| e.to_string())?,
    ))
}

fn protected_command(command: &str) -> bool {
    let value = command.to_lowercase().replace('/', "\\");
    let windir = std::env::var("WINDIR")
        .unwrap_or_else(|_| r"C:\Windows".into())
        .to_lowercase();
    value.contains(&windir)
        || value.contains("%systemroot%")
        || value.contains("%windir%")
        || [
            "windows defender",
            "windowsdefender",
            "shell32.dll",
            "rundll32",
            "explorer.exe",
            "msiexec",
            "dllhost.exe",
        ]
        .iter()
        .any(|name| value.contains(name))
}
fn core_verb(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "open"
            | "opennewwindow"
            | "opennewprocess"
            | "explore"
            | "runas"
            | "runasuser"
            | "find"
            | "search"
            | "properties"
            | "print"
            | "printto"
            | "delete"
            | "rename"
            | "cut"
            | "copy"
            | "paste"
            | "pintohome"
            | "pintostartscreen"
            | "opencontaining"
            | "unlock-bitlocker"
            | "manage-bde"
            | "format"
            | "eject"
    )
}
fn visible_name(value: String, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() || value.starts_with('@') {
        fallback.to_string()
    } else {
        value.replace('&', "")
    }
}
fn verb(location: Location, categories: Vec<String>) -> Result<ContextMenuEntry, String> {
    let key = open(&location)?.ok_or("注册项已消失")?;
    let key_name = location.path.rsplit('\\').next().unwrap_or_default();
    let name = visible_name(
        {
            let mui = string(&key, "MUIVerb")?;
            if mui.is_empty() {
                string(&key, "")?
            } else {
                mui
            }
        },
        key_name,
    );
    let command_location = Location {
        path: format!("{}\\command", location.path),
        ..location.clone()
    };
    let command = open(&command_location)?
        .map(|key| string(&key, ""))
        .transpose()?
        .unwrap_or_default();
    let marker = Marker {
        location: location.clone(),
        name: "LegacyDisable".into(),
    };
    let marker_value = WindowsRegistry.read(&marker)?;
    let programmatic = raw(&key, "ProgrammaticAccessOnly")?.is_some();
    let unsupported = [
        "ExplorerCommandHandler",
        "SubCommands",
        "ExtendedSubCommandsKey",
        "CommandStateHandler",
    ]
    .iter()
    .map(|name| raw(&key, name))
    .collect::<Result<Vec<_>, _>>()?
    .iter()
    .any(Option::is_some)
        || open(&command_location)?
            .map(|key| raw(&key, "DelegateExecute"))
            .transpose()?
            .flatten()
            .is_some();
    let mut reason = if core_verb(key_name) || protected_command(&command) {
        Some("Windows 系统保留项，仅支持查看".into())
    } else if programmatic {
        Some("此项目限制为程序访问，仅支持查看".into())
    } else if unsupported {
        Some("此项目使用动态命令或子菜单，暂不支持安全关闭".into())
    } else if command.trim().is_empty() {
        Some("未发现独立执行命令，仅支持查看".into())
    } else {
        None
    };
    let registration = match registration(&location) {
        Ok(hash) => hash,
        Err(e) => {
            reason = Some(e);
            String::new()
        }
    };
    let mut detail = "仅切换菜单的显示标记，不更改执行命令。".to_string();
    if raw(&key, "Extended")?.is_some() {
        detail.push_str("此项目通常在按住 Shift 右键时显示。");
    }
    Ok(ContextMenuEntry {
        id: stable_id(&location),
        name,
        categories,
        kind: "verb".into(),
        scope: if location.system { "system" } else { "user" }.into(),
        enabled: marker_value.is_none() && !programmatic,
        can_toggle: reason.is_none(),
        managed: false,
        requires_elevation: location.system,
        registry_path: label(&location),
        command,
        detail,
        disabled_reason: reason,
        clsid: None,
        fingerprint: String::new(),
        registration,
        marker: Some(marker),
        marker_value,
        sources: vec![location],
    })
}

struct ExtensionGroup {
    clsid: String,
    names: BTreeSet<String>,
    sources: BTreeMap<Location, BTreeSet<String>>,
    negative: bool,
    unsupported: bool,
}
fn class_data(clsid: &str) -> Result<(String, String, String), String> {
    let mut parts = BTreeMap::new();
    let mut name = String::new();
    let mut server = String::new();
    for bits in [64, 32] {
        for system in [false, true] {
            let location = Location {
                system,
                view: bits,
                path: format!(r"Software\Classes\CLSID\{clsid}"),
            };
            if let Some(key) = open(&location)? {
                parts.insert(label(&location), registration(&location)?);
                if name.is_empty() {
                    name = string(&key, "")?;
                }
                for suffix in ["InprocServer32", "LocalServer32"] {
                    let loc = Location {
                        path: format!("{}\\{suffix}", location.path),
                        ..location.clone()
                    };
                    if let Some(key) = open(&loc)? {
                        let value = string(&key, "")?;
                        if !value.is_empty() && !server.split('\n').any(|line| line == value) {
                            if !server.is_empty() {
                                server.push('\n');
                            }
                            server.push_str(&value);
                        }
                    }
                }
            }
        }
    }
    Ok((
        name,
        server,
        hash(&serde_json::to_vec(&parts).map_err(|e| e.to_string())?),
    ))
}

fn extension_entry(group: ExtensionGroup) -> Result<ContextMenuEntry, String> {
    let (class_name, command, class_fingerprint) = class_data(&group.clsid)?;
    let fallback = group
        .names
        .iter()
        .find(|name| canonical_clsid(name).is_none())
        .cloned()
        .unwrap_or_else(|| group.clsid.clone());
    let name = visible_name(class_name, &fallback);
    let marker = Marker {
        location: Location {
            system: false,
            view: 64,
            path: BLOCKED_PATH.into(),
        },
        name: group.clsid.clone(),
    };
    let marker_value = WindowsRegistry.read(&marker)?;
    let mut external_blocked = false;
    for system in [false, true] {
        for bits in [64, 32] {
            if !system && bits == 64 {
                continue;
            }
            let location = Location {
                system,
                view: bits,
                path: BLOCKED_PATH.into(),
            };
            // The native HKCU marker is shared on some Windows versions. An
            // identical HKCU 32-bit value is not a separate external blocker.
            let value = WindowsRegistry.read(&Marker {
                location,
                name: group.clsid.clone(),
            })?;
            if value.is_some() && (system || value != marker_value) {
                external_blocked = true;
            }
        }
    }
    let reason = if protected_command(&command) {
        Some("Windows 系统扩展，仅支持查看".into())
    } else if command.is_empty() {
        Some("未找到扩展程序，注册可能已失效".into())
    } else if group.negative {
        Some("扩展注册已被其他软件停用，仅支持查看".into())
    } else if group.unsupported {
        Some("扩展注册值无法安全识别，仅支持查看".into())
    } else if external_blocked {
        Some("扩展被系统或其他注册视图停用，仅支持查看".into())
    } else {
        None
    };
    let sources: Vec<Location> = group.sources.keys().cloned().collect();
    let registrations = sources
        .iter()
        .map(|location| Ok((label(location), registration(location)?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let registration =
        hash(&serde_json::to_vec(&(class_fingerprint, registrations)).map_err(|e| e.to_string())?);
    let categories = group
        .sources
        .values()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let registry_path = sources.iter().map(label).collect::<Vec<_>>().join("\n");
    Ok(ContextMenuEntry {
        id: format!("extension:{}", group.clsid),
        name,
        categories,
        kind: "extension".into(),
        scope: if sources.iter().any(|s| s.system) {
            "system"
        } else {
            "user"
        }
        .into(),
        enabled: marker_value.is_none() && !external_blocked && !group.negative,
        can_toggle: reason.is_none(),
        managed: false,
        requires_elevation: false,
        registry_path,
        command,
        detail: "一个扩展可能提供多个选项，并在多个位置共用；关闭只对当前用户生效。".into(),
        disabled_reason: reason,
        clsid: Some(group.clsid),
        fingerprint: String::new(),
        registration,
        marker: Some(marker),
        marker_value,
        sources,
    })
}

fn add_handler(
    groups: &mut BTreeMap<String, ExtensionGroup>,
    location: Location,
    categories: &[String],
) -> Result<(), String> {
    let Some(key) = open(&location)? else {
        return Ok(());
    };
    let raw_default = raw(&key, "")?;
    let decoded = raw_default.as_ref().and_then(text_value);
    let value = decoded.as_deref().unwrap_or_default().trim();
    let key_name = location.path.rsplit('\\').next().unwrap_or_default();
    let negative = value.starts_with('-');
    let unsupported = raw_default.is_some() && decoded.is_none()
        || !value.is_empty() && !negative && canonical_clsid(value).is_none();
    let clsid = canonical_clsid(value.trim_start_matches('-'))
        .or_else(|| canonical_clsid(key_name))
        .ok_or_else(|| format!("{}：无法识别菜单扩展 CLSID", label(&location)))?;
    let group = groups
        .entry(clsid.clone())
        .or_insert_with(|| ExtensionGroup {
            clsid,
            names: BTreeSet::new(),
            sources: BTreeMap::new(),
            negative: false,
            unsupported: false,
        });
    group.names.insert(key_name.to_string());
    group.negative |= negative;
    group.unsupported |= unsupported;
    group
        .sources
        .entry(location)
        .or_default()
        .extend(categories.iter().cloned());
    Ok(())
}

fn roots(
    extension: Option<&str>,
    warnings: &mut Vec<String>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut roots = BTreeMap::<String, BTreeSet<String>>::new();
    for (path, categories) in [
        ("*", vec!["files"]),
        ("AllFilesystemObjects", vec!["files", "folders"]),
        ("Directory", vec!["folders"]),
        ("Folder", vec!["folders"]),
        (r"Directory\Background", vec!["folderBackground"]),
        ("DesktopBackground", vec!["desktop"]),
        ("Drive", vec!["drives"]),
        (r"SystemFileAssociations\image", vec!["fileTypes"]),
        (r"SystemFileAssociations\audio", vec!["fileTypes"]),
        (r"SystemFileAssociations\video", vec!["fileTypes"]),
        (r"SystemFileAssociations\text", vec!["fileTypes"]),
    ] {
        roots
            .entry(path.into())
            .or_default()
            .extend(categories.into_iter().map(str::to_string));
    }
    if let Some(ext) = extension {
        roots
            .entry(ext.into())
            .or_default()
            .insert("fileTypes".into());
        roots
            .entry(format!(r"SystemFileAssociations\{ext}"))
            .or_default()
            .insert("fileTypes".into());
        for system in [false, true] {
            for bits in [64, 32] {
                let location = Location {
                    system,
                    view: bits,
                    path: format!(r"Software\Classes\{ext}"),
                };
                match open(&location).and_then(|key| key.map(|key| string(&key, "")).transpose()) {
                    Ok(Some(progid)) if valid_progid(&progid) => {
                        roots.entry(progid).or_default().insert("fileTypes".into());
                    }
                    Err(e) => warnings.push(e),
                    _ => {}
                }
            }
        }
        let choice = Location {
            system: false,
            view: 64,
            path: format!(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{ext}\UserChoice"
            ),
        };
        match open(&choice).and_then(|key| key.map(|key| string(&key, "ProgId")).transpose()) {
            Ok(Some(progid)) if valid_progid(&progid) => {
                roots.entry(progid).or_default().insert("fileTypes".into());
            }
            Err(e) => warnings.push(e),
            _ => {}
        }
    }
    roots
}
fn valid_progid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value
            .chars()
            .any(|ch| ch == '\\' || ch == '/' || ch.is_control())
}

pub(super) fn scan(
    journal: &Journal,
    extension: Option<String>,
) -> Result<ContextMenuSnapshot, String> {
    let mut warnings = Vec::new();
    let scopes = roots(extension.as_deref(), &mut warnings);
    let mut verbs = BTreeMap::<(bool, String), ContextMenuEntry>::new();
    let mut groups = BTreeMap::<String, ExtensionGroup>::new();
    for (scope, categories) in scopes {
        let categories: Vec<_> = categories.into_iter().collect();
        for system in [false, true] {
            for bits in [64, 32] {
                for suffix in ["shell", r"shellex\ContextMenuHandlers"] {
                    let location = Location {
                        system,
                        view: bits,
                        path: format!(r"Software\Classes\{scope}\{suffix}"),
                    };
                    match open(&location).and_then(|key| key.map(|key| names(&key)).transpose()) {
                        Ok(Some(names)) => {
                            for name in names {
                                let child = Location {
                                    path: format!("{}\\{name}", location.path),
                                    ..location.clone()
                                };
                                if suffix == "shell" {
                                    let identity = (system, child.path.to_lowercase());
                                    if verbs.contains_key(&identity) {
                                        continue;
                                    }
                                    match verb(child, categories.clone()) {
                                        Ok(entry) => {
                                            verbs.insert(identity, entry);
                                        }
                                        Err(e) => warnings.push(e),
                                    }
                                } else if let Err(e) = add_handler(&mut groups, child, &categories)
                                {
                                    warnings.push(e);
                                }
                            }
                        }
                        Err(e) => warnings.push(e),
                        _ => {}
                    }
                }
            }
        }
    }
    // Previously disabled type-specific entries must remain discoverable without
    // remembering which extension was used in the original scan.
    for record in &journal.records {
        for location in &record.sources {
            if record.entry.kind == "verb" {
                let identity = (location.system, location.path.to_lowercase());
                if !verbs.contains_key(&identity) && open(location)?.is_some() {
                    match verb(location.clone(), record.entry.categories.clone()) {
                        Ok(entry) => {
                            verbs.insert(identity, entry);
                        }
                        Err(e) => warnings.push(e),
                    }
                }
            } else if let Err(e) =
                add_handler(&mut groups, location.clone(), &record.entry.categories)
            {
                warnings.push(e);
            }
        }
    }
    let user_paths: BTreeSet<_> = verbs
        .keys()
        .filter(|(system, _)| !system)
        .map(|(_, path)| path.clone())
        .collect();
    for ((system, path), entry) in &mut verbs {
        if *system && user_paths.contains(path) {
            entry.can_toggle = false;
            entry.disabled_reason =
                Some("当前用户存在同名菜单注册，系统注册可能被覆盖，仅支持查看".into());
        }
    }
    let mut items: Vec<_> = verbs.into_values().collect();
    for group in groups.into_values() {
        match extension_entry(group) {
            Ok(entry) => items.push(entry),
            Err(e) => warnings.push(e),
        }
    }
    for record in &journal.records {
        if !items.iter().any(|entry| entry.id == record.entry.id) {
            let mut entry = record.entry.clone();
            entry.sources = record.sources.clone();
            entry.marker = Some(record.marker.clone());
            entry.marker_value = WindowsRegistry.read(&record.marker)?;
            entry.registration = "missing".into();
            entry.enabled = entry.marker_value.is_none();
            entry.can_toggle = false;
            entry.managed = entry.marker_value == Some(record.applied.clone());
            entry.disabled_reason = Some("原菜单注册已消失；保留恢复记录，未改动现有注册表".into());
            items.push(entry);
        }
    }
    for entry in &mut items {
        if let Some(record) = journal
            .records
            .iter()
            .find(|record| record.entry.id == entry.id)
        {
            let owned_registration = if entry.kind == "extension"
                && entry.marker_value == Some(record.applied.clone())
            {
                record
                    .entry
                    .clsid
                    .as_deref()
                    .map(|clsid| extension_registration(clsid, &record.sources))
                    .transpose()?
            } else {
                None
            };
            apply_record(entry, record, owned_registration);
        }
        if !entry.enabled && !entry.managed && entry.disabled_reason.is_none() {
            entry.can_toggle = false;
            entry.disabled_reason = Some("此项目由其他软件或系统关闭，DtKit 不覆盖其设置".into());
        }
        entry.fingerprint = fingerprint(entry);
    }
    items.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    warnings.sort();
    warnings.dedup();
    warnings.truncate(100);
    let total = items.len();
    let enabled = items.iter().filter(|entry| entry.enabled).count();
    let read_only = items.iter().filter(|entry| !entry.can_toggle).count();
    Ok(ContextMenuSnapshot {
        items,
        total,
        enabled,
        disabled: total - enabled,
        read_only,
        scanned_at: Utc::now().timestamp_millis(),
        warnings,
        extension,
    })
}
