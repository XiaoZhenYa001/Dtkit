use super::storage::StorageManager;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use uuid::Uuid;

const FILE_NAME: &str = "snippets.json";
const MAX_RESULTS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snippet {
    id: String,
    title: String,
    content: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pinned: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnippetDraft {
    id: Option<String>,
    title: String,
    content: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pinned: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnippetSearchResult {
    items: Vec<Snippet>,
    total: usize,
    truncated: bool,
}

#[derive(Default)]
pub(crate) struct SnippetManager {
    cache: RwLock<Option<(PathBuf, Vec<Snippet>)>>,
    write_lock: Mutex<()>,
}

impl SnippetManager {
    pub(crate) fn invalidate(&self) {
        if let Ok(mut cache) = self.cache.write() {
            *cache = None;
        }
    }
}

fn path(storage: &StorageManager) -> Result<PathBuf, String> {
    let layout = storage.layout()?;
    fs::create_dir_all(&layout.snippets)
        .map_err(|error| format!("创建文本片段目录失败: {error}"))?;
    Ok(layout.snippets.join(FILE_NAME))
}

fn load(storage: &StorageManager, manager: &SnippetManager) -> Result<Vec<Snippet>, String> {
    let path = path(storage)?;
    if let Ok(cache) = manager.cache.read() {
        if let Some((cached_path, items)) = cache.as_ref() {
            if cached_path == &path {
                return Ok(items.clone());
            }
        }
    }
    let items = if path.is_file() {
        serde_json::from_slice(&fs::read(&path).map_err(|e| format!("读取文本片段失败: {e}"))?)
            .map_err(|e| format!("文本片段数据损坏: {e}"))?
    } else {
        Vec::new()
    };
    if let Ok(mut cache) = manager.cache.write() {
        *cache = Some((path, items.clone()));
    }
    Ok(items)
}

fn save(
    storage: &StorageManager,
    manager: &SnippetManager,
    items: &[Snippet],
) -> Result<(), String> {
    let path = path(storage)?;
    let bytes =
        serde_json::to_vec_pretty(items).map_err(|error| format!("序列化文本片段失败: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    fs::write(&temporary, bytes).map_err(|error| format!("写入文本片段失败: {error}"))?;
    if path.is_file() {
        let _ = fs::remove_file(&backup);
        fs::rename(&path, &backup).map_err(|error| format!("备份文本片段失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.is_file() {
            let _ = fs::rename(&backup, &path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("提交文本片段失败: {error}"));
    }
    let _ = fs::remove_file(backup);
    if let Ok(mut cache) = manager.cache.write() {
        *cache = Some((path, items.to_vec()));
    }
    Ok(())
}

fn validate(draft: &mut SnippetDraft) -> Result<(), String> {
    draft.title = draft.title.trim().to_string();
    if draft.title.is_empty() || draft.content.is_empty() {
        return Err("片段名称和内容不能为空".to_string());
    }
    if draft.title.chars().count() > 120 || draft.content.chars().count() > 50_000 {
        return Err("文本片段内容超出限制".to_string());
    }
    draft.tags = draft
        .tags
        .drain(..)
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .take(12)
        .collect();
    Ok(())
}

#[tauri::command]
pub(crate) fn search_snippets(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, SnippetManager>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<SnippetSearchResult, String> {
    let needle = query.unwrap_or_default().trim().to_lowercase();
    let mut matches = load(&storage, &manager)?
        .into_iter()
        .filter(|item| {
            needle.is_empty()
                || item.title.to_lowercase().contains(&needle)
                || item.content.to_lowercase().contains(&needle)
                || item
                    .tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(&needle))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    let total = matches.len();
    matches.truncate(limit.unwrap_or(80).clamp(1, MAX_RESULTS));
    Ok(SnippetSearchResult {
        truncated: total > matches.len(),
        items: matches,
        total,
    })
}

#[tauri::command]
pub(crate) fn save_snippet(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, SnippetManager>,
    mut draft: SnippetDraft,
) -> Result<Snippet, String> {
    validate(&mut draft)?;
    let _guard = manager
        .write_lock
        .lock()
        .map_err(|_| "文本片段写入状态不可用")?;
    let mut items = load(&storage, &manager)?;
    let now = Utc::now().timestamp_millis();
    let id = draft.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    if let Some(item) = items.iter_mut().find(|item| item.id == id) {
        item.title = draft.title;
        item.content = draft.content;
        item.tags = draft.tags;
        item.pinned = draft.pinned;
        item.updated_at = now;
    } else {
        items.push(Snippet {
            id: id.clone(),
            title: draft.title,
            content: draft.content,
            tags: draft.tags,
            pinned: draft.pinned,
            created_at: now,
            updated_at: now,
        });
    }
    save(&storage, &manager, &items)?;
    items
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "保存文本片段失败".into())
}

#[tauri::command]
pub(crate) fn delete_snippet(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, SnippetManager>,
    id: String,
) -> Result<(), String> {
    let _guard = manager
        .write_lock
        .lock()
        .map_err(|_| "文本片段写入状态不可用")?;
    let mut items = load(&storage, &manager)?;
    let before = items.len();
    items.retain(|item| item.id != id);
    if items.len() == before {
        return Err("文本片段不存在".to_string());
    }
    save(&storage, &manager, &items)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snippet_validation_bounds_content_and_tags() {
        let mut draft = SnippetDraft {
            id: None,
            title: "  常用回复  ".into(),
            content: "你好".into(),
            tags: (0..20).map(|n| format!("tag{n}")).collect(),
            pinned: false,
        };
        validate(&mut draft).unwrap();
        assert_eq!(draft.title, "常用回复");
        assert_eq!(draft.tags.len(), 12);
    }
}
