use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("dtkit-software-analysis-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn file(&self, relative: &str, bytes: usize) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![7u8; bytes]).unwrap();
    }
    fn scan(&self, budget: scanner::Budget) -> SpaceReport {
        scanner::scan(
            self.0.clone(),
            "test-request".into(),
            None,
            &AtomicBool::new(false),
            budget,
            |_| {},
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn software(name: &str, path: Option<&str>, source: &str) -> Software {
    Software {
        id: String::new(),
        name: name.into(),
        version: Some("1.0".into()),
        publisher: Some("Example".into()),
        install_location: path.map(str::to_string),
        estimated_bytes: None,
        install_date: None,
        scope: "system".into(),
        source: source.into(),
        can_analyze: path.is_some(),
        reason: None,
    }
}

fn ownership_snapshot(items: Vec<Software>, warnings: Vec<String>) -> SoftwareSnapshot {
    SoftwareSnapshot {
        items,
        warnings,
        scanned_at: 0,
        cached: false,
    }
}

#[test]
fn ownership_accepts_complete_catalog_with_only_the_shared_information_note() {
    for warnings in [Vec::new(), vec![REGISTRATION_SIZE_NOTE.to_string()]] {
        let items = ownership_from_snapshot(ownership_snapshot(
            vec![software("Editor", Some(r"C:\Product\Editor"), "HKCU")],
            warnings,
        ))
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "Editor");
    }
}

#[test]
fn ownership_rejects_partial_unreadable_truncated_and_future_warning_catalogs() {
    for warning in [
        "无法读取 HKLM 64 位软件登记：拒绝访问",
        "软件列表达到 4096 项上限，已截断",
        "软件列表读取达到 12 秒预算，当前列表可能不完整",
        "Future enumeration warning",
    ] {
        let result = ownership_from_snapshot(ownership_snapshot(
            vec![software(
                "Wide vendor registration",
                Some(r"C:\Vendor"),
                "HKCU",
            )],
            vec![REGISTRATION_SIZE_NOTE.to_string(), warning.into()],
        ));
        assert!(result.unwrap_err().contains(warning));
    }
}

#[test]
fn ownership_uses_only_explicit_valid_install_locations() {
    let registered = software("Registered", Some(r"C:\Registered"), "HKCU");
    let mut inferred = software("Inferred", Some(r"C:\Inferred"), "HKCU");
    inferred.reason = Some("安装目录由 DisplayIcon 路径推测，扫描前请确认目录归属".into());
    let mut invalid = software("Invalid", Some(r"C:\Windows"), "HKCU");
    invalid.can_analyze = false;
    let items = ownership_from_snapshot(ownership_snapshot(
        vec![
            registered,
            inferred,
            invalid,
            software("Missing", None, "HKCU"),
        ],
        Vec::new(),
    ))
    .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].name, "Registered");
}

#[test]
fn totals_and_direct_children_do_not_double_count_nested_directories() {
    let fixture = Fixture::new();
    fixture.file("root.bin", 7);
    fixture.file("a/a.bin", 11);
    fixture.file("a/nested/b.bin", 13);
    fixture.file("b/c.bin", 17);
    let report = fixture.scan(scanner::Budget::default());
    assert!(report.complete);
    assert!(!report.cancelled);
    assert_eq!(
        (report.total_bytes, report.files, report.directories),
        (48, 4, 3)
    );
    assert_eq!(report.largest_directories.len(), 2);
    assert_eq!(
        report
            .largest_directories
            .iter()
            .map(|item| item.bytes)
            .collect::<Vec<_>>(),
        vec![24, 17]
    );
    assert!(report
        .largest_directories
        .iter()
        .all(|item| Path::new(&item.path).parent() == Some(fixture.0.as_path())));
    assert_eq!(report.largest_files[0].bytes, 17);
}

#[test]
fn largest_lists_are_bounded_and_sorted() {
    let fixture = Fixture::new();
    for index in 1..=35 {
        fixture.file(&format!("dir{index}/file.bin"), index);
    }
    let report = fixture.scan(scanner::Budget::default());
    assert_eq!(report.largest_files.len(), 20);
    assert_eq!(report.largest_directories.len(), 20);
    assert_eq!(report.largest_files.first().unwrap().bytes, 35);
    assert_eq!(report.largest_files.last().unwrap().bytes, 16);
    assert!(report
        .largest_files
        .windows(2)
        .all(|pair| pair[0].bytes >= pair[1].bytes));
}

#[test]
fn hardlinks_are_logical_bytes_and_not_claimed_as_physical_usage() {
    let fixture = Fixture::new();
    fixture.file("original", 10);
    fs::hard_link(fixture.0.join("original"), fixture.0.join("second-name")).unwrap();
    let report = fixture.scan(scanner::Budget::default());
    assert_eq!((report.total_bytes, report.files), (20, 2));
    assert!(report
        .warnings
        .iter()
        .any(|warning| warning.contains("硬链接")));
}

#[test]
fn cancellation_reports_incomplete_and_releases_no_scan_slot_early() {
    let fixture = Fixture::new();
    fixture.file("file", 10);
    let report = scanner::scan(
        fixture.0.clone(),
        "cancel".into(),
        None,
        &AtomicBool::new(true),
        scanner::Budget::default(),
        |_| {},
    )
    .unwrap();
    assert!(report.cancelled);
    assert!(!report.complete);
    assert_eq!(report.files, 0);
    let manager = SoftwareAnalysisManager::default();
    let (lease, cancelled) = manager.reserve_scan("main", "cancel").unwrap();
    assert!(!manager.cancel_request("quick-host-1", "cancel").unwrap());
    assert!(!manager.cancel_request("main", "other").unwrap());
    manager.cancel_window("quick-host-1");
    assert!(!cancelled.load(Ordering::Acquire));
    assert!(manager.cancel_request("main", "cancel").unwrap());
    assert!(cancelled.load(Ordering::Acquire));
    assert!(manager.reserve_scan("main", "next").is_err());
    drop(lease);
    assert!(manager.reserve_scan("main", "next").is_ok());
}

#[test]
fn entry_and_depth_budgets_report_partial_results() {
    let fixture = Fixture::new();
    for index in 0..10 {
        fixture.file(&format!("file{index}"), 10);
    }
    let report = fixture.scan(scanner::Budget {
        max_entries: 2,
        ..scanner::Budget::default()
    });
    assert!(!report.complete);
    assert!(report.files <= 2);
    assert!(report
        .warnings
        .iter()
        .any(|warning| warning.contains("预算")));
    let nested = Fixture::new();
    nested.file("a/b/c/file", 50);
    let report = nested.scan(scanner::Budget {
        max_depth: 1,
        ..scanner::Budget::default()
    });
    assert!(!report.complete);
    assert_eq!(report.files, 0);
    assert!(report.skipped > 0);
    let report = fixture.scan(scanner::Budget {
        max_duration: std::time::Duration::ZERO,
        ..scanner::Budget::default()
    });
    assert!(!report.complete);
    assert_eq!(report.files, 0);
}

#[test]
fn linked_directories_are_skipped_and_linked_roots_rejected() {
    let fixture = Fixture::new();
    let target = Fixture::new();
    target.file("must-not-count", 999);
    let link = fixture.0.join("linked");
    #[cfg(target_os = "windows")]
    let result = std::os::windows::fs::symlink_dir(&target.0, &link);
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(&target.0, &link);
    #[cfg(not(any(target_os = "windows", unix)))]
    let result: std::io::Result<()> = Err(std::io::ErrorKind::Unsupported.into());
    if let Err(error) = result {
        #[cfg(target_os = "windows")]
        if error.raw_os_error() == Some(1314) {
            eprintln!(
                "symlink creation requires Windows developer mode or privilege; link test skipped"
            );
            return;
        }
        panic!("cannot create test symlink: {error}");
    }
    fixture.file("actual", 11);
    let report = fixture.scan(scanner::Budget::default());
    assert!(report.complete);
    assert_eq!(
        (report.total_bytes, report.files, report.skipped),
        (11, 1, 1)
    );
    assert!(paths::validate_root(link.to_str().unwrap()).is_err());
}

#[test]
fn invalid_and_shared_paths_do_not_start_a_scan() {
    for bad in [
        r"C:\",
        r"C:\Users",
        r"C:\Users\someone",
        r"C:\Users\someone\AppData",
        r"C:\Program Files",
        r"C:\Program Files (x86)\",
        r"C:\Windows\System32",
        r"\\server\share\app",
        r"\\?\C:\App",
        r"C:\Apps\..\",
        r"C:\App:stream",
        r"relative\app",
    ] {
        assert!(paths::windows_policy(bad).is_err(), "accepted {bad}");
    }
    assert!(paths::windows_policy(r"C:\Program Files\Example").is_ok());
    let fixture = Fixture::new();
    fixture.file("file", 1);
    assert!(paths::validate_root(fixture.0.join("missing").to_str().unwrap()).is_err());
    assert!(paths::validate_root(fixture.0.join("file").to_str().unwrap()).is_err());
    assert!(scanner::scan(
        fixture.0.join("missing"),
        "bad".into(),
        None,
        &AtomicBool::new(false),
        scanner::Budget::default(),
        |_| {}
    )
    .is_err());
}

#[test]
fn registry_mirrors_deduplicate_with_stable_ids_and_unknown_sizes() {
    let a = software("Example", Some(r"C:\Apps\Example"), "HKLM 32 位卸载注册表");
    let mut b = software("example", Some(r"c:/apps/example/"), "HKLM 64 位卸载注册表");
    b.estimated_bytes = Some(0);
    let mut first = catalog::Catalog::default();
    first.insert(a.clone());
    first.insert(b.clone());
    let first = first.finish();
    let mut second = catalog::Catalog::default();
    second.insert(b);
    second.insert(a);
    let second = second.finish();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].id, second[0].id);
    assert_eq!(first[0].estimated_bytes, Some(0));
    assert!(first[0].source.contains("64"));
    let mut different = catalog::Catalog::default();
    different.insert(software("Example", Some(r"C:\Apps\Example1"), "HKLM 64"));
    different.insert(software("Example", Some(r"C:\Apps\Example2"), "HKLM 64"));
    let different = different.finish();
    assert_eq!(different.len(), 2);
    assert_eq!(different[0].estimated_bytes, None);
}

#[test]
fn idle_release_prevents_in_flight_cache_refill_and_stale_id_resolution() {
    let manager = SoftwareAnalysisManager::default();
    let generation = manager.cache_generation();
    let snapshot = SoftwareSnapshot {
        items: vec![software("Example", Some(r"C:\Apps\Example"), "HKLM 64")],
        scanned_at: 1,
        warnings: vec![],
        cached: false,
    };
    manager.store_cache(snapshot.clone(), generation).unwrap();
    assert!(manager.cached().unwrap().unwrap().cached);
    manager.release_idle_cache();
    manager.store_cache(snapshot, generation).unwrap();
    assert!(manager.cached().unwrap().is_none());
    assert!(manager.resolve_path("old-id").is_err());
    let lease = manager.reserve_list().unwrap();
    assert!(manager.reserve_list().is_err());
    drop(lease);
    assert!(manager.reserve_list().is_ok());
}
