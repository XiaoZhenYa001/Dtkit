use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SEARCH_BUDGET: Duration = Duration::from_millis(750);
const MAX_VISITED_ENTRIES: usize = 8_000;

#[derive(Default)]
pub(crate) struct LocalSearchManager {
    generation: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalSearchItem {
    name: String,
    path: String,
    parent: String,
    is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalSearchResult {
    items: Vec<LocalSearchItem>,
    truncated: bool,
    elapsed_ms: u128,
    roots_searched: usize,
}

fn common_search_roots() -> Vec<PathBuf> {
    let candidates = [
        dirs::desktop_dir(),
        dirs::download_dir(),
        dirs::document_dir(),
        dirs::picture_dir(),
        dirs::audio_dir(),
        dirs::video_dir(),
    ];
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .flatten()
        .filter_map(|path| fs::canonicalize(path).ok())
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn validate_query(query: &str) -> Result<String, String> {
    let query = query.trim().chars().take(100).collect::<String>();
    if query.chars().count() < 2 {
        return Err("文件搜索至少需要 2 个字符".to_string());
    }
    Ok(query.to_lowercase())
}

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "node_modules" | "$recycle.bin" | "system volume information"
        )
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn search_roots(
    roots: Vec<PathBuf>,
    query: &str,
    limit: usize,
    generation: &AtomicU64,
    expected_generation: u64,
) -> LocalSearchResult {
    let started = Instant::now();
    let mut queue = VecDeque::from(roots.clone());
    let mut matches = Vec::new();
    let mut visited = 0usize;
    let mut truncated = false;

    while let Some(directory) = queue.pop_front() {
        if generation.load(Ordering::Relaxed) != expected_generation
            || started.elapsed() >= SEARCH_BUDGET
            || visited >= MAX_VISITED_ENTRIES
        {
            truncated = true;
            break;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited >= MAX_VISITED_ENTRIES || started.elapsed() >= SEARCH_BUDGET {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_hidden_name(&name) {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                continue;
            }
            let is_directory = metadata.is_dir();
            if is_directory {
                queue.push_back(entry.path());
            }
            if name.to_lowercase().contains(query) {
                let path = entry.path();
                matches.push(LocalSearchItem {
                    name,
                    parent: path
                        .parent()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .into_owned(),
                    path: path.to_string_lossy().into_owned(),
                    is_directory,
                });
                if matches.len() >= limit {
                    truncated = !queue.is_empty();
                    break;
                }
            }
        }
        if matches.len() >= limit || truncated {
            break;
        }
    }

    matches.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .find(query)
            .cmp(&right.name.to_lowercase().find(query))
            .then_with(|| left.name.len().cmp(&right.name.len()))
    });
    LocalSearchResult {
        items: matches,
        truncated,
        elapsed_ms: started.elapsed().as_millis(),
        roots_searched: roots.len(),
    }
}

fn is_within_common_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn is_safe_to_open(path: &Path) -> bool {
    if path.is_dir() {
        return true;
    }
    !matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "exe" | "com" | "bat" | "cmd" | "ps1" | "msi" | "scr" | "lnk" | "url"
    )
}

#[tauri::command]
pub(crate) async fn search_local_files(
    manager: tauri::State<'_, LocalSearchManager>,
    query: String,
    limit: Option<usize>,
) -> Result<LocalSearchResult, String> {
    let query = validate_query(&query)?;
    let roots = common_search_roots();
    let limit = limit.unwrap_or(24).clamp(1, 40);
    let generation = manager.generation.clone();
    let expected_generation = generation.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        search_roots(roots, &query, limit, &generation, expected_generation)
    })
    .await
    .map_err(|error| format!("文件搜索任务失败: {error}"))
}

#[tauri::command]
pub(crate) async fn open_local_search_result(path: String) -> Result<(), String> {
    let canonical = fs::canonicalize(&path).map_err(|_| "文件已移动或不存在".to_string())?;
    if !is_within_common_root(&canonical, &common_search_roots()) {
        return Err("只能打开常用目录中的搜索结果".to_string());
    }
    if !is_safe_to_open(&canonical) {
        return Err("为避免意外执行程序，命令面板不能直接打开可执行文件或脚本".to_string());
    }
    opener::open(&canonical).map_err(|error| format!("打开失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_queries_are_rejected() {
        assert!(validate_query("a").is_err());
        assert!(validate_query("  ").is_err());
        assert_eq!(validate_query(" Report ").unwrap(), "report");
    }

    #[test]
    fn root_boundary_does_not_accept_sibling_prefixes() {
        let root = PathBuf::from("C:/Users/demo/Documents");
        assert!(is_within_common_root(
            Path::new("C:/Users/demo/Documents/report.txt"),
            &[root.clone()]
        ));
        assert!(!is_within_common_root(
            Path::new("C:/Users/demo/Documents-old/report.txt"),
            &[root]
        ));
    }

    #[test]
    fn hidden_and_expensive_directories_are_skipped() {
        assert!(is_hidden_name(".git"));
        assert!(is_hidden_name("node_modules"));
        assert!(!is_hidden_name("Reports"));
    }

    #[test]
    fn executable_search_results_cannot_be_launched() {
        assert!(!is_safe_to_open(Path::new("download.exe")));
        assert!(!is_safe_to_open(Path::new("install.CMD")));
        assert!(is_safe_to_open(Path::new("report.pdf")));
    }
}
