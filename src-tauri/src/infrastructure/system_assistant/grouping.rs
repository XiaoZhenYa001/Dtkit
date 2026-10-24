//! Conservative software attribution from registration metadata only. No directory
//! traversal, executable launch, or continuous background refresh is involved.
use super::{stable_id, StartupEntry};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
struct Installation {
    root: String,
    name: String,
}

#[derive(Clone)]
struct Catalog {
    loaded: Instant,
    items: Vec<Installation>,
    warning: Option<String>,
}

fn normalized_path(value: &str) -> Option<String> {
    let value = value.trim().trim_matches('"').replace('/', "\\");
    let bytes = value.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1..3] != *b":\\"
        || value.chars().any(char::is_control)
        || value[2..].contains(':')
    {
        return None;
    }
    let parts = value[3..]
        .split('\\')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| matches!(*part, "." | "..") || part.ends_with(['.', ' ']))
    {
        return None;
    }
    Some(format!(
        "{}:\\{}",
        (bytes[0] as char).to_ascii_lowercase(),
        parts.join("\\").to_lowercase()
    ))
}

fn within(path: &str, root: &str) -> bool {
    path.strip_prefix(root)
        .is_some_and(|tail| tail.starts_with('\\'))
}

fn shared_host(path: &str) -> bool {
    matches!(
        path.rsplit('\\').next().unwrap_or_default(),
        "cmd.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "rundll32.exe"
            | "wscript.exe"
            | "cscript.exe"
            | "mshta.exe"
            | "regsvr32.exe"
            | "svchost.exe"
            | "dllhost.exe"
            | "conhost.exe"
            | "msiexec.exe"
            | "explorer.exe"
            | "java.exe"
            | "javaw.exe"
            | "python.exe"
            | "pythonw.exe"
            | "node.exe"
            | "dotnet.exe"
    )
}

fn system_path(path: &str) -> bool {
    if path[3..]
        .split('\\')
        .next()
        .is_some_and(|part| part == "windows")
    {
        return true;
    }
    std::env::var("WINDIR")
        .ok()
        .and_then(|value| normalized_path(&value))
        .is_some_and(|root| path == root || within(path, &root))
}

fn broad_root(root: &str) -> bool {
    let leaf = root.rsplit('\\').next().unwrap_or_default();
    if matches!(
        leaf,
        "program files"
            | "program files (x86)"
            | "programdata"
            | "users"
            | "windows"
            | "common files"
            | "appdata"
            | "local"
            | "roaming"
            | "locallow"
            | "programs"
            | "apps"
            | "applications"
            | "software"
            | "portable"
            | "tools"
            | "temp"
            | "tencent"
            | "microsoft"
            | "google"
            | "adobe"
            | "apple"
            | "oracle"
            | "intel"
            | "nvidia"
            | "amd"
            | "lenovo"
            | "dell"
            | "asus"
            | "hp"
            | "realtek"
            | "samsung"
            | "acer"
            | "baidu"
            | "bytedance"
            | "netease"
            | "qihu"
            | "360"
    ) {
        return true;
    }
    for variable in [
        "WINDIR",
        "USERPROFILE",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMW6432",
        "PROGRAMDATA",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "PUBLIC",
    ] {
        if let Ok(value) = std::env::var(variable) {
            if let Some(parent) = normalized_path(&value) {
                if root == parent || (variable == "WINDIR" && within(root, &parent)) {
                    return true;
                }
            }
        }
    }
    root[3..]
        .split('\\')
        .next()
        .is_some_and(|part| part == "windows")
}

fn installations(registrations: impl IntoIterator<Item = (String, String)>) -> Vec<Installation> {
    let mut items = registrations
        .into_iter()
        .filter_map(|(name, root)| {
            let name = name.trim().to_string();
            let root = normalized_path(&root)?;
            (!name.is_empty() && !broad_root(&root)).then_some(Installation { root, name })
        })
        .collect::<Vec<_>>();
    items.sort_by_cached_key(|item| {
        (
            item.root.clone(),
            item.name.to_lowercase(),
            item.name.clone(),
        )
    });
    items.dedup_by(|left, right| {
        left.root == right.root && left.name.eq_ignore_ascii_case(&right.name)
    });
    // A shared registration root does not prove product ownership. Likewise a
    // vendor parent must not absorb a separately registered child application.
    items
        .iter()
        .filter(|candidate| {
            !items.iter().any(|other| {
                if candidate.name.eq_ignore_ascii_case(&other.name) {
                    within(&candidate.root, &other.root)
                } else {
                    candidate.root == other.root || within(&other.root, &candidate.root)
                }
            })
        })
        .cloned()
        .collect()
}

fn catalog(refresh: bool) -> Catalog {
    static CACHE: OnceLock<Mutex<Option<Catalog>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if !refresh {
        if let Some(value) = cache
            .as_ref()
            .filter(|value| value.loaded.elapsed() < CACHE_TTL)
        {
            return value.clone();
        }
    }
    let (items, warning) = match super::super::software_analysis::startup_ownership_catalog() {
        Ok(items) => (
            installations(
                items
                    .into_iter()
                    .filter_map(|item| item.install_location.map(|root| (item.name, root))),
            ),
            None,
        ),
        Err(error) => (
            Vec::new(),
            Some(format!(
                "软件归属登记暂不可用，已按程序路径保守分组：{error}"
            )),
        ),
    };
    let value = Catalog {
        loaded: Instant::now(),
        items,
        warning,
    };
    *cache = Some(value.clone());
    value
}

pub(super) fn refresh_catalog() {
    let _ = catalog(true);
}

fn attribution(
    id: &str,
    name: &str,
    target: Option<&str>,
    items: &[Installation],
) -> (String, String, &'static str) {
    let independent = || (format!("entry-{id}"), name.to_string(), "unconfirmed");
    let Some(path) = target.and_then(normalized_path) else {
        return independent();
    };
    if shared_host(&path) || system_path(&path) || !path.ends_with(".exe") {
        return independent();
    }
    if let Some(owner) = items
        .iter()
        .filter(|item| within(&path, &item.root))
        .max_by_key(|item| item.root.len())
    {
        return (
            stable_id("software", &format!("{}\0{}", owner.root, owner.name)),
            owner.name.clone(),
            "registered",
        );
    }
    let leaf = path.rsplit('\\').next().unwrap_or_default();
    let label = leaf.strip_suffix(".exe").unwrap_or(leaf);
    if label.is_empty() {
        return independent();
    }
    (
        stable_id("executable", &path),
        label.to_string(),
        "sameExecutable",
    )
}

pub(super) fn assign(entries: &mut [StartupEntry], warnings: &mut Vec<String>) {
    let catalog = catalog(false);
    if let Some(warning) = catalog.warning {
        warnings.push(warning);
    }
    for entry in entries {
        let (id, name, reason) = attribution(
            &entry.id,
            &entry.name,
            entry.target_path.as_deref(),
            &catalog.items,
        );
        entry.group_id = id;
        entry.group_name = name;
        entry.group_reason = reason.into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner(name: &str, root: &str) -> (String, String) {
        (name.into(), root.into())
    }

    #[test]
    fn one_product_groups_registry_and_shortcut_targets_in_subdirectories() {
        let items = installations([owner("QQ", r"C:\Program Files\Tencent\QQ")]);
        let first = attribution(
            "run",
            "QQMain",
            Some(r"C:\Program Files\Tencent\QQ\QQ.exe"),
            &items,
        );
        let second = attribution(
            "folder",
            "QQ Helper",
            Some(r"c:/program files/tencent/qq/bin/helper.exe"),
            &items,
        );
        assert_eq!(first, second);
        assert_eq!(first.1, "QQ");
        assert_eq!(first.2, "registered");
    }

    #[test]
    fn component_boundaries_and_different_tencent_products_do_not_merge() {
        let items = installations([
            owner("Tencent suite", r"C:\Program Files\Tencent"),
            owner("QQ", r"C:\Program Files\Tencent\QQ"),
            owner("WeChat", r"C:\Program Files\Tencent\WeChat"),
        ]);
        assert_eq!(items.len(), 2);
        let qq = attribution(
            "qq",
            "QQ",
            Some(r"C:\Program Files\Tencent\QQ\bin\qq.exe"),
            &items,
        );
        let wechat = attribution(
            "wx",
            "WeChat",
            Some(r"C:\Program Files\Tencent\WeChat\wechat.exe"),
            &items,
        );
        assert_ne!(qq.0, wechat.0);
        assert_eq!(wechat.1, "WeChat");
        assert_eq!(
            attribution(
                "backup",
                "QQ Backup",
                Some(r"C:\Program Files\Tencent\QQBackup\qq.exe"),
                &items
            )
            .2,
            "sameExecutable"
        );
    }

    #[test]
    fn longest_unambiguous_root_wins_and_broad_parent_does_not_claim_other_apps() {
        let items = installations([
            owner("Vendor suite", r"D:\Vendor"),
            owner("Editor", r"D:\Vendor\Editor"),
        ]);
        assert_eq!(items.len(), 1);
        assert_eq!(
            attribution(
                "editor",
                "Updater",
                Some(r"D:\Vendor\Editor\bin\update.exe"),
                &items
            )
            .1,
            "Editor"
        );
        assert_eq!(
            attribution(
                "other",
                "Other",
                Some(r"D:\Vendor\Unregistered\app.exe"),
                &items
            )
            .2,
            "sameExecutable"
        );
    }

    #[test]
    fn ambiguous_shared_roots_and_system_hosts_remain_independent() {
        let items = installations([
            owner("First", r"D:\SharedInstall"),
            owner("Second", r"D:\SharedInstall"),
            owner("Fake system ownership", r"C:\Windows\System32"),
        ]);
        assert!(items.is_empty());
        let first = attribution(
            "first",
            "First task",
            Some(r"C:\Windows\System32\rundll32.exe"),
            &items,
        );
        let second = attribution(
            "second",
            "Second task",
            Some(r"C:\Windows\System32\rundll32.exe"),
            &items,
        );
        assert_ne!(first.0, second.0);
        assert_eq!(first.2, "unconfirmed");
    }

    #[test]
    fn exact_executable_fallback_does_not_merge_other_programs_or_unresolved_entries() {
        let first = attribution("run", "App run", Some(r"D:\PortableProduct\app.exe"), &[]);
        let second = attribution(
            "shortcut",
            "App shortcut",
            Some(r"d:/portableproduct/APP.EXE"),
            &[],
        );
        assert_eq!(first, second);
        assert_ne!(
            first.0,
            attribution(
                "other",
                "Updater",
                Some(r"D:\PortableProduct\updater.exe"),
                &[]
            )
            .0
        );
        assert_ne!(
            attribution("one", "Missing", None, &[]).0,
            attribution("two", "Missing", None, &[]).0
        );
    }

    #[test]
    fn remote_relative_parent_and_device_paths_never_claim_ownership() {
        for root in [
            r"\\server\share\app",
            r"..\app",
            r"C:\Product\..\Other",
            r"\\?\C:\Product",
            r"C:\Product:stream",
            r"C:\",
        ] {
            assert!(installations([owner("Invalid", root)]).is_empty(), "{root}");
        }
        assert!(installations([owner("Shared", r"C:\Program Files")]).is_empty());
    }

    #[test]
    fn every_windows_target_and_non_executable_stays_independent() {
        for path in [
            r"C:\Windows\System32\backgroundTaskHost.exe",
            r"C:\Windows\System32\ApplicationFrameHost.exe",
            r"C:\Windows\System32\taskhostw.exe",
            r"D:\Product\startup.cmd",
            r"D:\Product\startup.bat",
        ] {
            let first = attribution("first", "One task", Some(path), &[]);
            let second = attribution("second", "Another task", Some(path), &[]);
            assert_eq!(first.2, "unconfirmed", "{path}");
            assert_ne!(first.0, second.0, "{path}");
        }
        assert_eq!(
            attribution(
                "normal",
                "Normal app",
                Some(r"C:\WindowsBackup\app.exe"),
                &[]
            )
            .2,
            "sameExecutable"
        );
    }

    #[test]
    fn same_product_nested_registrations_use_one_stable_installation() {
        let items = installations([
            owner("Editor", r"D:\Product"),
            owner("EDITOR", r"D:\Product\bin"),
        ]);
        assert_eq!(items.len(), 1);
        let first = attribution("main", "Editor", Some(r"D:\Product\app.exe"), &items);
        let second = attribution(
            "helper",
            "Helper",
            Some(r"D:\Product\bin\helper.exe"),
            &items,
        );
        assert_eq!(first, second);
    }
}
