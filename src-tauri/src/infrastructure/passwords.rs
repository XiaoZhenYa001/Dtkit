use super::storage::StorageManager;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const VAULT_FILE: &str = "vault.dpapi";
const SETTINGS_FILE: &str = "password-settings.json";
const VAULT_VERSION: u32 = 1;
const TRASH_RETENTION_DAYS: i64 = 30;
const MAX_IMPORT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_IMPORT_ENTRIES: usize = 20_000;
const MAX_VAULT_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT: usize = 200;
const MAX_SEARCH_LIMIT: usize = 500;
const TRASH_RETENTION_MILLIS: i64 = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_PENDING_IMPORTS: usize = 8;
const IMPORT_PREVIEW_TTL_MILLIS: i64 = 30 * 60 * 1000;

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

impl Drop for PasswordRecord {
    fn drop(&mut self) {
        self.wipe_secret();
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
    uncategorized_count: usize,
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
    offset: usize,
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
    updated_at: i64,
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

impl Drop for PasswordDraft {
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
    conflicts: Vec<ImportConflict>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportConflict {
    id: String,
    service: String,
    username: String,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportIssue {
    id: String,
    editable: bool,
    source: String,
    service: String,
    username: String,
    email: String,
    phone: String,
    url: String,
    note: String,
    category: String,
    errors: Vec<String>,
}

struct ParsedImport {
    entries: Vec<PasswordRecord>,
    candidates: Vec<PendingCandidate>,
    total: usize,
    uneditable_invalid: usize,
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
    candidates: Vec<PendingCandidate>,
    uneditable_invalid: usize,
    created_at: i64,
    vault_path: PathBuf,
}

impl Drop for PendingImport {
    fn drop(&mut self) {
        for entry in &mut self.entries {
            entry.wipe_secret();
        }
        for candidate in &mut self.candidates {
            wipe_string(&mut candidate.entry.password);
        }
    }
}

struct PendingCandidate {
    id: String,
    source: String,
    entry: ImportedPassword,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCorrection {
    service: Option<String>,
    password: Option<String>,
    username: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    note: Option<String>,
    category: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCorrectionResult {
    ready: usize,
    duplicates: usize,
    invalid: usize,
    item: Option<PasswordSummary>,
    issue: Option<ImportIssue>,
    conflicts: Vec<ImportConflict>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportDecision {
    id: String,
    strategy: DuplicateStrategy,
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

    pub(crate) fn release_cached_index(&self) {
        // Imports belong to individual tool pages and may still be active in another window.
        let _access = self.index_build.lock().ok();
        self.invalidate_index();
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
        offset: usize,
        sort: &str,
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
        Some(cache.search_page(
            scope,
            needle,
            include_deleted,
            view,
            category,
            limit,
            offset,
            sort,
        ))
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
    passwords: Vec<serde_json::Value>,
}

impl Drop for RePassCardJson {
    fn drop(&mut self) {
        self.passwords.iter_mut().for_each(wipe_json_secrets);
    }
}

#[derive(Debug, Default, Deserialize)]
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
    #[serde(default)]
    url: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default, rename = "customFields")]
    custom_fields: Vec<PasswordCustomField>,
}

impl Drop for ImportedPassword {
    fn drop(&mut self) {
        wipe_string(&mut self.password);
        for field in &mut self.custom_fields {
            if field.sensitive {
                wipe_string(&mut field.value);
            }
        }
    }
}

struct SecretBytes(Vec<u8>);
impl Drop for SecretBytes {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            unsafe {
                std::ptr::write_volatile(byte, 0);
            }
        }
    }
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
    let backup = path.parent().unwrap().join(format!(".{VAULT_FILE}.backup"));
    let read_path = if path.is_file() {
        &path
    } else if backup.is_file() {
        &backup
    } else {
        &path
    };
    if !read_path.is_file() {
        return Ok(PasswordVault {
            version: VAULT_VERSION,
            items: Vec::new(),
        });
    }
    if fs::metadata(read_path)
        .map_err(|error| format!("读取密码库信息失败: {error}"))?
        .len()
        > MAX_VAULT_BYTES
    {
        return Err("密码库文件超出 64MB 限制，已停止读取".to_string());
    }
    let encrypted = fs::read(read_path).map_err(|error| format!("读取密码库失败: {error}"))?;
    let mut plaintext = unprotect_for_current_user(&encrypted)?;
    let result = serde_json::from_slice::<PasswordVault>(&plaintext)
        .map_err(|_| "密码库内容损坏，已停止读取且不会覆盖原文件".to_string());
    plaintext.fill(0);
    let vault = result?;
    if vault.version != VAULT_VERSION {
        return Err("密码库版本暂不受支持".to_string());
    }
    if read_path == &backup {
        fs::rename(&backup, &path).map_err(|error| format!("恢复上次完整密码库失败: {error}"))?;
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
        _ => return (SearchScope::Global, normalize(trimmed)),
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
            updated_at: entry.updated_at,
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

    #[cfg(test)]
    fn search(
        &self,
        scope: &SearchScope,
        needle: &str,
        include_deleted: bool,
        view: &str,
        category: &str,
        limit: usize,
    ) -> PasswordSearchResponse {
        self.search_page(
            scope,
            needle,
            include_deleted,
            view,
            category,
            limit,
            0,
            "recent",
        )
    }

    fn search_page(
        &self,
        scope: &SearchScope,
        needle: &str,
        include_deleted: bool,
        view: &str,
        category: &str,
        limit: usize,
        offset: usize,
        sort: &str,
    ) -> PasswordSearchResponse {
        let mut matches = self
            .items
            .iter()
            .filter(|entry| {
                let visible = if include_deleted {
                    entry.summary.deleted_at.is_some()
                } else {
                    entry.summary.deleted_at.is_none()
                };
                let in_view = match view {
                    "favorites" => entry.summary.favorite,
                    "recent" => entry.summary.last_used_at.is_some(),
                    "category" => entry.summary.category == category,
                    "uncategorized" => entry.summary.category.trim().is_empty(),
                    _ => true,
                };
                visible && in_view && entry.matches(scope, needle)
            })
            .collect::<Vec<_>>();
        if sort == "name" {
            matches.sort_by(|a, b| {
                a.field(&a.service)
                    .cmp(b.field(&b.service))
                    .then_with(|| a.summary.id.cmp(&b.summary.id))
            });
        } else if sort == "updated" {
            matches.sort_by(|a, b| {
                b.updated_at
                    .cmp(&a.updated_at)
                    .then_with(|| a.summary.id.cmp(&b.summary.id))
            });
        }
        let total = matches.len();
        let limit = limit.max(1);
        let offset = offset.min(total.saturating_sub(1) / limit * limit);
        let items = matches
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|entry| entry.summary.clone())
            .collect::<Vec<_>>();
        PasswordSearchResponse {
            truncated: total > offset + items.len(),
            items,
            total,
            offset,
        }
    }

    fn overview(&self) -> PasswordOverview {
        let mut categories = HashMap::<String, usize>::new();
        let mut total = 0;
        let mut favorite_count = 0;
        let mut recent_count = 0;
        let mut trash_count = 0;
        let mut uncategorized_count = 0;
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
            } else {
                uncategorized_count += 1;
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
            uncategorized_count,
            categories,
        }
    }
}

fn imported_record(mut entry: ImportedPassword) -> Option<PasswordRecord> {
    if !import_validation_errors(&entry).is_empty() {
        return None;
    }
    let now = Utc::now().timestamp_millis();
    Some(PasswordRecord {
        id: Uuid::new_v4().to_string(),
        service: entry.service.trim().to_string(),
        username: std::mem::take(&mut entry.username),
        phone: std::mem::take(&mut entry.phone),
        email: std::mem::take(&mut entry.email),
        password: std::mem::take(&mut entry.password),
        note: std::mem::take(&mut entry.note),
        category: entry.category.trim().to_string(),
        url: std::mem::take(&mut entry.url),
        favorite: entry.favorite,
        last_used_at: None,
        use_count: 0,
        custom_fields: std::mem::take(&mut entry.custom_fields),
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
    for (label, value, maximum) in [
        ("名称", &entry.service, 200),
        ("用户名", &entry.username, 500),
        ("手机号", &entry.phone, 100),
        ("邮箱", &entry.email, 500),
        ("密码", &entry.password, 10_000),
        ("备注", &entry.note, 10_000),
        ("分类", &entry.category, 200),
        ("网址", &entry.url, 2_000),
    ] {
        if value.chars().count() > maximum {
            errors.push(format!("{label}超过 {maximum} 个字符"));
        }
    }
    if entry.custom_fields.len() > 20
        || entry
            .custom_fields
            .iter()
            .any(|field| field.label.chars().count() > 100 || field.value.chars().count() > 10_000)
    {
        errors.push("自定义字段超出限制".to_string());
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

fn import_issue(
    id: String,
    editable: bool,
    source: String,
    entry: &ImportedPassword,
    errors: Vec<String>,
) -> ImportIssue {
    ImportIssue {
        id,
        editable,
        source,
        service: safe_import_metadata(&entry.service),
        username: safe_import_metadata(&entry.username),
        email: safe_import_metadata(&entry.email),
        phone: safe_import_metadata(&entry.phone),
        url: safe_import_metadata(&entry.url),
        note: safe_import_metadata(&entry.note),
        category: safe_import_metadata(&entry.category),
        errors,
    }
}

fn parse_json_import(bytes: &[u8]) -> Result<ParsedImport, String> {
    let mut payload: RePassCardJson = serde_json::from_slice(
        bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes),
    )
    .map_err(|error| {
        format!(
            "JSON 格式无效，请检查第 {} 行、第 {} 列",
            error.line(),
            error.column()
        )
    })?;
    if payload.app != "REPassCard" || payload.version != 1 {
        return Err("仅支持 REPassCard JSON v1".to_string());
    }
    let total = payload.passwords.len();
    if total > MAX_IMPORT_ENTRIES {
        return Err("单次最多导入 20000 条密码，请拆分文件".to_string());
    }
    let mut warnings = Vec::new();
    if payload.count != total {
        warnings.push(format!(
            "文件声明 {} 条，但实际包含 {} 条；已按实际条目数处理",
            payload.count, total
        ));
    }
    let mut entries = Vec::with_capacity(total);
    let mut candidates = Vec::new();
    let mut issues = Vec::new();
    let mut uneditable_invalid = 0;
    for (index, mut value) in payload.passwords.drain(..).enumerate() {
        // Reject only the malformed row, and avoid including its value in diagnostics.
        let decoded = serde_json::from_value::<ImportedPassword>(value.clone());
        let mut imported = match decoded {
            Ok(imported) => {
                wipe_json_secrets(&mut value);
                imported
            }
            Err(_) => {
                uneditable_invalid += 1;
                if issues.len() < 100 {
                    issues.push(invalid_json_issue(&value, index + 1));
                }
                wipe_json_secrets(&mut value);
                continue;
            }
        };
        let errors = import_validation_errors(&imported);
        if errors.is_empty() {
            if let Some(entry) = imported_record(imported) {
                entries.push(entry);
            }
        } else {
            if candidates.len() < 100 {
                let id = Uuid::new_v4().to_string();
                let source = format!("第 {} 条", index + 1);
                issues.push(import_issue(
                    id.clone(),
                    true,
                    source.clone(),
                    &imported,
                    errors,
                ));
                candidates.push(PendingCandidate {
                    id,
                    source,
                    entry: imported,
                });
            } else {
                uneditable_invalid += 1;
                wipe_string(&mut imported.password);
            }
        }
    }
    if uneditable_invalid > issues.iter().filter(|issue| !issue.editable).count() {
        warnings.push(format!(
            "另有 {} 条错误条目未展开显示，请在源文件中修正",
            uneditable_invalid - issues.iter().filter(|issue| !issue.editable).count()
        ));
    }
    Ok(ParsedImport {
        entries,
        candidates,
        total,
        uneditable_invalid,
        warnings,
        issues,
    })
}

fn invalid_json_issue(value: &serde_json::Value, index: usize) -> ImportIssue {
    let metadata = |field| {
        value
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(safe_import_metadata)
            .unwrap_or_default()
    };
    let mut errors = Vec::new();
    for (field, label) in [
        ("service", "名称"),
        ("username", "用户名"),
        ("password", "密码"),
        ("email", "邮箱"),
        ("phone", "手机号"),
        ("note", "备注"),
        ("category", "分类"),
        ("url", "网址"),
    ] {
        if value.get(field).is_some_and(|field| !field.is_string()) {
            errors.push(format!("{label}字段必须为文本"));
        }
    }
    if errors.is_empty() {
        errors.push(
            if value.is_object() {
                "收藏或自定义字段结构无效"
            } else {
                "密码条目必须为对象"
            }
            .to_string(),
        );
    }
    ImportIssue {
        id: String::new(),
        editable: false,
        source: format!("第 {index} 条"),
        service: metadata("service"),
        username: metadata("username"),
        email: metadata("email"),
        phone: metadata("phone"),
        url: metadata("url"),
        note: metadata("note"),
        category: metadata("category"),
        errors,
    }
}

fn wipe_json_secrets(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => wipe_string(text),
        serde_json::Value::Array(items) => items.iter_mut().for_each(wipe_json_secrets),
        serde_json::Value::Object(fields) => fields.values_mut().for_each(wipe_json_secrets),
        _ => {}
    }
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
    let mut candidates = Vec::new();
    let mut uneditable_invalid = 0;
    let mut issues = Vec::new();
    let mut warnings = Vec::new();
    for record_result in reader.records() {
        if total >= MAX_IMPORT_ENTRIES {
            return Err("单次最多导入 20000 条密码，请拆分文件".to_string());
        }
        let record = match record_result {
            Ok(record) => record,
            Err(error) => {
                total += 1;
                uneditable_invalid += 1;
                if issues.len() < 100 {
                    let line = error
                        .position()
                        .map(|position| position.line())
                        .unwrap_or((total + 1) as u64);
                    issues.push(ImportIssue {
                        id: String::new(),
                        editable: false,
                        source: format!("第 {line} 行"),
                        service: String::new(),
                        username: String::new(),
                        email: String::new(),
                        phone: String::new(),
                        url: String::new(),
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
            url: String::new(),
            favorite: false,
            custom_fields: Vec::new(),
        };
        let errors = import_validation_errors(&imported);
        if errors.is_empty() {
            if let Some(entry) = imported_record(imported) {
                entries.push(entry);
            }
        } else {
            if candidates.len() < 100 {
                let id = Uuid::new_v4().to_string();
                let source = format!("第 {source_line} 行");
                issues.push(import_issue(
                    id.clone(),
                    true,
                    source.clone(),
                    &imported,
                    errors,
                ));
                candidates.push(PendingCandidate {
                    id,
                    source,
                    entry: imported,
                });
            } else {
                uneditable_invalid += 1;
                wipe_string(&mut imported.password);
            }
        }
    }
    if uneditable_invalid > issues.iter().filter(|issue| !issue.editable).count() {
        warnings.push(format!(
            "另有 {} 条错误条目未展开显示，请在源文件中修正",
            uneditable_invalid - issues.iter().filter(|issue| !issue.editable).count()
        ));
    }
    Ok(ParsedImport {
        entries,
        candidates,
        total,
        uneditable_invalid,
        warnings,
        issues,
    })
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
pub(crate) async fn list_passwords(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    query: Option<String>,
    include_deleted: Option<bool>,
    view: Option<String>,
    category: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    sort: Option<String>,
) -> Result<PasswordSearchResponse, String> {
    let _work = super::launch::keep_native_work(&app);
    let now = Utc::now().timestamp_millis();
    let vault_path = expected_vault_path(&storage)?;
    let (scope, needle) = parse_search(query.as_deref().unwrap_or_default());
    let include_deleted = include_deleted.unwrap_or(false);
    let view = view.unwrap_or_else(|| "all".to_string());
    let category = category.unwrap_or_default();
    let limit = limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let offset = offset.unwrap_or_default();
    let sort = sort.unwrap_or_else(|| "recent".to_string());
    if let Some(response) = manager.search_cached(
        &vault_path,
        now,
        &scope,
        &needle,
        include_deleted,
        &view,
        &category,
        limit,
        offset,
        &sort,
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
        offset,
        &sort,
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
            offset,
            &sort,
        )
        .ok_or_else(|| "密码索引构建失败".to_string())
}

#[tauri::command]
pub(crate) async fn get_password_entry_for_edit(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
) -> Result<PasswordEditorEntry, String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库状态不可用".to_string())?;
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
pub(crate) async fn get_password_detail(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
) -> Result<PasswordDetail, String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库状态不可用".to_string())?;
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
pub(crate) async fn get_password_overview(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
) -> Result<PasswordOverview, String> {
    let _work = super::launch::keep_native_work(&app);
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
pub(crate) async fn set_password_favorite(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    let _work = super::launch::keep_native_work(&app);
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
    save_vault(&storage, &vault)?;
    manager.replace_index(expected_vault_path(&storage)?, &vault);
    let _ = app.emit("password-vault-changed", ());
    Ok(())
}

#[tauri::command]
pub(crate) async fn save_password_entry(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    mut entry: PasswordDraft,
) -> Result<PasswordSummary, String> {
    let _work = super::launch::keep_native_work(&app);
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
        existing.username = std::mem::take(&mut entry.username);
        existing.phone = std::mem::take(&mut entry.phone);
        existing.email = std::mem::take(&mut entry.email);
        wipe_string(&mut existing.password);
        existing.password = std::mem::take(&mut entry.password);
        existing.note = std::mem::take(&mut entry.note);
        existing.category = entry.category.trim().to_string();
        existing.url = std::mem::take(&mut entry.url);
        existing.favorite = entry.favorite;
        for field in &mut existing.custom_fields {
            if field.sensitive {
                wipe_string(&mut field.value);
            }
        }
        existing.custom_fields = std::mem::take(&mut entry.custom_fields);
        existing.updated_at = now;
    } else {
        vault.items.push(PasswordRecord {
            id: id.clone(),
            service: entry.service.trim().to_string(),
            username: std::mem::take(&mut entry.username),
            phone: std::mem::take(&mut entry.phone),
            email: std::mem::take(&mut entry.email),
            password: std::mem::take(&mut entry.password),
            note: std::mem::take(&mut entry.note),
            category: entry.category.trim().to_string(),
            url: std::mem::take(&mut entry.url),
            favorite: entry.favorite,
            last_used_at: None,
            use_count: 0,
            custom_fields: std::mem::take(&mut entry.custom_fields),
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
    let _ = app.emit("password-vault-changed", ());
    Ok(summary)
}

#[tauri::command]
pub(crate) async fn remove_password_entry(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
    permanent: bool,
) -> Result<(), String> {
    let _work = super::launch::keep_native_work(&app);
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
    let _ = app.emit("password-vault-changed", ());
    Ok(())
}

#[tauri::command]
pub(crate) async fn restore_password_entry(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
) -> Result<(), String> {
    let _work = super::launch::keep_native_work(&app);
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
    let _ = app.emit("password-vault-changed", ());
    Ok(())
}

#[tauri::command]
pub(crate) async fn empty_password_trash(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    confirmed: bool,
) -> Result<usize, String> {
    let _work = super::launch::keep_native_work(&app);
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
        let _ = app.emit("password-vault-changed", ());
    }
    Ok(removed)
}

#[tauri::command]
pub(crate) async fn preview_password_import(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    path: String,
) -> Result<ImportPreview, String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).map_err(|error| format!("读取导入文件失败: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_IMPORT_BYTES {
        return Err("导入文件必须是小于 32MB 的 JSON 或 CSV 文件".to_string());
    }
    let bytes = SecretBytes(fs::read(&path).map_err(|error| format!("读取导入文件失败: {error}"))?);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let (parsed, format) = match extension.as_str() {
        "json" => (parse_json_import(&bytes.0)?, "JSON v1"),
        "csv" => (parse_csv_import(&bytes.0)?, "CSV"),
        _ => return Err("仅支持 .json 和 .csv 导入文件".to_string()),
    };
    let ParsedImport {
        entries,
        candidates,
        total,
        uneditable_invalid,
        warnings,
        issues,
    } = parsed;
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库状态不可用".to_string())?;
    let existing = load_vault(&storage)?;
    let keys = existing
        .items
        .iter()
        .filter(|entry| entry.deleted_at.is_none())
        .map(PasswordRecord::duplicate_key)
        .collect::<HashSet<_>>();
    let conflicts = import_conflicts(&entries, keys.clone());
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
    let invalid = candidates.len() + uneditable_invalid;
    let mut pending = manager
        .pending
        .lock()
        .map_err(|_| "导入预览状态不可用".to_string())?;
    let now = Utc::now().timestamp_millis();
    pending.retain(|_, preview| now.saturating_sub(preview.created_at) < IMPORT_PREVIEW_TTL_MILLIS);
    if pending.len() >= MAX_PENDING_IMPORTS {
        return Err("同时打开的导入预览过多，请先完成或取消已有预览".to_string());
    }
    pending.insert(
        token.clone(),
        PendingImport {
            entries,
            candidates,
            uneditable_invalid,
            created_at: now,
            vault_path: expected_vault_path(&storage)?,
        },
    );
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
        conflicts,
    })
}

fn import_conflicts(entries: &[PasswordRecord], mut seen: HashSet<String>) -> Vec<ImportConflict> {
    let existing = seen.clone();
    entries
        .iter()
        .filter_map(|entry| {
            let key = entry.duplicate_key();
            if seen.insert(key.clone()) {
                return None;
            }
            Some(ImportConflict {
                id: entry.id.clone(),
                service: entry.service.clone(),
                username: entry.username.clone(),
                source: if existing.contains(&key) {
                    "密码库中已有相同名称与用户名"
                } else {
                    "导入文件内存在重复条目"
                }
                .to_string(),
            })
        })
        .take(100)
        .collect()
}

fn pending_duplicate_count(
    existing: &PasswordVault,
    pending: &PendingImport,
) -> Result<usize, String> {
    let mut seen = existing
        .items
        .iter()
        .filter(|entry| entry.deleted_at.is_none())
        .map(PasswordRecord::duplicate_key)
        .collect::<HashSet<_>>();
    Ok(pending
        .entries
        .iter()
        .filter(|entry| !seen.insert(entry.duplicate_key()))
        .count())
}

#[tauri::command]
pub(crate) async fn update_password_import_entry(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    token: String,
    issue_id: String,
    correction: ImportCorrection,
) -> Result<ImportCorrectionResult, String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库状态不可用".to_string())?;
    let mut pending_map = manager
        .pending
        .lock()
        .map_err(|_| "导入预览状态不可用".to_string())?;
    let pending = pending_map
        .get_mut(&token)
        .ok_or_else(|| "导入预览已失效，请重新选择文件".to_string())?;
    if pending.vault_path != expected_vault_path(&storage)? {
        return Err("数据目录已经变化，请重新选择文件".to_string());
    }
    pending.created_at = Utc::now().timestamp_millis();
    let index = pending
        .candidates
        .iter()
        .position(|candidate| candidate.id == issue_id)
        .ok_or_else(|| "错误条目已修正或不存在".to_string())?;

    if let Some(service) = correction.service {
        if service.chars().count() > 200 {
            return Err("名称不能超过 200 个字符".to_string());
        }
        pending.candidates[index].entry.service = service;
    }
    if let Some(password) = correction.password {
        if password.chars().count() > 10_000 {
            return Err("密码不能超过 10000 个字符".to_string());
        }
        wipe_string(&mut pending.candidates[index].entry.password);
        pending.candidates[index].entry.password = password;
    }
    for (value, target, limit, label) in [(
        correction.username,
        &mut pending.candidates[index].entry.username,
        500,
        "用户名",
    )] {
        if let Some(value) = value {
            if value.chars().count() > limit {
                return Err(format!("{label}超出限制"));
            }
            *target = value;
        }
    }
    let candidate = &mut pending.candidates[index].entry;
    for (value, target, limit, label) in [
        (correction.phone, &mut candidate.phone, 100, "手机号"),
        (correction.email, &mut candidate.email, 500, "邮箱"),
        (correction.note, &mut candidate.note, 10_000, "备注"),
        (correction.category, &mut candidate.category, 200, "分类"),
        (correction.url, &mut candidate.url, 2_000, "网址"),
    ] {
        if let Some(value) = value {
            if value.chars().count() > limit {
                return Err(format!("{label}超出限制"));
            }
            *target = value;
        }
    }

    let errors = import_validation_errors(&pending.candidates[index].entry);
    let mut item = None;
    let issue = if errors.is_empty() {
        let candidate = pending.candidates.remove(index);
        let record =
            imported_record(candidate.entry).ok_or_else(|| "条目仍缺少名称或密码".to_string())?;
        item = Some(record.safe_summary());
        pending.entries.push(record);
        None
    } else {
        let candidate = &pending.candidates[index];
        Some(import_issue(
            candidate.id.clone(),
            true,
            candidate.source.clone(),
            &candidate.entry,
            errors,
        ))
    };
    let existing = load_vault(&storage)?;
    let duplicates = pending_duplicate_count(&existing, pending)?;
    let conflicts = import_conflicts(
        &pending.entries,
        existing
            .items
            .iter()
            .filter(|entry| entry.deleted_at.is_none())
            .map(PasswordRecord::duplicate_key)
            .collect(),
    );
    Ok(ImportCorrectionResult {
        ready: pending.entries.len(),
        duplicates,
        invalid: pending.candidates.len() + pending.uneditable_invalid,
        item,
        issue,
        conflicts,
    })
}

#[tauri::command]
pub(crate) async fn commit_password_import(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    token: String,
    strategy: DuplicateStrategy,
    decisions: Option<Vec<ImportDecision>>,
) -> Result<ImportResult, String> {
    let _work = super::launch::keep_native_work(&app);
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库写入状态不可用".to_string())?;
    let mut pending_map = manager
        .pending
        .lock()
        .map_err(|_| "导入预览状态不可用".to_string())?;
    let pending = pending_map
        .get(&token)
        .ok_or_else(|| "导入预览已失效，请重新选择文件".to_string())?;
    if pending.vault_path != expected_vault_path(&storage)? {
        return Err("数据目录已经变化，请重新选择文件".to_string());
    }
    let mut vault = load_vault(&storage)?;
    let decisions = decisions.unwrap_or_default();
    if decisions.len() > 1000 {
        return Err("逐项处理的条目过多".to_string());
    }
    let result = commit_pending(
        &mut pending_map,
        &token,
        &mut vault,
        strategy,
        &decisions,
        |vault| save_vault(&storage, vault),
    )?;
    manager.replace_index(expected_vault_path(&storage)?, &vault);
    // Keep the complete preview available until the encrypted file has committed successfully.
    let _ = app.emit("password-vault-changed", ());
    Ok(result)
}

fn commit_pending(
    pending_map: &mut HashMap<String, PendingImport>,
    token: &str,
    vault: &mut PasswordVault,
    strategy: DuplicateStrategy,
    decisions: &[ImportDecision],
    persist: impl FnOnce(&PasswordVault) -> Result<(), String>,
) -> Result<ImportResult, String> {
    let pending = pending_map
        .get(token)
        .ok_or_else(|| "导入预览已失效，请重新选择文件".to_string())?;
    let result = apply_import(vault, &pending.entries, strategy, decisions);
    persist(vault)?;
    pending_map.remove(token);
    Ok(result)
}

fn apply_import(
    vault: &mut PasswordVault,
    entries: &[PasswordRecord],
    strategy: DuplicateStrategy,
    decisions: &[ImportDecision],
) -> ImportResult {
    let mut imported = 0;
    let mut skipped = 0;
    let mut overwritten = 0;
    let overrides = decisions
        .iter()
        .map(|decision| (decision.id.as_str(), decision.strategy))
        .collect::<HashMap<_, _>>();
    let mut positions = HashMap::new();
    for (index, entry) in vault
        .items
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.deleted_at.is_none())
    {
        positions.entry(entry.duplicate_key()).or_insert(index);
    }
    for entry in entries {
        let mut incoming = entry.clone();
        let key = incoming.duplicate_key();
        let existing = positions.get(&key).copied();
        let chosen = overrides
            .get(entry.id.as_str())
            .copied()
            .unwrap_or(strategy);
        match (existing, chosen) {
            (Some(_), DuplicateStrategy::Skip) => skipped += 1,
            (Some(_), DuplicateStrategy::Keep) | (None, _) => {
                incoming.id = Uuid::new_v4().to_string();
                positions.entry(key).or_insert(vault.items.len());
                vault.items.push(incoming);
                imported += 1;
            }
            (Some(index), DuplicateStrategy::Overwrite) => {
                let id = vault.items[index].id.clone();
                let created_at = vault.items[index].created_at;
                incoming.favorite |= vault.items[index].favorite;
                incoming.last_used_at = vault.items[index].last_used_at;
                incoming.use_count = vault.items[index].use_count;
                vault.items[index].wipe_secret();
                incoming.id = id;
                incoming.created_at = created_at;
                incoming.updated_at = Utc::now().timestamp_millis();
                vault.items[index] = incoming;
                overwritten += 1;
            }
        }
    }
    ImportResult {
        imported,
        skipped,
        overwritten,
    }
}

#[tauri::command]
pub(crate) async fn discard_password_import(
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
pub(crate) async fn set_password_settings(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    settings: PasswordSettings,
) -> Result<PasswordSettings, String> {
    let _work = super::launch::keep_native_work(&app);
    settings.validate()?;
    let path = settings_path(&storage)?;
    let bytes =
        serde_json::to_vec_pretty(&settings).map_err(|error| format!("保存设置失败: {error}"))?;
    atomic_write_config(&path, &bytes)?;
    let _ = app.emit("password-settings-changed", &settings);
    Ok(settings)
}

fn is_weak_password(value: &str) -> bool {
    if value.chars().count() < 12 {
        return true;
    }
    let words = value.split('-').collect::<Vec<_>>();
    if words.len() >= 12
        && words
            .iter()
            .all(|word| word.len() >= 3 && word.chars().all(|ch| ch.is_ascii_alphabetic()))
        && words.iter().copied().collect::<HashSet<_>>().len() >= 8
    {
        return false;
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
pub(crate) async fn audit_password_security(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
) -> Result<PasswordSecurityReport, String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库状态不可用".to_string())?;
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

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PasswordExportFormat {
    Json,
    Csv,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasswordExportResult {
    count: usize,
    bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedPassword<'a> {
    service: &'a str,
    username: &'a str,
    phone: &'a str,
    email: &'a str,
    password: &'a str,
    note: &'a str,
    category: &'a str,
    url: &'a str,
    favorite: bool,
    custom_fields: &'a [PasswordCustomField],
}

fn export_bytes(
    entries: &[&PasswordRecord],
    format: PasswordExportFormat,
) -> Result<SecretBytes, String> {
    match format {
        PasswordExportFormat::Json => {
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Payload<'a> {
                app: &'static str,
                version: u32,
                export_date: String,
                count: usize,
                passwords: Vec<ExportedPassword<'a>>,
            }
            let payload = Payload {
                app: "REPassCard",
                version: 1,
                export_date: Utc::now().to_rfc3339(),
                count: entries.len(),
                passwords: entries
                    .iter()
                    .map(|entry| ExportedPassword {
                        service: &entry.service,
                        username: &entry.username,
                        phone: &entry.phone,
                        email: &entry.email,
                        password: &entry.password,
                        note: &entry.note,
                        category: &entry.category,
                        url: &entry.url,
                        favorite: entry.favorite,
                        custom_fields: &entry.custom_fields,
                    })
                    .collect(),
            };
            serde_json::to_vec_pretty(&payload)
                .map(SecretBytes)
                .map_err(|_| "生成 JSON 导出文件失败".to_string())
        }
        PasswordExportFormat::Csv => {
            let mut writer = csv::WriterBuilder::new()
                .terminator(csv::Terminator::CRLF)
                .from_writer(vec![0xef, 0xbb, 0xbf]);
            writer
                .write_record(["服务", "用户名", "手机号", "邮箱", "密码", "备注", "分类"])
                .map_err(|_| "生成 CSV 表头失败".to_string())?;
            for entry in entries {
                writer
                    .write_record([
                        &entry.service,
                        &entry.username,
                        &entry.phone,
                        &entry.email,
                        &entry.password,
                        &entry.note,
                        &entry.category,
                    ])
                    .map_err(|_| "生成 CSV 条目失败".to_string())?;
            }
            writer
                .into_inner()
                .map(SecretBytes)
                .map_err(|_| "生成 CSV 导出文件失败".to_string())
        }
    }
}

fn write_export(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| "导出目录不存在".to_string())?;
    if path.is_dir() {
        return Err("请选择文件保存路径".to_string());
    }
    let temporary = parent.join(format!(".dtkit-password-export-{}.tmp", Uuid::new_v4()));
    let backup = parent.join(format!(".dtkit-password-export-{}.backup", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法创建导出文件，请检查目录权限".to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "写入导出文件失败".to_string())?;
        drop(file);
        if path.exists() {
            fs::rename(path, &backup)
                .map_err(|_| "无法替换已有文件，文件可能正被占用".to_string())?;
        }
        if fs::rename(&temporary, path).is_err() {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err("提交导出文件失败，原文件已保留".to_string());
        }
        let _ = fs::remove_file(&backup);
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[tauri::command]
pub(crate) async fn export_password_entries(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    path: String,
    format: PasswordExportFormat,
    confirmed: bool,
    query: Option<String>,
    view: Option<String>,
    category: Option<String>,
) -> Result<PasswordExportResult, String> {
    let _work = super::launch::keep_native_work(&app);
    if !confirmed {
        return Err("请先确认明文密码导出的风险".to_string());
    }
    let path = PathBuf::from(path);
    let extension = match format {
        PasswordExportFormat::Json => "json",
        PasswordExportFormat::Csv => "csv",
    };
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|value| value.to_string_lossy().eq_ignore_ascii_case(extension))
    {
        return Err(format!("请保存为 .{extension} 文件"));
    }
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库状态不可用".to_string())?;
    let vault = load_vault(&storage)?;
    let (scope, needle) = parse_search(query.as_deref().unwrap_or_default());
    let view = view.as_deref().unwrap_or("all");
    if !matches!(
        view,
        "all" | "favorites" | "recent" | "category" | "uncategorized"
    ) {
        return Err("此视图不支持导出".to_string());
    }
    let entries = vault
        .items
        .iter()
        .filter(|entry| entry.deleted_at.is_none())
        .filter(|entry| {
            let in_view = match view {
                "favorites" => entry.favorite,
                "recent" => entry.last_used_at.is_some(),
                "category" => entry.category == category.as_deref().unwrap_or_default(),
                "uncategorized" => entry.category.trim().is_empty(),
                _ => true,
            };
            in_view && IndexedPassword::from_record(entry).matches(&scope, &needle)
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Err("当前范围没有可导出的密码".to_string());
    }
    let bytes = export_bytes(&entries, format)?;
    write_export(&path, &bytes.0)?;
    Ok(PasswordExportResult {
        count: entries.len(),
        bytes: bytes.0.len(),
    })
}

#[tauri::command]
pub(crate) async fn copy_password(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
) -> Result<(), String> {
    let _work = super::launch::keep_native_work(&app);
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
        let _ = app.emit("password-vault-changed", ());
    }
    let clear_after = load_settings(&storage).clipboard_clear_seconds;
    drop(vault);
    if clear_after > 0 {
        let clipboard_work = super::launch::keep_native_work(&app);
        tauri::async_runtime::spawn(async move {
            let _clipboard_work = clipboard_work;
            clear_sensitive_after(sequence, &fingerprint, Duration::from_secs(clear_after)).await;
            drop(app);
        });
    }
    // Clipboard copy succeeded independently of optional usage statistics persistence.
    Ok(())
}

#[tauri::command]
pub(crate) async fn copy_password_field(
    app: AppHandle,
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
    field: String,
) -> Result<(), String> {
    let _work = super::launch::keep_native_work(&app);
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库状态不可用".to_string())?;
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
        let clipboard_work = super::launch::keep_native_work(&app);
        tauri::async_runtime::spawn(async move {
            let _clipboard_work = clipboard_work;
            clear_sensitive_after(sequence, &fingerprint, Duration::from_secs(clear_after)).await;
            drop(app);
        });
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_password_url(
    storage: tauri::State<'_, StorageManager>,
    manager: tauri::State<'_, PasswordVaultManager>,
    id: String,
) -> Result<(), String> {
    let _access = manager
        .index_build
        .lock()
        .map_err(|_| "密码库状态不可用".to_string())?;
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
    open_clipboard_with_owner(windows::Win32::Foundation::HWND(std::ptr::null_mut()))
}

#[cfg(target_os = "windows")]
fn open_clipboard_with_owner(
    owner: windows::Win32::Foundation::HWND,
) -> Result<ClipboardGuard, String> {
    use windows::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..8 {
        if unsafe { OpenClipboard(owner) }.is_ok() {
            return Ok(ClipboardGuard);
        }
        std::thread::sleep(Duration::from_millis(12));
    }
    Err("剪贴板正被其他程序占用，请稍后重试".to_string())
}

#[cfg(target_os = "windows")]
struct ClipboardOwner(windows::Win32::Foundation::HWND);

#[cfg(target_os = "windows")]
impl Drop for ClipboardOwner {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(self.0);
        }
    }
}

#[cfg(target_os = "windows")]
fn clipboard_owner() -> Result<ClipboardOwner, String> {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
    };
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            w!(""),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            None,
            None,
        )
    }
    .map(ClipboardOwner)
    .map_err(|_| "无法创建安全剪贴板所有者".to_string())
}

#[cfg(target_os = "windows")]
unsafe fn clipboard_memory(bytes: &[u8]) -> Result<windows::Win32::Foundation::HGLOBAL, String> {
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    let memory =
        GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|_| "分配剪贴板内存失败".to_string())?;
    let pointer = GlobalLock(memory);
    if pointer.is_null() {
        let _ = windows::Win32::Foundation::GlobalFree(memory);
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
    let result = (|| {
        let text_bytes =
            unsafe { std::slice::from_raw_parts(utf16.as_ptr() as *const u8, utf16.len() * 2) };
        let owner = clipboard_owner()?;
        let _guard = open_clipboard_with_owner(owner.0)?;
        unsafe {
            EmptyClipboard().map_err(|_| "清空旧剪贴板内容失败".to_string())?;
            let text = clipboard_memory(text_bytes)?;
            if SetClipboardData(13, HANDLE(text.0)).is_err() {
                let _ = windows::Win32::Foundation::GlobalFree(text);
                return Err("写入密码到剪贴板失败".to_string());
            }

            // Prevent this password from entering Win+V history and cloud clipboard.
            for (name, flag) in [
                (w!("ExcludeClipboardContentFromMonitorProcessing"), 1_u32),
                (w!("CanIncludeInClipboardHistory"), 0_u32),
                (w!("CanUploadToCloudClipboard"), 0_u32),
            ] {
                let format = RegisterClipboardFormatW(name);
                if format != 0 {
                    if let Ok(marker) = clipboard_memory(&flag.to_ne_bytes()) {
                        if SetClipboardData(format, HANDLE(marker.0)).is_err() {
                            let _ = windows::Win32::Foundation::GlobalFree(marker);
                        }
                    }
                }
            }
            Ok(GetClipboardSequenceNumber())
        }
    })();
    for word in &mut utf16 {
        unsafe {
            std::ptr::write_volatile(word, 0);
        }
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn write_sensitive_clipboard(_value: &str) -> Result<u32, String> {
    Err("安全剪贴板当前仅支持 Windows".to_string())
}

#[cfg(target_os = "windows")]
fn clipboard_text() -> Result<String, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    let handle = unsafe { GetClipboardData(13) }.map_err(|_| "剪贴板当前不是文本".to_string())?;
    let memory = HGLOBAL(handle.0);
    let pointer = unsafe { GlobalLock(memory) } as *const u16;
    if pointer.is_null() {
        return Err("无法读取剪贴板文本".to_string());
    }
    let capacity = unsafe { GlobalSize(memory) } / 2;
    let words = unsafe { std::slice::from_raw_parts(pointer, capacity.min(100_001)) };
    let result = words
        .iter()
        .position(|word| *word == 0)
        .map(|length| String::from_utf16_lossy(&words[..length]))
        .ok_or_else(|| "剪贴板文本未正常结束，已停止读取".to_string());
    unsafe {
        let _ = GlobalUnlock(memory);
    }
    result
}

async fn clear_sensitive_after(sequence: u32, expected_hash: &[u8], delay: Duration) {
    tokio::time::sleep(delay).await;
    // An occupied clipboard may become available shortly afterwards. Each retry still
    // checks both sequence and fingerprint, so a newer copy can never be cleared.
    for attempt in 0..6 {
        if clear_clipboard_if_unchanged(sequence, expected_hash).is_ok() {
            return;
        }
        if attempt < 5 {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
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

    fn manager_with_pending_imports() -> PasswordVaultManager {
        let manager = PasswordVaultManager::default();
        manager.replace_index(
            PathBuf::from("vault.dpapi"),
            &PasswordVault {
                version: VAULT_VERSION,
                items: Vec::new(),
            },
        );
        let mut pending = manager.pending.lock().unwrap();
        for token in ["main-import", "quick-import"] {
            let parsed = parse_json_import(
                br#"{"app":"REPassCard","version":1,"count":2,"passwords":[{"service":"Mail","password":"import-secret"},{"service":"","password":"correction-secret"}]}"#,
            )
            .unwrap();
            pending.insert(
                token.to_string(),
                PendingImport {
                    entries: parsed.entries,
                    candidates: parsed.candidates,
                    uneditable_invalid: parsed.uneditable_invalid,
                    created_at: Utc::now().timestamp_millis(),
                    vault_path: PathBuf::from("vault.dpapi"),
                },
            );
        }
        drop(pending);
        manager
    }

    #[test]
    fn releasing_cached_index_preserves_each_windows_pending_import() {
        let manager = manager_with_pending_imports();
        assert!(manager.index.read().unwrap().is_some());

        manager.release_cached_index();

        assert!(manager.index.read().unwrap().is_none());
        let pending = manager.pending.lock().unwrap();
        assert_eq!(pending.len(), 2);
        for token in ["main-import", "quick-import"] {
            let import = pending.get(token).unwrap();
            assert_eq!(import.entries.len(), 1);
            assert_eq!(import.entries[0].password, "import-secret");
            assert_eq!(import.candidates.len(), 1);
            assert_eq!(import.candidates[0].entry.password, "correction-secret");
        }
    }

    #[test]
    fn changing_storage_clears_cached_index_and_all_pending_imports() {
        let manager = manager_with_pending_imports();

        manager.reset_for_storage_change();

        assert!(manager.index.read().unwrap().is_none());
        assert!(manager.pending.lock().unwrap().is_empty());
    }

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
            url: String::new(),
            favorite: false,
            custom_fields: Vec::new(),
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
            url: String::new(),
            favorite: false,
            custom_fields: Vec::new(),
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
        assert_eq!(parsed.candidates.len(), 1);
        assert_eq!(parsed.candidates[0].entry.service, "");
        assert_eq!(parsed.candidates[0].entry.password, "invalid");
        assert!(parsed.issues[0].editable);
        assert!(!parsed.issues[0].id.is_empty());
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
        assert_eq!(parsed.candidates.len() + parsed.uneditable_invalid, 2);
        assert_eq!(parsed.issues[0].source, "第 2 条");
        assert_eq!(parsed.issues[0].username, "missing-name");
        assert_eq!(parsed.issues[1].service, "Mail");
        assert!(parsed.issues[1]
            .errors
            .iter()
            .any(|error| error == "密码为空"));
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
        assert_eq!(parsed.candidates.len() + parsed.uneditable_invalid, 2);
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

    #[test]
    fn json_export_round_trip_preserves_extended_fields() {
        let parsed = parse_json_import(br#"{"app":"REPassCard","version":1,"count":1,"passwords":[{"service":"Mail","username":"me","password":"private-value","url":"https://example.com","favorite":true,"customFields":[{"label":"recovery","value":"sensitive-recovery","sensitive":true}]}]}"#).unwrap();
        let bytes = export_bytes(
            &parsed.entries.iter().collect::<Vec<_>>(),
            PasswordExportFormat::Json,
        )
        .unwrap();
        let imported = parse_json_import(&bytes.0).unwrap();
        assert_eq!(imported.entries.len(), 1);
        let entry = &imported.entries[0];
        assert_eq!(entry.password, "private-value");
        assert_eq!(entry.url, "https://example.com");
        assert!(entry.favorite);
        assert_eq!(entry.custom_fields[0].value, "sensitive-recovery");
        assert!(entry.custom_fields[0].sensitive);
    }

    #[test]
    fn csv_export_round_trip_handles_quotes_commas_newlines_and_bom() {
        let parsed = parse_json_import(br#"{"app":"REPassCard","version":1,"count":1,"passwords":[{"service":"Mail","password":"a,b\"c","note":"first\nsecond"}]}"#).unwrap();
        let bytes = export_bytes(
            &parsed.entries.iter().collect::<Vec<_>>(),
            PasswordExportFormat::Csv,
        )
        .unwrap();
        assert!(bytes.0.starts_with(&[0xef, 0xbb, 0xbf]));
        let imported = parse_csv_import(&bytes.0).unwrap();
        assert_eq!(imported.entries[0].password, "a,b\"c");
        assert_eq!(imported.entries[0].note, "first\nsecond");
    }

    #[test]
    fn malformed_json_row_does_not_reject_valid_rows_or_leak_values() {
        let parsed = parse_json_import(br#"{"app":"REPassCard","version":1,"count":3,"passwords":[{"service":"Good","password":"secret-ok"},{"service":42,"password":"secret-error"},{"service":"Other","password":"secret-other"}]}"#).unwrap();
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.uneditable_invalid, 1);
        assert_eq!(parsed.issues[0].source, "第 2 条");
        assert!(!serde_json::to_string(&parsed.issues)
            .unwrap()
            .contains("secret-error"));
    }

    #[test]
    fn import_and_editor_share_length_limits() {
        let source = serde_json::json!({"app":"REPassCard","version":1,"count":1,"passwords":[{"service":"x".repeat(201),"password":"valid"}]}).to_string();
        let parsed = parse_json_import(source.as_bytes()).unwrap();
        assert!(parsed.entries.is_empty());
        assert!(parsed.issues[0].errors[0].starts_with("名称超过"));
    }

    #[test]
    fn paginated_search_reaches_all_results_and_handles_deleted_pages() {
        let parsed = parse_json_import(br#"{"app":"REPassCard","version":1,"count":3,"passwords":[{"service":"C","password":"3"},{"service":"A","password":"1"},{"service":"B","password":"2"}]}"#).unwrap();
        let vault = PasswordVault {
            version: VAULT_VERSION,
            items: parsed.entries,
        };
        let cache = PasswordIndexCache::from_vault(PathBuf::from("test"), &vault);
        let first = cache.search_page(&SearchScope::Global, "", false, "all", "", 2, 0, "name");
        assert_eq!(first.items[0].service, "A");
        assert_eq!(first.items[1].service, "B");
        assert!(first.truncated);
        let second = cache.search_page(&SearchScope::Global, "", false, "all", "", 2, 2, "name");
        assert_eq!(second.items[0].service, "C");
        assert_eq!(second.offset, 2);
        assert!(!second.truncated);
        let stale_page =
            cache.search_page(&SearchScope::Global, "", false, "all", "", 2, 999, "name");
        assert_eq!(stale_page.offset, 2);
    }

    #[test]
    fn per_entry_duplicate_decisions_override_global_strategy() {
        let parsed = parse_json_import(br#"{"app":"REPassCard","version":1,"count":3,"passwords":[{"service":"Mail","password":"old"},{"service":"Mail","password":"new"},{"service":"Mail","password":"other"}]}"#).unwrap();
        let mut vault = PasswordVault {
            version: VAULT_VERSION,
            items: vec![parsed.entries[0].clone()],
        };
        let original_id = vault.items[0].id.clone();
        let result = apply_import(
            &mut vault,
            &parsed.entries[1..],
            DuplicateStrategy::Skip,
            &[
                ImportDecision {
                    id: parsed.entries[1].id.clone(),
                    strategy: DuplicateStrategy::Overwrite,
                },
                ImportDecision {
                    id: parsed.entries[2].id.clone(),
                    strategy: DuplicateStrategy::Keep,
                },
            ],
        );
        assert_eq!(
            (result.imported, result.overwritten, result.skipped),
            (1, 1, 0)
        );
        assert_eq!(vault.items[0].id, original_id);
        assert_eq!(vault.items[0].password, "new");
        assert_eq!(vault.items[1].password, "other");
    }

    #[test]
    fn failed_import_persistence_keeps_preview_for_retry() {
        let manager = manager_with_pending_imports();
        let mut pending = manager.pending.lock().unwrap();
        let mut vault = PasswordVault {
            version: VAULT_VERSION,
            items: Vec::new(),
        };
        let failure = commit_pending(
            &mut pending,
            "main-import",
            &mut vault,
            DuplicateStrategy::Skip,
            &[],
            |_| Err("disk full".to_string()),
        );
        assert!(failure.is_err());
        assert!(pending.contains_key("main-import"));
        let mut retry_vault = PasswordVault {
            version: VAULT_VERSION,
            items: Vec::new(),
        };
        let result = commit_pending(
            &mut pending,
            "main-import",
            &mut retry_vault,
            DuplicateStrategy::Skip,
            &[],
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(result.imported, 1);
        assert!(!pending.contains_key("main-import"));
        assert!(pending.contains_key("quick-import"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "Requires Windows permission to create a private window station; never uses the user's clipboard"]
    fn real_clipboard_expiry_runs_in_private_window_station() {
        use std::os::windows::process::CommandExt;
        if std::env::var_os("DTKIT_PRIVATE_CLIPBOARD_TEST").is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "infrastructure::passwords::tests::real_clipboard_expiry_runs_in_private_window_station", "--ignored", "--nocapture", "--test-threads=1"])
                .env("DTKIT_PRIVATE_CLIPBOARD_TEST", "1").creation_flags(0x08000000).output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        #[link(name = "user32")]
        extern "system" {
            fn CreateWindowStationW(
                name: *const u16,
                flags: u32,
                access: u32,
                security: *const std::ffi::c_void,
            ) -> *mut std::ffi::c_void;
            fn GetProcessWindowStation() -> *mut std::ffi::c_void;
            fn SetProcessWindowStation(station: *mut std::ffi::c_void) -> i32;
            fn CloseWindowStation(station: *mut std::ffi::c_void) -> i32;
        }
        // A private station owns a separate clipboard. The user's clipboard is never opened.
        let original = unsafe { GetProcessWindowStation() };
        let name = format!("DtKitClipboardTest-{}\0", Uuid::new_v4())
            .encode_utf16()
            .collect::<Vec<_>>();
        let station =
            unsafe { CreateWindowStationW(name.as_ptr(), 0, 0x0000003f, std::ptr::null()) };
        assert!(
            !station.is_null(),
            "Cannot create private test window station: {}",
            std::io::Error::last_os_error()
        );
        assert_ne!(unsafe { SetProcessWindowStation(station) }, 0);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let first = write_sensitive_clipboard("password-one").unwrap();
            let second = write_sensitive_clipboard("password-two").unwrap();
            let third = write_sensitive_clipboard("password-three").unwrap();
            clear_sensitive_after(
                first,
                &Sha256::digest(b"password-one"),
                Duration::from_millis(10),
            )
            .await;
            clear_sensitive_after(
                second,
                &Sha256::digest(b"password-two"),
                Duration::from_millis(10),
            )
            .await;
            {
                let _guard = open_clipboard().unwrap();
                assert_eq!(clipboard_text().unwrap(), "password-three");
            }
            clear_sensitive_after(
                third,
                &Sha256::digest(b"password-three"),
                Duration::from_millis(10),
            )
            .await;
            {
                let _guard = open_clipboard().unwrap();
                assert!(clipboard_text().is_err());
            }
            let secret = write_sensitive_clipboard("secret").unwrap();
            write_sensitive_clipboard("ordinary-text-afterwards").unwrap();
            clear_sensitive_after(
                secret,
                &Sha256::digest(b"secret"),
                Duration::from_millis(10),
            )
            .await;
            {
                let _guard = open_clipboard().unwrap();
                assert_eq!(clipboard_text().unwrap(), "ordinary-text-afterwards");
            }
            let old = write_sensitive_clipboard("same-password").unwrap();
            let recent = write_sensitive_clipboard("same-password").unwrap();
            clear_sensitive_after(
                old,
                &Sha256::digest(b"same-password"),
                Duration::from_millis(10),
            )
            .await;
            {
                let _guard = open_clipboard().unwrap();
                assert_eq!(clipboard_text().unwrap(), "same-password");
            }
            clear_sensitive_after(
                recent,
                &Sha256::digest(b"same-password"),
                Duration::from_millis(10),
            )
            .await;
            {
                let _guard = open_clipboard().unwrap();
                assert!(clipboard_text().is_err());
            }
        });
        unsafe {
            SetProcessWindowStation(original);
            CloseWindowStation(station);
        }
    }
}
