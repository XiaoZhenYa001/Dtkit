use super::storage::StorageManager;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::Duration;
use tauri::AppHandle;
use uuid::Uuid;

const VAULT_FILE: &str = "vault.dpapi";
const SETTINGS_FILE: &str = "password-settings.json";
const VAULT_VERSION: u32 = 1;
const TRASH_RETENTION_DAYS: i64 = 30;
const MAX_IMPORT_BYTES: u64 = 32 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT: usize = 200;
const MAX_SEARCH_LIMIT: usize = 500;
const TRASH_RETENTION_MILLIS: i64 = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordRecord {
    id: String,
    service: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    email: String,
    password: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    last_used_at: Option<i64>,
    #[serde(default)]
    use_count: u64,
    #[serde(default)]
    custom_fields: Vec<PasswordCustomField>,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    deleted_at: Option<i64>,
}

impl PasswordRecord {
    fn safe_summary(&self) -> PasswordSummary {
        PasswordSummary {
            id: self.id.clone(),
            service: self.service.clone(),
            username: self.username.clone(),
            note: self.note.clone(),
            category: self.category.clone(),
            favorite: self.favorite,
            last_used_at: self.last_used_at,
            deleted_at: self.deleted_at,
        }
    }

    fn duplicate_key(&self) -> String {
        duplicate_key(&self.service, &self.username)
    }

    fn wipe_secret(&mut self) {
        wipe_string(&mut self.password);
        for field in &mut self.custom_fields {
            if field.sensitive {
                wipe_string(&mut field.value);
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordCustomField {
    #[serde(default)]
    label: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    sensitive: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordVault {
    version: u32,
    #[serde(default)]
    items: Vec<PasswordRecord>,
}

impl Drop for PasswordVault {
    fn drop(&mut self) {
        for item in &mut self.items {
            item.wipe_secret();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordSummary {
    id: String,
    service: String,
    username: String,
    note: String,
    category: String,
    favorite: bool,
    last_used_at: Option<i64>,
    deleted_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordOverview {
    total: usize,
    favorite_count: usize,
    recent_count: usize,
    trash_count: usize,
    categories: Vec<PasswordCategoryCount>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasswordCategoryCount {
    name: String,
    count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordSearchResponse {
    items: Vec<PasswordSummary>,
    total: usize,
    truncated: bool,
}

struct IndexedPassword {
    summary: PasswordSummary,
    search_text: String,
    service: Range<usize>,
    username: Range<usize>,
    email: Range<usize>,
    phone: Range<usize>,
    note: Range<usize>,
    category: Range<usize>,
    url: Range<usize>,
}

struct PasswordIndexCache {
    vault_path: PathBuf,
    items: Vec<IndexedPassword>,
    next_purge_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordDraft {
    id: Option<String>,
    service: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    email: String,
    password: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    custom_fields: Vec<PasswordCustomField>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordEditorEntry {
    id: String,
    service: String,
    username: String,
    phone: String,
    email: String,
    password: String,
    note: String,
    category: String,
    url: String,
    favorite: bool,
    custom_fields: Vec<PasswordCustomField>,
}

impl Drop for PasswordEditorEntry {
    fn drop(&mut self) {
        wipe_string(&mut self.password);
        for field in &mut self.custom_fields {
            if field.sensitive {
                wipe_string(&mut field.value);
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordDetail {
    id: String,
    service: String,
    username: String,
    phone: String,
    email: String,
    note: String,
    category: String,
    url: String,
    favorite: bool,
    created_at: i64,
    updated_at: i64,
    last_used_at: Option<i64>,
    use_count: u64,
    custom_fields: Vec<PasswordDetailField>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasswordDetailField {
    index: usize,
    label: String,
    value: String,
    sensitive: bool,
    has_value: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordSecurityReport {
    total: usize,
    weak: usize,
    reused: usize,
    stale: usize,
    incomplete: usize,
    issues: Vec<PasswordSecurityIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasswordSecurityIssue {
    id: String,
    service: String,
    kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordSettings {
    clipboard_clear_seconds: u64,
}

impl Default for PasswordSettings {
    fn default() -> Self {
        Self {
            clipboard_clear_seconds: 30,
        }
    }
}

impl PasswordSettings {
    fn validate(&self) -> Result<(), String> {
        if matches!(self.clipboard_clear_seconds, 0 | 15 | 30 | 60) {
            Ok(())
        } else {
            Err("剪贴板清理时间只能是 15 秒、30 秒、1 分钟或永不".to_string())
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DuplicateStrategy {
    Skip,
    Keep,
    Overwrite,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreview {
    token: String,
    format: String,
    total: usize,
    ready: usize,
    duplicates: usize,
    invalid: usize,
    warnings: Vec<String>,
    items: Vec<PasswordSummary>,
    issues: Vec<ImportIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportIssue {
    source: String,
    service: String,
    username: String,
    email: String,
    note: String,
    category: String,
    errors: Vec<String>,
}

struct ParsedImport {
    entries: Vec<PasswordRecord>,
    total: usize,
    invalid: usize,
    warnings: Vec<String>,
    issues: Vec<ImportIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    imported: usize,
    skipped: usize,
    overwritten: usize,
}

struct PendingImport {
    entries: Vec<PasswordRecord>,
}

impl Drop for PendingImport {
    fn drop(&mut self) {
        for entry in &mut self.entries {
            entry.wipe_secret();
        }
    }
}

#[derive(Default)]
pub(crate) struct PasswordVaultManager {
    pending: Mutex<HashMap<String, PendingImport>>,
    index: RwLock<Option<PasswordIndexCache>>,
    index_build: Mutex<()>,
}

impl PasswordVaultManager {
    pub(crate) fn reset_for_storage_change(&self) {
        self.release_idle_state();
    }

    pub(crate) fn release_idle_state(&self) {
        // Wait for any in-flight index build or vault mutation, then release the final state.
        let _access = self.index_build.lock().ok();
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        self.invalidate_index();
    }

    fn invalidate_index(&self) {
        if let Ok(mut index) = self.index.write() {
            *index = None;
        }
    }

    fn replace_index(&self, vault_path: PathBuf, vault: &PasswordVault) {
        if let Ok(mut index) = self.index.write() {
            *index = Some(PasswordIndexCache::from_vault(vault_path, vault));
        }
    }

    fn search_cached(
        &self,
        vault_path: &Path,
        now: i64,
        scope: &SearchScope,
        needle: &str,
        include_deleted: bool,
        view: &str,
        category: &str,
        limit: usize,
    ) -> Option<PasswordSearchResponse> {
        let index = self.index.read().ok()?;
        let cache = index.as_ref()?;
        if cache.vault_path != vault_path
            || cache
                .next_purge_at
                .is_some_and(|next_purge_at| now >= next_purge_at)
        {
            return None;
        }
        Some(cache.search(scope, needle, include_deleted, view, category, limit))
    }

    fn overview_cached(&self, vault_path: &Path, now: i64) -> Option<PasswordOverview> {
        let index = self.index.read().ok()?;
        let cache = index.as_ref()?;
        if cache.vault_path != vault_path
            || cache
                .next_purge_at
                .is_some_and(|next_purge_at| now >= next_purge_at)
        {
            return None;
        }
        Some(cache.overview())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RePassCardJson {
    app: String,
    version: u32,
    #[serde(default)]
    count: usize,
    #[serde(default)]
    passwords: Vec<ImportedPassword>,
}

#[derive(Debug, Deserialize)]
struct ImportedPassword {
    #[serde(default)]
    service: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    category: String,
}

fn wipe_string(value: &mut String) {
    // Password bytes must not remain in reusable heap storage after the owning value is dropped.
    unsafe {
        for byte in value.as_bytes_mut() {
            std::ptr::write_volatile(byte, 0);
        }
    }
    value.clear();
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

fn duplicate_key(service: &str, username: &str) -> String {
    format!("{}\u{1f}{}", normalize(service), normalize(username))
}

fn validate_draft(draft: &PasswordDraft) -> Result<(), String> {
    if draft.service.trim().is_empty() {
        return Err("名称不能为空".to_string());
    }
    if draft.password.is_empty() {
        return Err("密码不能为空".to_string());
    }
    if draft.service.chars().count() > 200
        || draft.username.chars().count() > 500
        || draft.phone.chars().count() > 100
        || draft.email.chars().count() > 500
        || draft.note.chars().count() > 10_000
        || draft.category.chars().count() > 200
        || draft.url.chars().count() > 2_000
        || draft.password.chars().count() > 10_000
        || draft.custom_fields.len() > 20
        || draft
            .custom_fields
            .iter()
            .any(|field| field.label.chars().count() > 100 || field.value.chars().count() > 10_000)
    {
        return Err("密码条目包含超出限制的字段".to_string());
    }
    Ok(())
}

fn vault_path(storage: &StorageManager) -> Result<PathBuf, String> {
    let layout = storage.layout()?;
    if !layout.writable {
        return Err(layout
            .warning
            .unwrap_or_else(|| "数据根目录当前不可写".to_string()));
    }
    fs::create_dir_all(&layout.passwords)
        .map_err(|error| format!("创建密码库目录失败: {error}"))?;
    Ok(layout.passwords.join(VAULT_FILE))
}

fn expected_vault_path(storage: &StorageManager) -> Result<PathBuf, String> {
    let layout = storage.layout()?;
    if !layout.writable {
        return Err(layout
            .warning
            .unwrap_or_else(|| "数据根目录当前不可写".to_string()));
    }
    Ok(layout.passwords.join(VAULT_FILE))
}

fn settings_path(storage: &StorageManager) -> Result<PathBuf, String> {
    storage.config_file(SETTINGS_FILE)
}

fn load_vault(storage: &StorageManager) -> Result<PasswordVault, String> {
    let path = vault_path(storage)?;
    if !path.is_file() {
        return Ok(PasswordVault {
            version: VAULT_VERSION,
            items: Vec::new(),
        });
    }
    let encrypted = fs::read(&path).map_err(|error| format!("读取密码库失败: {error}"))?;
    let mut plaintext = unprotect_for_current_user(&encrypted)?;
    let result = serde_json::from_slice::<PasswordVault>(&plaintext)
        .map_err(|_| "密码库内容损坏，已停止读取且不会覆盖原文件".to_string());
    plaintext.fill(0);
    let vault = result?;
    if vault.version != VAULT_VERSION {
        return Err("密码库版本暂不受支持".to_string());
    }
    Ok(vault)
}

fn save_vault(storage: &StorageManager, vault: &PasswordVault) -> Result<(), String> {
    let path = vault_path(storage)?;
    let mut plaintext =
        serde_json::to_vec(vault).map_err(|error| format!("序列化密码库失败: {error}"))?;
    let encrypted = match protect_for_current_user(&plaintext) {
        Ok(encrypted) => encrypted,
        Err(error) => {
            plaintext.fill(0);
            return Err(error);
        }
    };
    let mut verified = match unprotect_for_current_user(&encrypted) {
        Ok(verified) => verified,
        Err(error) => {
            plaintext.fill(0);
            return Err(error);
        }
    };
    let integrity_matches = verified == plaintext;
    verified.fill(0);
    plaintext.fill(0);
    if !integrity_matches {
        return Err("Windows 密码库加密完整性校验失败，未替换原文件".to_string());
    }
    atomic_write(&path, &encrypted)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "密码库路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建密码库目录失败: {error}"))?;
    let temporary = parent.join(format!(".{VAULT_FILE}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|error| format!("写入密码库临时文件失败: {error}"))?;

    // Verify the complete encrypted blob before replacing the last known-good vault.
    let verify =
        fs::read(&temporary).map_err(|error| format!("校验密码库临时文件失败: {error}"))?;
    if verify != bytes {
        let _ = fs::remove_file(&temporary);
        return Err("密码库写入完整性校验失败".to_string());
    }

    let backup = parent.join(format!(".{VAULT_FILE}.backup"));
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|error| format!("备份旧密码库失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!("提交密码库失败: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn purge_expired(vault: &mut PasswordVault, now: i64) -> bool {
    let cutoff = now - TRASH_RETENTION_MILLIS;
    let before = vault.items.len();
    vault.items.retain_mut(|entry| {
        let keep = entry.deleted_at.is_none_or(|deleted| deleted > cutoff);
        if !keep {
            entry.wipe_secret();
        }
        keep
    });
    vault.items.len() != before
}

#[derive(Debug, PartialEq, Eq)]
enum SearchScope {
    Global,
    Service,
    Username,
    Email,
    Phone,
    Note,
    Category,
    Url,
}

fn parse_search(query: &str) -> (SearchScope, String) {
    let trimmed = query.trim();
    let Some(rest) = trimmed.strip_prefix('#') else {
        return (SearchScope::Global, normalize(trimmed));
    };
    let Some((field, value)) = rest.split_once(char::is_whitespace) else {
        return (SearchScope::Global, normalize(trimmed));
    };
    let scope = match field.to_lowercase().as_str() {
        "service" | "name" | "名称" | "服务" => SearchScope::Service,
        "username" | "user" | "用户名" => SearchScope::Username,
        "email" | "邮箱" => SearchScope::Email,
        "phone" | "手机号" | "电话" => SearchScope::Phone,
        "note" | "备注" => SearchScope::Note,
        "category" | "分类" => SearchScope::Category,
        "url" | "website" | "网址" | "网站" => SearchScope::Url,
        _ => SearchScope::Global,
    };
    (scope, normalize(value))
}

fn append_normalized(target: &mut String, value: &str) -> Range<usize> {
    if !target.is_empty() {
        target.push('\u{1f}');
    }
    let start = target.len();
    target.push_str(&normalize(value));
    start..target.len()
}

impl IndexedPassword {
    fn from_record(entry: &PasswordRecord) -> Self {
        let mut search_text = String::new();
        let service = append_normalized(&mut search_text, &entry.service);
        let username = append_normalized(&mut search_text, &entry.username);
        let email = append_normalized(&mut search_text, &entry.email);
        let phone = append_normalized(&mut search_text, &entry.phone);
        let note = append_normalized(&mut search_text, &entry.note);
        let category = append_normalized(&mut search_text, &entry.category);
        let url = append_normalized(&mut search_text, &entry.url);
        Self {
            summary: entry.safe_summary(),
            search_text,
            service,
            username,
            email,
            phone,
            note,
            category,
            url,
        }
    }

    fn field(&self, range: &Range<usize>) -> &str {
        &self.search_text[range.clone()]
    }

    fn matches(&self, scope: &SearchScope, needle: &str) -> bool {
        if needle.is_empty() {
            return true;
        }
        match scope {
            SearchScope::Global => self.search_text.contains(needle),
            SearchScope::Service => self.field(&self.service).contains(needle),
            SearchScope::Username => self.field(&self.username).contains(needle),
            SearchScope::Email => self.field(&self.email).contains(needle),
            SearchScope::Phone => self.field(&self.phone).contains(needle),
            SearchScope::Note => self.field(&self.note).contains(needle),
            SearchScope::Category => self.field(&self.category).contains(needle),
            SearchScope::Url => self.field(&self.url).contains(needle),
        }
    }
}

impl PasswordIndexCache {
    fn from_vault(vault_path: PathBuf, vault: &PasswordVault) -> Self {
        let mut items = vault
            .items
            .iter()
            .map(IndexedPassword::from_record)
            .collect::<Vec<_>>();
        items.sort_by(|left, right| {
            left.summary
                .deleted_at
                .is_some()
                .cmp(&right.summary.deleted_at.is_some())
                .then_with(|| right.summary.last_used_at.cmp(&left.summary.last_used_at))
                .then_with(|| right.summary.favorite.cmp(&left.summary.favorite))
                .then_with(|| left.field(&left.service).cmp(right.field(&right.service)))
        });
        let next_purge_at = vault
            .items
            .iter()
            .filter_map(|entry| entry.deleted_at)
            .map(|deleted_at| deleted_at.saturating_add(TRASH_RETENTION_MILLIS))
            .min();
        Self {
            vault_path,
            items,
            next_purge_at,
        }
    }

    fn search(
        &self,
        scope: &SearchScope,
        needle: &str,
        include_deleted: bool,
        view: &str,
        category: &str,
        limit: usize,
    ) -> PasswordSearchResponse {
        let mut items = Vec::with_capacity(limit.min(self.items.len()));
        let mut total = 0;
        for entry in self.items.iter().filter(|entry| {
            let visible = if include_deleted {
                entry.summary.deleted_at.is_some()
            } else {
                entry.summary.deleted_at.is_none()
            };
            let in_view = match view {
                "favorites" => entry.summary.favorite,
                "recent" => entry.summary.last_used_at.is_some(),
                "category" => entry.summary.category == category,
                _ => true,
            };
            visible && in_view && entry.matches(scope, needle)
        }) {
            total += 1;
            if items.len() < limit {
                items.push(entry.summary.clone());
            }
        }
        PasswordSearchResponse {
            truncated: total > items.len(),
            items,
            total,
        }
    }

    fn overview(&self) -> PasswordOverview {
        let mut categories = HashMap::<String, usize>::new();
        let mut total = 0;
        let mut favorite_count = 0;
        let mut recent_count = 0;
        let mut trash_count = 0;
        for entry in &self.items {
            if entry.summary.deleted_at.is_some() {
                trash_count += 1;
                continue;
            }
            total += 1;
            favorite_count += usize::from(entry.summary.favorite);
            recent_count += usize::from(entry.summary.last_used_at.is_some());
            let category = entry.summary.category.trim();
            if !category.is_empty() {
                *categories.entry(category.to_string()).or_default() += 1;
            }
        }
        let mut categories = categories
            .into_iter()
            .map(|(name, count)| PasswordCategoryCount { name, count })
            .collect::<Vec<_>>();
        categories.sort_by(|left, right| {
            right
                .count
                .cmp(&left.count)
                .then_with(|| left.name.cmp(&right.name))
        });
        PasswordOverview {
            total,
            favorite_count,
            recent_count,
            trash_count,
            categories,
        }
    }
}

fn imported_record(entry: ImportedPassword) -> Option<PasswordRecord> {
    if entry.service.trim().is_empty() || entry.password.is_empty() {
        return None;
    }
    let now = Utc::now().timestamp_millis();
    Some(PasswordRecord {
        id: Uuid::new_v4().to_string(),
        service: entry.service.trim().to_string(),
        username: entry.username,
        phone: entry.phone,
        email: entry.email,
        password: entry.password,
        note: entry.note,
        category: entry.category,
        url: String::new(),
        favorite: false,
        last_used_at: None,
        use_count: 0,
        custom_fields: Vec::new(),
        created_at: now,
        updated_at: now,
        deleted_at: None,
    })
}

fn import_validation_errors(entry: &ImportedPassword) -> Vec<String> {
    let mut errors = Vec::with_capacity(2);
    if entry.service.trim().is_empty() {
        errors.push("名称为空".to_string());
    }
    if entry.password.is_empty() {
        errors.push("密码为空".to_string());
    }
    errors
}

fn safe_import_metadata(value: &str) -> String {
    const MAX_CHARS: usize = 120;
    let trimmed = value.trim();
    let mut safe = trimmed.chars().take(MAX_CHARS).collect::<String>();
    if trimmed.chars().count() > MAX_CHARS {
        safe.push('…');
    }
    safe
}

fn import_issue(source: String, entry: &ImportedPassword, errors: Vec<String>) -> ImportIssue {
    ImportIssue {
        source,
        service: safe_import_metadata(&entry.service),
        username: safe_import_metadata(&entry.username),
        email: safe_import_metadata(&entry.email),
        note: safe_import_metadata(&entry.note),
        category: safe_import_metadata(&entry.category),
        errors,
    }
}

fn parse_json_import(bytes: &[u8]) -> Result<ParsedImport, String> {
    let mut payload: RePassCardJson =
        serde_json::from_slice(bytes).map_err(|error| format!("JSON 格式无效: {error}"))?;
    if payload.app != "REPassCard" || payload.version != 1 {
        return Err("仅支持 REPassCard JSON v1".to_string());
    }
    let total = payload.passwords.len();
    let mut warnings = Vec::new();
    if payload.count != total {
        warnings.push(format!(
            "文件声明 {} 条，但实际包含 {} 条；已按实际条目数处理",
            payload.count, total
        ));
    }
    let mut entries = Vec::with_capacity(total);
    let mut issues = Vec::new();
    let mut invalid = 0;
    for (index, mut imported) in payload.passwords.drain(..).enumerate() {
        let errors = import_validation_errors(&imported);
        if errors.is_empty() {
            if let Some(entry) = imported_record(imported) {
                entries.push(entry);
            }
        } else {
            invalid += 1;
            if issues.len() < 100 {
                issues.push(import_issue(format!("第 {} 条", index + 1), &imported, errors));
            }
            wipe_string(&mut imported.password);
        }
    }
    if invalid > issues.len() {
        warnings.push(format!("另有 {} 条错误条目未展开显示", invalid - issues.len()));
    }
    Ok(ParsedImport { entries, total, invalid, warnings, issues })
}

fn csv_column(headers: &csv::StringRecord, aliases: &[&str]) -> Option<usize> {
    headers.iter().position(|header| {
        let normalized = header.trim_start_matches('\u{feff}').trim().to_lowercase();
        aliases.iter().any(|alias| normalized == *alias)
    })
}

fn parse_csv_import(bytes: &[u8]) -> Result<ParsedImport, String> {
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(bytes);
    let headers = reader
        .headers()
        .map_err(|error| format!("CSV 表头无效: {error}"))?
        .clone();
    let service = csv_column(&headers, &["服务", "service"])
        .ok_or_else(|| "CSV 缺少“服务/service”列".to_string())?;
    let username = csv_column(&headers, &["用户名", "username"]);
    let phone = csv_column(&headers, &["手机号", "phone"]);
    let email = csv_column(&headers, &["邮箱", "email"]);
    let password = csv_column(&headers, &["密码", "password"])
        .ok_or_else(|| "CSV 缺少“密码/password”列".to_string())?;
    let note = csv_column(&headers, &["备注", "note"]);
    let category = csv_column(&headers, &["分类", "category"]);
    let mut total = 0;
    let mut entries = Vec::new();
    let mut invalid = 0;
    let mut issues = Vec::new();
    let mut warnings = Vec::new();
    for record_result in reader.records() {
        let record = match record_result {
            Ok(record) => record,
            Err(error) => {
                total += 1;
                invalid += 1;
                if issues.len() < 100 {
                    let line = error.position().map(|position| position.line()).unwrap_or((total + 1) as u64);
                    issues.push(ImportIssue {
                        source: format!("第 {line} 行"),
                        service: String::new(),
                        username: String::new(),
                        email: String::new(),
                        note: String::new(),
                        category: String::new(),
                        errors: vec!["CSV 行格式无效".to_string()],
                    });
                }
                continue;
            }
        };
        total += 1;
        // csv::StringRecord keeps the position immediately before the record; account for the header line.
        let source_line = record
            .position()
            .map(|position| position.line().saturating_add(1))
            .unwrap_or((total + 1) as u64);
        let value = |column: Option<usize>| {
            column
                .and_then(|index| record.get(index))
                .unwrap_or_default()
                .to_string()
        };
        let mut imported = ImportedPassword {
            service: record.get(service).unwrap_or_default().to_string(),
            username: value(username),
            phone: value(phone),
            email: value(email),
            password: record.get(password).unwrap_or_default().to_string(),
            note: value(note),
            category: value(category),
        };
        let errors = import_validation_errors(&imported);
        if errors.is_empty() {
            if let Some(entry) = imported_record(imported) {
                entries.push(entry);
            }
        } else {
            invalid += 1;
            if issues.len() < 100 {
                issues.push(import_issue(format!("第 {source_line} 行"), &imported, errors));
            }
            wipe_string(&mut imported.password);
        }
    }
    if invalid > issues.len() {
        warnings.push(format!("另有 {} 条错误条目未展开显示", invalid - issues.len()));
    }
    Ok(ParsedImport { entries, total, invalid, warnings, issues })
}

fn load_settings(storage: &StorageManager) -> PasswordSettings {
    let Ok(path) = settings_path(storage) else {
        return PasswordSettings::default();
    };
    let Ok(bytes) = fs::read(path) else {
        return PasswordSettings::default();
    };
    serde_json::from_slice::<PasswordSettings>(&bytes)
        .ok()
        .filter(|settings| settings.validate().is_ok())
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn list_passwords(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    query: Option<String>,
    include_deleted: Option<bool>,
    view: Option<String>,
    category: Option<String>,
    limit: Option<usize>,
) -> Result<PasswordSearchResponse, String> {
    let now = Utc::now().timestamp_millis();
    let vault_path = expected_vault_path(&storage)?;
    let (scope, needle) = parse_search(query.as_deref().unwrap_or_default());
    let include_deleted = include_deleted.unwrap_or(false);
    let view = view.unwrap_or_else(|| "all".to_string());
    let category = category.unwrap_or_default();
    let limit = limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    if let Some(response) = manager.search_cached(
        &vault_path,
        now,
        &scope,
        &needle,
        include_deleted,
        &view,
        &category,
        limit,
    ) {
        return Ok(response);
    }

    // Only one window may decrypt and build the shared metadata index at a time.
    let _build = manager
        .index_build
        .lock()
        .map_err(|_| "密码索引状态不可用".to_string())?;
    if let Some(response) = manager.search_cached(
        &vault_path,
        now,
        &scope,
        &needle,
        include_deleted,
        &view,
        &category,
        limit,
    ) {
        return Ok(response);
    }

    let mut vault = load_vault(&storage)?;
    if purge_expired(&mut vault, now) {
        save_vault(&storage, &vault)?;
    }
    manager.replace_index(vault_path.clone(), &vault);
    manager
        .search_cached(
            &vault_path,
            now,
            &scope,
            &needle,
            include_deleted,
            &view,
            &category,
            limit,
        )
        .ok_or_else(|| "密码索引构建失败".to_string())
}

#[tauri::command]
pub(crate) fn get_password_entry_for_edit(
    storage: tauri::State<'_, StorageManager>,
    id: String,
) -> Result<PasswordEditorEntry, String> {
    let vault = load_vault(&storage)?;
    let entry = vault
        .items
        .iter()
        .find(|entry| entry.id == id && entry.deleted_at.is_none())
        .ok_or_else(|| "密码条目不存在或已进入回收站".to_string())?;
    Ok(PasswordEditorEntry {
        id: entry.id.clone(),
        service: entry.service.clone(),
        username: entry.username.clone(),
        phone: entry.phone.clone(),
        email: entry.email.clone(),
        password: entry.password.clone(),
        note: entry.note.clone(),
        category: entry.category.clone(),
        url: entry.url.clone(),
        favorite: entry.favorite,
        custom_fields: entry.custom_fields.clone(),
    })
}

#[tauri::command]
pub(crate) fn get_password_detail(
    storage: tauri::State<'_, StorageManager>,
    id: String,
) -> Result<PasswordDetail, String> {
    let vault = load_vault(&storage)?;
    let entry = vault
        .items
        .iter()
        .find(|entry| entry.id == id && entry.deleted_at.is_none())
        .ok_or_else(|| "密码条目不存在或已进入回收站".to_string())?;
    Ok(PasswordDetail {
        id: entry.id.clone(),
        service: entry.service.clone(),
        username: entry.username.clone(),
        phone: entry.phone.clone(),
        email: entry.email.clone(),
        note: entry.note.clone(),
        category: entry.category.clone(),
        url: entry.url.clone(),
        favorite: entry.favorite,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        last_used_at: entry.last_used_at,
        use_count: entry.use_count,
        custom_fields: entry
            .custom_fields
            .iter()
            .enumerate()
            .map(|(index, field)| PasswordDetailField {
                index,
                label: field.label.clone(),
                value: if field.sensitive {
                    String::new()
                } else {
                    field.value.clone()
                },
                sensitive: field.sensitive,
                has_value: !field.value.is_empty(),
            })
            .collect(),
    })
}

#[tauri::command]
pub(crate) fn get_password_overview(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
) -> Result<PasswordOverview, String> {
    let now = Utc::now().timestamp_millis();
    let vault_path = expected_vault_path(&storage)?;
    if let Some(overview) = manager.overview_cached(&vault_path, now) {
        return Ok(overview);
    }
    let _build = manager
        .index_build
        .lock()
        .map_err(|_| "密码索引状态不可用".to_string())?;
    if let Some(overview) = manager.overview_cached(&vault_path, now) {
        return Ok(overview);
    }
    let mut vault = load_vault(&storage)?;
    if purge_expired(&mut vault, now) {
        save_vault(&storage, &vault)?;
    }
    manager.replace_index(vault_path.clone(), &vault);
    manager
        .overview_cached(&vault_path, now)
        .ok_or_else(|| "密码概览构建失败".to_string())
}

#[tauri::command]
pub(crate) fn set_password_favorite(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库写入状态不可用".to_string())?;
    let mut vault = load_vault(&storage)?;
    let entry = vault
        .items
        .iter_mut()
        .find(|entry| entry.id == id && entry.deleted_at.is_none())
        .ok_or_else(|| "密码条目不存在或已进入回收站".to_string())?;
    entry.favorite = favorite;
    entry.updated_at = Utc::now().timestamp_millis();
    save_vault(&storage, &vault)?;
    manager.replace_index(expected_vault_path(&storage)?, &vault);
    Ok(())
}

#[tauri::command]
pub(crate) fn save_password_entry(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    mut entry: PasswordDraft,
) -> Result<PasswordSummary, String> {
    validate_draft(&entry)?;
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库写入状态不可用".to_string())?;
    let mut vault = load_vault(&storage)?;
    let now = Utc::now().timestamp_millis();
    let id = entry
        .id
        .take()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if let Some(existing) = vault.items.iter_mut().find(|item| item.id == id) {
        if existing.deleted_at.is_some() {
            return Err("不能直接修改回收站中的密码".to_string());
        }
        existing.service = entry.service.trim().to_string();
        existing.username = entry.username;
        existing.phone = entry.phone;
        existing.email = entry.email;
        wipe_string(&mut existing.password);
        existing.password = entry.password;
        existing.note = entry.note;
        existing.category = entry.category;
        existing.url = entry.url;
        existing.favorite = entry.favorite;
        for field in &mut existing.custom_fields {
            if field.sensitive {
                wipe_string(&mut field.value);
            }
        }
        existing.custom_fields = entry.custom_fields;
        existing.updated_at = now;
    } else {
        vault.items.push(PasswordRecord {
            id: id.clone(),
            service: entry.service.trim().to_string(),
            username: entry.username,
            phone: entry.phone,
            email: entry.email,
            password: entry.password,
            note: entry.note,
            category: entry.category,
            url: entry.url,
            favorite: entry.favorite,
            last_used_at: None,
            use_count: 0,
            custom_fields: entry.custom_fields,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        });
    }
    save_vault(&storage, &vault)?;
    let summary = vault
        .items
        .iter()
        .find(|item| item.id == id)
        .map(PasswordRecord::safe_summary)
        .ok_or_else(|| "保存密码条目失败".to_string())?;
    manager.replace_index(expected_vault_path(&storage)?, &vault);
    Ok(summary)
}

#[tauri::command]
pub(crate) fn remove_password_entry(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
    permanent: bool,
) -> Result<(), String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库写入状态不可用".to_string())?;
    let mut vault = load_vault(&storage)?;
    if permanent {
        let index = vault
            .items
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "密码条目不存在".to_string())?;
        let mut removed = vault.items.remove(index);
        removed.wipe_secret();
    } else {
        let entry = vault
            .items
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "密码条目不存在".to_string())?;
        entry.deleted_at = Some(Utc::now().timestamp_millis());
        entry.updated_at = Utc::now().timestamp_millis();
    }
    save_vault(&storage, &vault)?;
    manager.replace_index(expected_vault_path(&storage)?, &vault);
    Ok(())
}

#[tauri::command]
pub(crate) fn restore_password_entry(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
) -> Result<(), String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库写入状态不可用".to_string())?;
    let mut vault = load_vault(&storage)?;
    let entry = vault
        .items
        .iter_mut()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "密码条目不存在".to_string())?;
    entry.deleted_at = None;
    entry.updated_at = Utc::now().timestamp_millis();
    save_vault(&storage, &vault)?;
    manager.replace_index(expected_vault_path(&storage)?, &vault);
    Ok(())
}

#[tauri::command]
pub(crate) fn empty_password_trash(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    confirmed: bool,
) -> Result<usize, String> {
    if !confirmed {
        return Err("清空密码回收站需要明确确认".to_string());
    }
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库写入状态不可用".to_string())?;
    let mut vault = load_vault(&storage)?;
    let before = vault.items.len();
    vault.items.retain_mut(|entry| {
        let keep = entry.deleted_at.is_none();
        if !keep {
            entry.wipe_secret();
        }
        keep
    });
    let removed = before - vault.items.len();
    if removed > 0 {
        save_vault(&storage, &vault)?;
        manager.replace_index(expected_vault_path(&storage)?, &vault);
    }
    Ok(removed)
}

#[tauri::command]
pub(crate) fn preview_password_import(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    path: String,
) -> Result<ImportPreview, String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).map_err(|error| format!("读取导入文件失败: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_IMPORT_BYTES {
        return Err("导入文件必须是小于 32MB 的 JSON 或 CSV 文件".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取导入文件失败: {error}"))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let (parsed, format) = match extension.as_str() {
        "json" => {
            (parse_json_import(&bytes)?, "JSON v1")
        }
        "csv" => {
            (parse_csv_import(&bytes)?, "CSV")
        }
        _ => return Err("仅支持 .json 和 .csv 导入文件".to_string()),
    };
    let ParsedImport { entries, total, invalid, warnings, issues } = parsed;
    let existing = load_vault(&storage)?;
    let keys = existing
        .items
        .iter()
        .filter(|entry| entry.deleted_at.is_none())
        .map(PasswordRecord::duplicate_key)
        .collect::<HashSet<_>>();
    let mut seen = keys;
    let mut duplicates = 0;
    for entry in &entries {
        if !seen.insert(entry.duplicate_key()) {
            duplicates += 1;
        }
    }
    let items = entries
        .iter()
        .take(100)
        .map(PasswordRecord::safe_summary)
        .collect();
    let token = Uuid::new_v4().to_string();
    manager
        .pending
        .lock()
        .map_err(|_| "导入预览状态不可用".to_string())?
        .insert(token.clone(), PendingImport { entries });
    Ok(ImportPreview {
        token,
        format: format.to_string(),
        total,
        ready: total.saturating_sub(invalid),
        duplicates,
        invalid,
        warnings,
        items,
        issues,
    })
}

#[tauri::command]
pub(crate) fn commit_password_import(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    token: String,
    strategy: DuplicateStrategy,
) -> Result<ImportResult, String> {
    let mut pending = manager
        .pending
        .lock()
        .map_err(|_| "导入预览状态不可用".to_string())?
        .remove(&token)
        .ok_or_else(|| "导入预览已失效，请重新选择文件".to_string())?;
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库写入状态不可用".to_string())?;
    let mut vault = load_vault(&storage)?;
    let mut imported = 0;
    let mut skipped = 0;
    let mut overwritten = 0;
    let entries = std::mem::take(&mut pending.entries);
    for mut incoming in entries {
        let key = incoming.duplicate_key();
        let existing = vault
            .items
            .iter()
            .position(|entry| entry.deleted_at.is_none() && entry.duplicate_key() == key);
        match (existing, strategy) {
            (Some(_), DuplicateStrategy::Skip) => skipped += 1,
            (Some(_), DuplicateStrategy::Keep) | (None, _) => {
                incoming.id = Uuid::new_v4().to_string();
                vault.items.push(incoming);
                imported += 1;
            }
            (Some(index), DuplicateStrategy::Overwrite) => {
                let id = vault.items[index].id.clone();
                let created_at = vault.items[index].created_at;
                vault.items[index].wipe_secret();
                incoming.id = id;
                incoming.created_at = created_at;
                incoming.updated_at = Utc::now().timestamp_millis();
                vault.items[index] = incoming;
                overwritten += 1;
            }
        }
    }
    save_vault(&storage, &vault)?;
    manager.replace_index(expected_vault_path(&storage)?, &vault);
    Ok(ImportResult {
        imported,
        skipped,
        overwritten,
    })
}

#[tauri::command]
pub(crate) fn discard_password_import(
    manager: tauri::State<'_, PasswordVaultManager>,
    token: String,
) -> Result<(), String> {
    manager
        .pending
        .lock()
        .map_err(|_| "导入预览状态不可用".to_string())?
        .remove(&token);
    Ok(())
}

#[tauri::command]
pub(crate) fn get_password_settings(storage: tauri::State<'_, StorageManager>) -> PasswordSettings {
    load_settings(&storage)
}

#[tauri::command]
pub(crate) fn set_password_settings(
    storage: tauri::State<'_, StorageManager>,
    settings: PasswordSettings,
) -> Result<PasswordSettings, String> {
    settings.validate()?;
    let path = settings_path(&storage)?;
    let bytes =
        serde_json::to_vec_pretty(&settings).map_err(|error| format!("保存设置失败: {error}"))?;
    atomic_write_config(&path, &bytes)?;
    Ok(settings)
}

fn is_weak_password(value: &str) -> bool {
    if value.chars().count() < 12 {
        return true;
    }
    let mut classes = [false; 4];
    for ch in value.chars() {
        if ch.is_ascii_lowercase() {
            classes[0] = true;
        } else if ch.is_ascii_uppercase() {
            classes[1] = true;
        } else if ch.is_ascii_digit() {
            classes[2] = true;
        } else {
            classes[3] = true;
        }
    }
    classes.into_iter().filter(|present| *present).count() < 3
}

#[tauri::command]
pub(crate) fn audit_password_security(
    storage: tauri::State<'_, StorageManager>,
) -> Result<PasswordSecurityReport, String> {
    const STALE_AFTER_MILLIS: i64 = 365 * 24 * 60 * 60 * 1000;
    let vault = load_vault(&storage)?;
    let active = vault
        .items
        .iter()
        .filter(|entry| entry.deleted_at.is_none())
        .collect::<Vec<_>>();
    let mut password_counts = HashMap::<[u8; 32], usize>::new();
    for entry in &active {
        let digest: [u8; 32] = Sha256::digest(entry.password.as_bytes()).into();
        *password_counts.entry(digest).or_default() += 1;
    }
    let now = Utc::now().timestamp_millis();
    let mut weak = 0;
    let mut reused = 0;
    let mut stale = 0;
    let mut incomplete = 0;
    let mut issues = Vec::new();
    for entry in &active {
        let mut kinds = Vec::new();
        if is_weak_password(&entry.password) {
            weak += 1;
            kinds.push("weak".to_string());
        }
        let digest: [u8; 32] = Sha256::digest(entry.password.as_bytes()).into();
        if password_counts.get(&digest).copied().unwrap_or_default() > 1 {
            reused += 1;
            kinds.push("reused".to_string());
        }
        if now.saturating_sub(entry.updated_at) >= STALE_AFTER_MILLIS {
            stale += 1;
            kinds.push("stale".to_string());
        }
        if entry.username.trim().is_empty()
            && entry.email.trim().is_empty()
            && entry.phone.trim().is_empty()
        {
            incomplete += 1;
            kinds.push("incomplete".to_string());
        }
        if !kinds.is_empty() && issues.len() < 200 {
            issues.push(PasswordSecurityIssue {
                id: entry.id.clone(),
                service: entry.service.clone(),
                kinds,
            });
        }
    }
    Ok(PasswordSecurityReport {
        total: active.len(),
        weak,
        reused,
        stale,
        incomplete,
        issues,
    })
}

fn atomic_write_config(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "配置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    let temporary = parent.join(format!(".{SETTINGS_FILE}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|error| format!("写入设置失败: {error}"))?;
    let backup = parent.join(format!(".{SETTINGS_FILE}.backup"));
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|error| format!("备份旧设置失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("提交设置失败: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[tauri::command]
pub(crate) async fn copy_password(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
) -> Result<(), String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库写入状态不可用".to_string())?;
    let mut vault = load_vault(&storage)?;
    let entry = vault
        .items
        .iter_mut()
        .find(|entry| entry.id == id && entry.deleted_at.is_none())
        .ok_or_else(|| "密码条目不存在或已进入回收站".to_string())?;
    let fingerprint = Sha256::digest(entry.password.as_bytes()).to_vec();
    let sequence = write_sensitive_clipboard(&entry.password)?;
    entry.last_used_at = Some(Utc::now().timestamp_millis());
    entry.use_count = entry.use_count.saturating_add(1);
    let save_result = save_vault(&storage, &vault);
    if save_result.is_ok() {
        if let Ok(path) = expected_vault_path(&storage) {
            manager.replace_index(path, &vault);
        } else {
            manager.invalidate_index();
        }
    }
    let clear_after = load_settings(&storage).clipboard_clear_seconds;
    drop(vault);
    if clear_after > 0 {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(clear_after)).await;
            let _ = clear_clipboard_if_unchanged(sequence, &fingerprint);
            drop(app);
        });
    }
    save_result
}

#[tauri::command]
pub(crate) async fn copy_password_field(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    id: String,
    field: String,
) -> Result<(), String> {
    let vault = load_vault(&storage)?;
    let entry = vault
        .items
        .iter()
        .find(|entry| entry.id == id && entry.deleted_at.is_none())
        .ok_or_else(|| "密码条目不存在或已进入回收站".to_string())?;
    let (value, sensitive) = match field.as_str() {
        "username" => (entry.username.as_str(), false),
        "email" => (entry.email.as_str(), false),
        "phone" => (entry.phone.as_str(), false),
        "url" => (entry.url.as_str(), false),
        _ if field.starts_with("custom:") => {
            let index = field[7..]
                .parse::<usize>()
                .map_err(|_| "自定义字段索引无效".to_string())?;
            let custom = entry
                .custom_fields
                .get(index)
                .ok_or_else(|| "自定义字段不存在".to_string())?;
            (custom.value.as_str(), custom.sensitive)
        }
        _ => return Err("不支持复制该字段".to_string()),
    };
    if value.is_empty() {
        return Err("该字段为空".to_string());
    }
    let fingerprint = Sha256::digest(value.as_bytes()).to_vec();
    let sequence = write_sensitive_clipboard(value)?;
    let clear_after = load_settings(&storage).clipboard_clear_seconds;
    drop(vault);
    if sensitive && clear_after > 0 {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(clear_after)).await;
            let _ = clear_clipboard_if_unchanged(sequence, &fingerprint);
            drop(app);
        });
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn open_password_url(
    storage: tauri::State<'_, StorageManager>,
    id: String,
) -> Result<(), String> {
    let vault = load_vault(&storage)?;
    let entry = vault
        .items
        .iter()
        .find(|entry| entry.id == id && entry.deleted_at.is_none())
        .ok_or_else(|| "密码条目不存在或已进入回收站".to_string())?;
    let value = entry.url.trim();
    let lower = value.to_ascii_lowercase();
    if value.len() > 2_000
        || value.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
        || !(lower.starts_with("https://") || lower.starts_with("http://"))
    {
        return Err("仅允许打开有效的 HTTP 或 HTTPS 网站".to_string());
    }
    opener::open(value).map_err(|error| format!("打开网站失败: {error}"))
}

#[cfg(target_os = "windows")]
fn protect_for_current_user(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::w;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| "密码库内容过大".to_string())?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            w!("DtKit Password Vault"),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "Windows 无法保护密码库；未写入任何明文数据".to_string())?;
        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(protected)
    }
}

#[cfg(target_os = "windows")]
fn unprotect_for_current_user(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| "密码库内容过大".to_string())?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| {
            "无法解密密码库。该数据可能属于其他 Windows 用户、其他设备或已经损坏；DtKit 不会覆盖它"
                .to_string()
        })?;
        let plaintext = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(plaintext)
    }
}

#[cfg(not(target_os = "windows"))]
fn protect_for_current_user(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("密码库当前仅支持 Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_for_current_user(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("密码库当前仅支持 Windows".to_string())
}

#[cfg(target_os = "windows")]
struct ClipboardGuard;

#[cfg(target_os = "windows")]
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::DataExchange::CloseClipboard();
        }
    }
}

#[cfg(target_os = "windows")]
fn open_clipboard() -> Result<ClipboardGuard, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..8 {
        if unsafe { OpenClipboard(HWND(std::ptr::null_mut())) }.is_ok() {
            return Ok(ClipboardGuard);
        }
        std::thread::sleep(Duration::from_millis(12));
    }
    Err("剪贴板正被其他程序占用，请稍后重试".to_string())
}

#[cfg(target_os = "windows")]
unsafe fn clipboard_memory(bytes: &[u8]) -> Result<windows::Win32::Foundation::HGLOBAL, String> {
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    let memory =
        GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|_| "分配剪贴板内存失败".to_string())?;
    let pointer = GlobalLock(memory);
    if pointer.is_null() {
        return Err("锁定剪贴板内存失败".to_string());
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer as *mut u8, bytes.len());
    let _ = GlobalUnlock(memory);
    Ok(memory)
}

#[cfg(target_os = "windows")]
fn write_sensitive_clipboard(value: &str) -> Result<u32, String> {
    use windows::core::w;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        EmptyClipboard, GetClipboardSequenceNumber, RegisterClipboardFormatW, SetClipboardData,
    };
    let mut utf16 = value.encode_utf16().collect::<Vec<_>>();
    utf16.push(0);
    let text_bytes =
        unsafe { std::slice::from_raw_parts(utf16.as_ptr() as *const u8, utf16.len() * 2) };
    let _guard = open_clipboard()?;
    unsafe {
        EmptyClipboard().map_err(|_| "清空旧剪贴板内容失败".to_string())?;
        let text = clipboard_memory(text_bytes)?;
        SetClipboardData(13, HANDLE(text.0)).map_err(|_| "写入密码到剪贴板失败".to_string())?;

        // Prevent this password from entering Win+V history and cloud clipboard.
        let format = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
        if format != 0 {
            if let Ok(marker) = clipboard_memory(&1_u32.to_ne_bytes()) {
                let _ = SetClipboardData(format, HANDLE(marker.0));
            }
        }
        Ok(GetClipboardSequenceNumber())
    }
}

#[cfg(not(target_os = "windows"))]
fn write_sensitive_clipboard(_value: &str) -> Result<u32, String> {
    Err("安全剪贴板当前仅支持 Windows".to_string())
}

#[cfg(target_os = "windows")]
fn clipboard_text() -> Result<String, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    let handle = unsafe { GetClipboardData(13) }.map_err(|_| "剪贴板当前不是文本".to_string())?;
    let memory = HGLOBAL(handle.0);
    let pointer = unsafe { GlobalLock(memory) } as *const u16;
    if pointer.is_null() {
        return Err("无法读取剪贴板文本".to_string());
    }
    let mut length = 0;
    unsafe {
        while *pointer.add(length) != 0 {
            length += 1;
        }
    }
    let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, length) });
    unsafe {
        let _ = GlobalUnlock(memory);
    }
    Ok(value)
}

fn clipboard_content_matches_ticket(
    current_sequence: u32,
    expected_sequence: u32,
    current_text: &str,
    expected_hash: &[u8],
) -> bool {
    current_sequence == expected_sequence
        && Sha256::digest(current_text.as_bytes()).as_slice() == expected_hash
}

#[cfg(target_os = "windows")]
fn clear_clipboard_if_unchanged(sequence: u32, expected_hash: &[u8]) -> Result<(), String> {
    use windows::Win32::System::DataExchange::{EmptyClipboard, GetClipboardSequenceNumber};
    if unsafe { GetClipboardSequenceNumber() } != sequence {
        return Ok(());
    }
    let _guard = open_clipboard()?;
    let current_sequence = unsafe { GetClipboardSequenceNumber() };
    if current_sequence != sequence {
        return Ok(());
    }
    let mut current = clipboard_text()?;
    let matches =
        clipboard_content_matches_ticket(current_sequence, sequence, &current, expected_hash);
    wipe_string(&mut current);
    if !matches {
        return Ok(());
    }
    unsafe { EmptyClipboard() }.map_err(|_| "清理剪贴板失败".to_string())
}

#[cfg(not(target_os = "windows"))]
fn clear_clipboard_if_unchanged(_sequence: u32, _expected_hash: &[u8]) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_search_never_searches_passwords() {
        let mut entry = imported_record(ImportedPassword {
            service: "GitHub".into(),
            username: "octocat".into(),
            phone: "13800000000".into(),
            email: "cat@example.com".into(),
            password: "needle-secret".into(),
            note: "个人账号".into(),
            category: "开发".into(),
        })
        .unwrap();
        let indexed = IndexedPassword::from_record(&entry);
        let (scope, needle) = parse_search("#用户名 octo");
        assert!(indexed.matches(&scope, &needle));
        let (scope, needle) = parse_search("needle-secret");
        assert!(!indexed.matches(&scope, &needle));
        entry.wipe_secret();
    }

    #[test]
    fn legacy_records_receive_safe_defaults_for_new_metadata() {
        let source = br#"{"version":1,"items":[{"id":"1","service":"GitHub","password":"secret","createdAt":1,"updatedAt":1}]}"#;
        let mut vault: PasswordVault = serde_json::from_slice(source).unwrap();
        let entry = &vault.items[0];
        assert!(entry.url.is_empty());
        assert!(!entry.favorite);
        assert!(entry.last_used_at.is_none());
        assert!(entry.custom_fields.is_empty());
        vault.items.iter_mut().for_each(PasswordRecord::wipe_secret);
    }

    #[test]
    fn metadata_index_searches_urls_but_never_custom_secrets() {
        let mut entry = imported_record(ImportedPassword {
            service: "GitHub".into(),
            username: String::new(),
            phone: String::new(),
            email: String::new(),
            password: "password-secret".into(),
            note: String::new(),
            category: "开发".into(),
        })
        .unwrap();
        entry.url = "https://github.com".into();
        entry.custom_fields.push(PasswordCustomField {
            label: "恢复代码".into(),
            value: "custom-secret".into(),
            sensitive: true,
        });
        let indexed = IndexedPassword::from_record(&entry);
        assert!(indexed.matches(&SearchScope::Url, "github.com"));
        assert!(!indexed.matches(&SearchScope::Global, "custom-secret"));
        assert!(!indexed.matches(&SearchScope::Global, "password-secret"));
        entry.wipe_secret();
    }

    #[test]
    fn large_index_returns_bounded_results_without_password_data() {
        let mut vault = PasswordVault {
            version: VAULT_VERSION,
            items: (0..10_000)
                .map(|index| PasswordRecord {
                    id: index.to_string(),
                    service: format!("Service {index:05}"),
                    username: format!("user-{index}"),
                    phone: String::new(),
                    email: format!("user-{index}@example.com"),
                    password: format!("secret-{index}"),
                    note: "metadata".to_string(),
                    category: "test".to_string(),
                    url: String::new(),
                    favorite: false,
                    last_used_at: None,
                    use_count: 0,
                    custom_fields: Vec::new(),
                    created_at: 0,
                    updated_at: 0,
                    deleted_at: None,
                })
                .collect(),
        };
        let cache = PasswordIndexCache::from_vault(PathBuf::from("vault.dpapi"), &vault);
        let all = cache.search(&SearchScope::Global, "", false, "all", "", 50);
        assert_eq!(all.total, 10_000);
        assert_eq!(all.items.len(), 50);
        assert!(all.truncated);

        let secret = cache.search(&SearchScope::Global, "secret-9999", false, "all", "", 50);
        assert_eq!(secret.total, 0);
        vault.items.iter_mut().for_each(PasswordRecord::wipe_secret);
    }

    #[test]
    fn json_count_mismatch_warns_but_imports_valid_entries() {
        let source = br#"{
            "app":"REPassCard","version":1,"exportDate":"ignored","count":9,
            "passwords":[
                {"service":"GitHub","username":"u","password":"p"},
                {"service":"","password":"invalid"}
            ]
        }"#;
        let parsed = parse_json_import(source).unwrap();
        assert_eq!(parsed.total, 2);
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.warnings.len(), 1);
    }

    #[test]
    fn csv_parser_supports_bom_quotes_commas_and_newlines() {
        let source = "\u{feff}服务,用户名,手机号,邮箱,密码,备注,分类\r\n\
                      GitHub,user,,,secret,\"包含,逗号和\n换行\",开发\r\n";
        let parsed = parse_csv_import(source.as_bytes()).unwrap();
        assert_eq!(parsed.total, 1);
        assert_eq!(parsed.entries[0].note, "包含,逗号和\n换行");
    }

    #[test]
    fn duplicate_identity_is_normalized_service_and_username() {
        assert_eq!(
            duplicate_key(" GitHub ", "Example"),
            duplicate_key("github", "example")
        );
    }

    #[test]
    fn clipboard_setting_rejects_arbitrary_intervals() {
        assert!(PasswordSettings {
            clipboard_clear_seconds: 30
        }
        .validate()
        .is_ok());
        assert!(PasswordSettings {
            clipboard_clear_seconds: 31
        }
        .validate()
        .is_err());
    }

    #[test]
    fn clipboard_tickets_only_clear_their_own_unchanged_copy() {
        let first_hash = Sha256::digest(b"first-password").to_vec();
        let second_hash = Sha256::digest(b"second-password").to_vec();

        assert!(clipboard_content_matches_ticket(
            10,
            10,
            "first-password",
            &first_hash
        ));
        assert!(clipboard_content_matches_ticket(
            11,
            11,
            "second-password",
            &second_hash
        ));

        // The first timer cannot clear the newer password, even if both timers are still alive.
        assert!(!clipboard_content_matches_ticket(
            11,
            10,
            "second-password",
            &first_hash
        ));
        // Re-copying an identical password receives a new sequence and is owned by the new timer.
        assert!(!clipboard_content_matches_ticket(
            12,
            10,
            "first-password",
            &first_hash
        ));
        // Ordinary clipboard text written afterwards must never be cleared by either password timer.
        assert!(!clipboard_content_matches_ticket(
            13,
            10,
            "ordinary text",
            &first_hash
        ));
        assert!(!clipboard_content_matches_ticket(
            13,
            11,
            "ordinary text",
            &second_hash
        ));
    }

    #[test]
    fn json_import_reports_the_exact_invalid_entries_without_exposing_passwords() {
        let parsed = parse_json_import(
            br#"{"app":"REPassCard","version":1,"count":3,"passwords":[{"service":"GitHub","username":"octocat","password":"secret"},{"service":"","username":"missing-name","password":"secret-2","note":"work"},{"service":"Mail","email":"me@example.com","password":""}]}"#,
        )
        .unwrap();

        assert_eq!(parsed.total, 3);
        assert_eq!(parsed.invalid, 2);
        assert_eq!(parsed.issues[0].source, "第 2 条");
        assert_eq!(parsed.issues[0].username, "missing-name");
        assert_eq!(parsed.issues[1].service, "Mail");
        assert!(parsed.issues[1].errors.iter().any(|error| error == "密码为空"));
        let serialized = serde_json::to_string(&parsed.issues).unwrap();
        assert!(!serialized.contains("secret-2"));
    }

    #[test]
    fn csv_import_reports_the_source_row_for_invalid_entries() {
        let parsed = parse_csv_import(
            "服务,用户名,密码,备注\r\nGitHub,octocat,secret,ok\r\n,missing-name,secret-2,bad\r\nMail,me,,empty password\r\n".as_bytes(),
        )
        .unwrap();

        assert_eq!(parsed.total, 3);
        assert_eq!(parsed.invalid, 2);
        assert_eq!(parsed.issues[0].source, "第 3 行");
        assert_eq!(parsed.issues[1].source, "第 4 行");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_round_trip_is_bound_to_the_current_windows_user() {
        let secret = b"dtkit-dpapi-round-trip";
        let encrypted = protect_for_current_user(secret).unwrap();
        assert_ne!(encrypted, secret);
        let mut decrypted = unprotect_for_current_user(&encrypted).unwrap();
        assert_eq!(decrypted, secret);
        decrypted.fill(0);
    }
}
