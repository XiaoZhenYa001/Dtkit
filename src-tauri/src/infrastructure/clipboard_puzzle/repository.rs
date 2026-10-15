use super::{AssetResult, CopyRequest, MAX_IMAGE_BYTES, MAX_PIXELS};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

const MAX_NODES: usize = 1000;
const MAX_DOCUMENT: usize = 12 * 1024 * 1024;
const MAX_POINTS: usize = 100_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Point {
    pub(crate) x: f64,
    pub(crate) y: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Frame {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}
impl Default for Frame {
    fn default() -> Self {
        Self {
            x: 60.,
            y: 86.,
            w: 824.,
            h: 580.,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Node {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) original_body: String,
    #[serde(default)]
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) asset_id: Option<String>,
    #[serde(default)]
    pub(crate) group_id: Option<String>,
    #[serde(default)]
    pub(crate) points: Vec<Point>,
    #[serde(default = "default_color")]
    pub(crate) color: String,
    #[serde(default = "default_font")]
    pub(crate) font_size: f64,
    #[serde(default)]
    pub(crate) rotation: f64,
    #[serde(default)]
    pub(crate) source_url: Option<String>,
    #[serde(default)]
    pub(crate) collected_at: i64,
}
fn default_color() -> String {
    "#cf6c43".into()
}
fn default_font() -> f64 {
    18.
}
impl Node {
    pub(crate) fn new(kind: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            x: 84.,
            y: 110.,
            w: 320.,
            h: 160.,
            name: String::new(),
            body: String::new(),
            original_body: String::new(),
            url: String::new(),
            asset_id: None,
            group_id: None,
            points: Vec::new(),
            color: default_color(),
            font_size: default_font(),
            rotation: 0.,
            source_url: None,
            collected_at: Utc::now().timestamp_millis(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskMeta {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) saved: bool,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) revision: u64,
    pub(crate) count: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Task {
    pub(crate) meta: TaskMeta,
    pub(crate) nodes: Vec<Node>,
    pub(crate) frame: Frame,
    pub(crate) background: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Operation {
    Upsert {
        nodes: Vec<Node>,
    },
    Remove {
        ids: Vec<String>,
    },
    Configure {
        name: Option<String>,
        saved: Option<bool>,
        background: Option<String>,
        frame: Option<Frame>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    retention_hours: u64,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            retention_hours: 24,
        }
    }
}

#[derive(Default)]
pub(crate) struct Repository {
    root: PathBuf,
    catalog: HashMap<String, TaskMeta>,
    sessions: HashMap<String, String>,
    retention: u64,
    asset_bytes: u64,
}

pub(crate) fn safe_id(id: &str) -> Result<&str, String> {
    uuid::Uuid::parse_str(id)
        .map(|_| id)
        .map_err(|_| "拼图标识无效".into())
}
fn safe_asset(id: &str) -> Result<&str, String> {
    if id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Ok(id)
    } else {
        Err("图片资源标识无效".into())
    }
}
fn valid_frame(f: &Frame) -> bool {
    [f.x, f.y, f.w, f.h]
        .iter()
        .all(|v| v.is_finite() && v.abs() <= 1_000_000.)
        && f.w >= 16.
        && f.h >= 16.
}

fn validate(task: &Task) -> Result<(), String> {
    if task.nodes.len() > MAX_NODES {
        return Err("当前拼图已达到 1000 个对象，请新建任务继续收集".into());
    }
    if !valid_frame(&task.frame) {
        return Err("拼图框尺寸无效".into());
    }
    let mut ids = HashSet::new();
    let mut points = 0;
    for n in &task.nodes {
        safe_id(&n.id)?;
        if !ids.insert(&n.id) {
            return Err("对象标识重复".into());
        }
        if !matches!(
            n.kind.as_str(),
            "image" | "text" | "note" | "link" | "rect" | "arrow" | "pen"
        ) {
            return Err("对象类型不支持".into());
        }
        if [n.x, n.y, n.w, n.h]
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 1_000_000.)
            || n.w < 1.
            || n.h < 1.
            || !n.rotation.is_finite()
            || !(8. ..=120.).contains(&n.font_size)
        {
            return Err("对象尺寸或字体无效".into());
        }
        if n.body.len() > 1024 * 1024
            || n.original_body.len() > 1024 * 1024
            || n.url.len() > 8192
            || n.name.chars().count() > 120
        {
            return Err("单个文字片段过大".into());
        }
        if n.color.len() != 7
            || !n.color.starts_with('#')
            || !n.color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("颜色格式无效".into());
        }
        if let Some(id) = &n.asset_id {
            safe_asset(id)?;
        }
        if n.kind == "image" && n.asset_id.is_none() {
            return Err("图片缺少原图资源".into());
        }
        if let Some(group) = &n.group_id {
            safe_id(group)?;
        }
        points += n.points.len();
        if points > MAX_POINTS
            || n.points.iter().any(|p| {
                !p.x.is_finite()
                    || !p.y.is_finite()
                    || p.x.abs() > 1_000_000.
                    || p.y.abs() > 1_000_000.
            })
        {
            return Err("画笔数据超过安全容量".into());
        }
    }
    Ok(())
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("存储路径无效")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建拼图目录失败：{e}"))?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, bytes).map_err(|e| format!("写入拼图失败：{e}"))?;
    #[cfg(windows)]
    let result = {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let a = temp
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let b = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        unsafe {
            MoveFileExW(
                PCWSTR(a.as_ptr()),
                PCWSTR(b.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|e| format!("提交拼图失败：{e}"))
    };
    #[cfg(not(windows))]
    let result = fs::rename(&temp, path).map_err(|e| format!("提交拼图失败：{e}"));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(crate) fn validate_png(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("单张图片不能超过 32 MB".into());
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(MAX_PIXELS * 4 + 16 * 1024 * 1024);
    reader.limits(limits);
    let (w, h) = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png)
        .into_dimensions()
        .map_err(|_| "PNG 图片无法读取")?;
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("单张图片不能超过 4000 万像素".into());
    }
    reader
        .decode()
        .map_err(|e| format!("PNG 图片无法解码：{e}"))
}

impl Repository {
    #[cfg(test)]
    pub(crate) fn initialize(&mut self, root: PathBuf) -> Result<(), String> {
        self.initialize_protected(root, None)
    }
    pub(crate) fn initialize_protected(
        &mut self,
        root: PathBuf,
        collecting: Option<&str>,
    ) -> Result<(), String> {
        if self.root == root {
            return Ok(());
        }
        self.root = root;
        self.catalog.clear();
        fs::create_dir_all(self.root.join("Tasks"))
            .map_err(|e| format!("无法创建拼图存储：{e}"))?;
        fs::create_dir_all(self.root.join("Assets")).map_err(|e| e.to_string())?;
        self.retention = fs::read(self.root.join("preferences.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Preferences>(&b).ok())
            .map(|p| p.retention_hours)
            .filter(|h| matches!(h, 0 | 24 | 168))
            .unwrap_or(24);
        for entry in fs::read_dir(self.root.join("Tasks"))
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let id = entry.file_name().to_string_lossy().to_string();
            if safe_id(&id).is_err() {
                continue;
            }
            let scene = entry.path().join("task.json");
            let summary = entry.path().join("meta.json");
            let newer = fs::metadata(&scene).and_then(|m| m.modified()).ok()
                > fs::metadata(&summary).and_then(|m| m.modified()).ok();
            let meta = fs::read(summary)
                .ok()
                .and_then(|b| serde_json::from_slice::<TaskMeta>(&b).ok())
                .filter(|m| m.id == id);
            if newer || meta.is_none() {
                let _ = self.load(&id);
            } else if let Some(meta) = meta {
                self.catalog.insert(id, meta);
            }
        }
        self.cleanup(collecting)?;
        if self.sessions.is_empty() {
            self.collect_unused_assets()?;
        }
        self.asset_bytes = fs::read_dir(self.root.join("Assets"))
            .map_err(|e| e.to_string())?
            .flatten()
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum();
        Ok(())
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.root.join("Tasks").join(safe_id(id)?))
    }
    pub(crate) fn list(&self) -> Vec<TaskMeta> {
        let mut list = self.catalog.values().cloned().collect::<Vec<_>>();
        list.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
        list
    }
    pub(crate) fn retention_hours(&self) -> u64 {
        self.retention
    }
    pub(crate) fn set_retention(&mut self, hours: u64) -> Result<(), String> {
        if !matches!(hours, 0 | 24 | 168) {
            return Err("请选择 24 小时、7 天或手动清理".into());
        }
        atomic_write(
            &self.root.join("preferences.json"),
            &serde_json::to_vec(&Preferences {
                retention_hours: hours,
            })
            .map_err(|e| e.to_string())?,
        )?;
        self.retention = hours;
        Ok(())
    }
    pub(crate) fn load(&mut self, id: &str) -> Result<Task, String> {
        let path = self.path(id)?.join("task.json");
        let file = fs::File::open(&path).map_err(|_| "拼图不存在或已过期")?;
        if file.metadata().map_err(|e| e.to_string())?.len() > MAX_DOCUMENT as u64 {
            return Err("拼图文件超过安全容量".into());
        }
        let task: Task = serde_json::from_reader(file).map_err(|e| format!("拼图文件损坏：{e}"))?;
        if task.meta.id != id {
            return Err("拼图标识不一致".into());
        }
        validate(&task)?;
        self.catalog.insert(id.into(), task.meta.clone());
        Ok(task)
    }
    fn store(&mut self, task: &Task) -> Result<(), String> {
        validate(task)?;
        for n in &task.nodes {
            if let Some(asset) = &n.asset_id {
                if !self
                    .root
                    .join("Assets")
                    .join(format!("{asset}.png"))
                    .is_file()
                {
                    return Err("原图资源已丢失，不能保存空图片对象".into());
                }
            }
        }
        let bytes = serde_json::to_vec(task).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_DOCUMENT {
            return Err("拼图数据超过 12 MB，请拆分到新任务".into());
        }
        let path = self.path(&task.meta.id)?;
        atomic_write(&path.join("task.json"), &bytes)?;
        // The scene is authoritative. A stale summary after a crash is repaired on load.
        self.catalog.insert(task.meta.id.clone(), task.meta.clone());
        let _ = atomic_write(
            &path.join("meta.json"),
            &serde_json::to_vec(&task.meta).map_err(|e| e.to_string())?,
        );
        Ok(())
    }
    pub(crate) fn open(
        &mut self,
        owner: &str,
        id: Option<&str>,
        latest: bool,
    ) -> Result<Task, String> {
        let existing = id
            .map(str::to_owned)
            .or_else(|| self.sessions.get(owner).cloned())
            .or_else(|| {
                if latest {
                    self.list().first().map(|m| m.id.clone())
                } else {
                    None
                }
            });
        let task = if let Some(id) = existing {
            self.load(&id)?
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let now = Utc::now().timestamp_millis();
            let task = Task {
                meta: TaskMeta {
                    id,
                    name: "未命名拼图".into(),
                    saved: false,
                    created_at: now,
                    updated_at: now,
                    revision: 0,
                    count: 0,
                },
                nodes: Vec::new(),
                frame: Frame::default(),
                background: "dots".into(),
            };
            self.store(&task)?;
            task
        };
        self.sessions.insert(owner.into(), task.meta.id.clone());
        Ok(task)
    }
    pub(crate) fn release(&mut self, owner: &str) {
        self.sessions.remove(owner);
    }
    pub(crate) fn release_window(&mut self, label: &str) {
        let prefix = format!("{label}::");
        self.sessions.retain(|o, _| !o.starts_with(&prefix));
    }
    pub(crate) fn edit(&mut self, id: &str, operations: Vec<Operation>) -> Result<Task, String> {
        if operations.len() > 128 {
            return Err("一次操作过多".into());
        }
        let mut task = self.load(id)?;
        for op in operations {
            match op {
                Operation::Upsert { nodes } => {
                    if nodes.len() > MAX_NODES {
                        return Err("一次更新的对象过多".into());
                    }
                    for node in nodes {
                        if let Some(i) = task.nodes.iter().position(|n| n.id == node.id) {
                            task.nodes[i] = node;
                        } else {
                            task.nodes.push(node);
                        }
                    }
                }
                Operation::Remove { ids } => {
                    let ids = ids.into_iter().collect::<HashSet<_>>();
                    task.nodes.retain(|n| !ids.contains(&n.id));
                }
                Operation::Configure {
                    name,
                    saved,
                    background,
                    frame,
                } => {
                    if let Some(name) = name {
                        task.meta.name = name.trim().chars().take(60).collect();
                        if task.meta.name.is_empty() {
                            task.meta.name = "未命名拼图".into();
                        }
                    }
                    if let Some(saved) = saved {
                        task.meta.saved = saved;
                    }
                    if let Some(background) = background {
                        if !matches!(background.as_str(), "plain" | "dots" | "grid") {
                            return Err("画布样式无效".into());
                        }
                        task.background = background;
                    }
                    if let Some(frame) = frame {
                        task.frame = frame;
                    }
                }
            }
        }
        task.meta.revision += 1;
        task.meta.updated_at = Utc::now().timestamp_millis();
        task.meta.count = task.nodes.len();
        self.store(&task)?;
        Ok(task)
    }
    pub(crate) fn append(&mut self, id: &str, mut nodes: Vec<Node>) -> Result<Task, String> {
        if nodes.is_empty() {
            return Err("没有可添加的内容".into());
        }
        let task = self.load(id)?;
        let min_x = nodes.iter().map(|n| n.x).fold(f64::INFINITY, f64::min);
        let min_y = nodes.iter().map(|n| n.y).fold(f64::INFINITY, f64::min);
        let width = nodes.iter().map(|n| n.x + n.w - min_x).fold(0., f64::max);
        let column = (task.frame.w - 72.) / 2.;
        let mut x = task.frame.x + 24.;
        let mut y = f64::INFINITY;
        let slots = if width <= column {
            vec![x, x + column + 24.]
        } else {
            vec![x]
        };
        for slot in slots {
            let bottom = task
                .nodes
                .iter()
                .filter(|n| n.x < slot + width + 24. && n.x + n.w + 24. > slot)
                .map(|n| n.y + n.h + 24.)
                .fold(task.frame.y + 24., f64::max);
            if bottom < y {
                y = bottom;
                x = slot;
            }
        }
        for n in &mut nodes {
            n.x = x + n.x - min_x;
            n.y = y + n.y - min_y;
        }
        let bottom = nodes.iter().map(|n| n.y + n.h).fold(0., f64::max);
        let mut frame = task.frame;
        frame.h = frame.h.max(bottom - frame.y + 24.);
        frame.w = frame.w.max(width + 48.);
        self.edit(
            id,
            vec![
                Operation::Upsert { nodes },
                Operation::Configure {
                    name: None,
                    saved: None,
                    background: None,
                    frame: Some(frame),
                },
            ],
        )
    }
    pub(crate) fn copy(&mut self, r: CopyRequest) -> Result<Task, String> {
        let source = self.load(&r.source_task_id)?;
        if source.meta.revision != r.source_revision {
            return Err("源拼图已变化，请重新拖动".into());
        }
        if r.ids.is_empty() || r.ids.len() > MAX_NODES || !r.x.is_finite() || !r.y.is_finite() {
            return Err("复制范围无效".into());
        }
        let wanted = r.ids.into_iter().collect::<HashSet<_>>();
        let mut nodes = source
            .nodes
            .into_iter()
            .filter(|n| wanted.contains(&n.id))
            .collect::<Vec<_>>();
        if nodes.len() != wanted.len() {
            return Err("部分源对象已不存在".into());
        }
        let minx = nodes.iter().map(|n| n.x).fold(f64::INFINITY, f64::min);
        let miny = nodes.iter().map(|n| n.y).fold(f64::INFINITY, f64::min);
        let mut groups = HashMap::new();
        for n in &mut nodes {
            n.id = uuid::Uuid::new_v4().to_string();
            n.x = r.x + n.x - minx;
            n.y = r.y + n.y - miny;
            if let Some(group) = &n.group_id {
                n.group_id = Some(
                    groups
                        .entry(group.clone())
                        .or_insert_with(|| uuid::Uuid::new_v4().to_string())
                        .clone(),
                );
            }
        }
        self.edit(&r.target_task_id, vec![Operation::Upsert { nodes }])
    }
    pub(crate) fn remove(&mut self, id: &str) -> Result<(), String> {
        let path = self.path(id)?;
        if path.is_dir() {
            fs::remove_dir_all(path).map_err(|e| format!("删除拼图失败：{e}"))?;
        }
        self.catalog.remove(id);
        self.sessions.retain(|_, value| value != id);
        Ok(())
    }
    pub(crate) fn cleanup(&mut self, collecting: Option<&str>) -> Result<(), String> {
        if self.retention == 0 {
            return Ok(());
        }
        let cutoff = Utc::now().timestamp_millis() - (self.retention as i64) * 3_600_000;
        let active = self.sessions.values().cloned().collect::<HashSet<_>>();
        let expired = self
            .catalog
            .values()
            .filter(|t| {
                !t.saved
                    && t.updated_at < cutoff
                    && !active.contains(&t.id)
                    && Some(t.id.as_str()) != collecting
            })
            .map(|t| t.id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            self.remove(&id)?;
        }
        Ok(())
    }
    pub(crate) fn store_png(&mut self, bytes: &[u8]) -> Result<AssetResult, String> {
        let image = validate_png(bytes)?;
        let id = hex::encode(Sha256::digest(bytes));
        let original = self.root.join("Assets").join(format!("{id}.png"));
        let preview = self.root.join("Assets").join(format!("{id}.preview.png"));
        if !original.is_file() || !preview.is_file() {
            let thumb = image.thumbnail(640, 640);
            let mut buffer = Cursor::new(Vec::new());
            thumb
                .write_to(&mut buffer, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            let needed = (if original.is_file() {
                0
            } else {
                bytes.len() as u64
            }) + (if preview.is_file() {
                0
            } else {
                buffer.get_ref().len() as u64
            });
            if self.asset_bytes.saturating_add(needed) > 2 * 1024 * 1024 * 1024 {
                return Err("拼图图片库已达到 2 GB，请清理旧任务后重新启动工具".into());
            }
            if !original.is_file() {
                atomic_write(&original, bytes)?;
                self.asset_bytes += bytes.len() as u64;
            }
            if !preview.is_file() {
                atomic_write(&preview, buffer.get_ref())?;
                self.asset_bytes += buffer.get_ref().len() as u64;
            }
        }
        Ok(AssetResult {
            asset_id: id,
            width: image.width(),
            height: image.height(),
        })
    }
    fn collect_unused_assets(&mut self) -> Result<(), String> {
        // Run before editing sessions start, preserving open pages' undo resources.
        let mut used = HashSet::new();
        // A damaged task may be absent from the catalog. Keep its resources until
        // its scene can be read again rather than interpreting it as deleted.
        for entry in fs::read_dir(self.root.join("Tasks")).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let id = entry.file_name().to_string_lossy().to_string();
            if !entry.file_type().map_err(|e| e.to_string())?.is_dir() || safe_id(&id).is_err() {
                continue;
            }
            let Ok(task) = self.load(&id) else {
                return Ok(());
            };
            for node in task.nodes {
                if let Some(asset) = node.asset_id {
                    used.insert(asset);
                }
            }
        }
        for entry in fs::read_dir(self.root.join("Assets"))
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(id) = name
                .strip_suffix(".preview.png")
                .or_else(|| name.strip_suffix(".png"))
            else {
                continue;
            };
            if safe_asset(id).is_ok() && !used.contains(id) {
                fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    pub(crate) fn asset(&self, id: &str, preview: bool) -> Result<Vec<u8>, String> {
        let id = safe_asset(id)?;
        let path = self
            .root
            .join("Assets")
            .join(format!("{id}{}.png", if preview { ".preview" } else { "" }));
        let metadata = fs::metadata(&path).map_err(|_| "原图资源不存在")?;
        if metadata.len() > MAX_IMAGE_BYTES as u64 {
            return Err("图片超过读取容量".into());
        }
        fs::read(path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        path: PathBuf,
        repo: Repository,
    }
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("dtkit-puzzle-test-{}", uuid::Uuid::new_v4()));
            let mut repo = Repository::default();
            repo.initialize(path.clone()).unwrap();
            Self { path, repo }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
    fn configure(saved: bool) -> Operation {
        Operation::Configure {
            name: None,
            saved: Some(saved),
            background: None,
            frame: None,
        }
    }
    #[test]
    fn copies_get_independent_ids_and_groups_and_preserve_relative_position() {
        let mut f = Fixture::new();
        let a = f.repo.open("main::a", None, false).unwrap();
        let b = f.repo.open("quick::b", None, false).unwrap();
        assert_ne!(a.meta.id, b.meta.id);
        let mut n = Node::new("text");
        n.body = "保留原文".into();
        n.x = 10.;
        n.y = 20.;
        n.group_id = Some(uuid::Uuid::new_v4().to_string());
        let mut m = n.clone();
        m.id = uuid::Uuid::new_v4().to_string();
        m.x = 60.;
        m.y = 90.;
        let a = f
            .repo
            .edit(
                &a.meta.id,
                vec![Operation::Upsert {
                    nodes: vec![n.clone(), m.clone()],
                }],
            )
            .unwrap();
        let copied = f
            .repo
            .copy(CopyRequest {
                source_task_id: a.meta.id.clone(),
                target_task_id: b.meta.id.clone(),
                source_revision: a.meta.revision,
                ids: vec![n.id.clone(), m.id],
                x: 400.,
                y: 200.,
            })
            .unwrap();
        assert_ne!(copied.nodes[0].id, n.id);
        assert_ne!(copied.nodes[0].group_id, n.group_id);
        assert_eq!(copied.nodes[0].group_id, copied.nodes[1].group_id);
        assert_eq!(copied.nodes[1].x - copied.nodes[0].x, 50.);
        assert_eq!(copied.nodes[0].y, 200.);
        f.repo
            .edit(
                &b.meta.id,
                vec![Operation::Remove {
                    ids: vec![copied.nodes[0].id.clone()],
                }],
            )
            .unwrap();
        assert_eq!(f.repo.load(&a.meta.id).unwrap().nodes.len(), 2);
    }
    #[test]
    fn object_operations_preserve_new_captures_and_reject_stale_copy() {
        let mut f = Fixture::new();
        let a = f.repo.open("a", None, false).unwrap();
        let mut n = Node::new("text");
        n.body = "first".into();
        f.repo.append(&a.meta.id, vec![n.clone()]).unwrap();
        let revision = f.repo.load(&a.meta.id).unwrap().meta.revision;
        f.repo.append(&a.meta.id, vec![Node::new("text")]).unwrap();
        n.body = "edited".into();
        let result = f
            .repo
            .edit(
                &a.meta.id,
                vec![Operation::Upsert {
                    nodes: vec![n.clone()],
                }],
            )
            .unwrap();
        assert_eq!(result.nodes.len(), 2);
        assert!(f
            .repo
            .copy(CopyRequest {
                source_task_id: a.meta.id.clone(),
                target_task_id: a.meta.id,
                source_revision: revision,
                ids: vec![n.id],
                x: 0.,
                y: 0.
            })
            .is_err());
    }
    #[test]
    fn expiry_protects_saved_open_and_collecting_tasks() {
        let mut f = Fixture::new();
        let mut ids = Vec::new();
        for owner in ["expired", "saved", "open", "collecting"] {
            let mut task = f.repo.open(owner, None, false).unwrap();
            task.meta.updated_at = Utc::now().timestamp_millis() - 25 * 3_600_000;
            task.meta.saved = owner == "saved";
            f.repo.store(&task).unwrap();
            ids.push(task.meta.id);
            if owner != "open" {
                f.repo.release(owner);
            }
        }
        f.repo.cleanup(Some(&ids[3])).unwrap();
        assert!(f.repo.load(&ids[0]).is_err());
        for id in &ids[1..] {
            assert!(f.repo.load(id).is_ok());
        }
        f.repo.set_retention(0).unwrap();
        f.repo.release("open");
        f.repo.cleanup(None).unwrap();
        assert!(f.repo.load(&ids[2]).is_ok());
    }
    #[test]
    fn immutable_images_are_shared_and_swept_only_when_no_task_references_them() {
        let mut f = Fixture::new();
        let image = image::DynamicImage::new_rgba8(4, 3);
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        let asset = f.repo.store_png(out.get_ref()).unwrap();
        assert_eq!(
            f.repo.store_png(out.get_ref()).unwrap().asset_id,
            asset.asset_id
        );
        let a = f.repo.open("a", None, false).unwrap();
        let mut node = Node::new("image");
        node.asset_id = Some(asset.asset_id.clone());
        f.repo
            .edit(&a.meta.id, vec![Operation::Upsert { nodes: vec![node] }])
            .unwrap();
        f.repo.edit(&a.meta.id, vec![configure(true)]).unwrap();
        f.repo.collect_unused_assets().unwrap();
        assert!(f.repo.asset(&asset.asset_id, false).is_ok());
        f.repo.remove(&a.meta.id).unwrap();
        f.repo.collect_unused_assets().unwrap();
        assert!(f.repo.asset(&asset.asset_id, false).is_err());
    }
    #[test]
    fn unreadable_task_outside_catalog_prevents_asset_sweep() {
        let mut f = Fixture::new();
        let image = image::DynamicImage::new_rgba8(4, 3);
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        let asset = f.repo.store_png(out.get_ref()).unwrap();
        let a = f.repo.open("a", None, false).unwrap();
        fs::write(
            f.repo.path(&a.meta.id).unwrap().join("task.json"),
            b"damaged",
        )
        .unwrap();
        f.repo.catalog.remove(&a.meta.id);
        f.repo.collect_unused_assets().unwrap();
        assert!(f.repo.asset(&asset.asset_id, false).is_ok());
    }
    #[test]
    fn failed_updates_do_not_replace_valid_scene_and_missing_summary_is_recovered() {
        let mut f = Fixture::new();
        let a = f.repo.open("a", None, false).unwrap();
        let mut node = Node::new("text");
        node.x = f64::NAN;
        assert!(f
            .repo
            .edit(&a.meta.id, vec![Operation::Upsert { nodes: vec![node] }])
            .is_err());
        assert_eq!(f.repo.load(&a.meta.id).unwrap().meta.revision, 0);
        fs::remove_file(f.repo.path(&a.meta.id).unwrap().join("meta.json")).unwrap();
        let mut reopened = Repository::default();
        reopened.initialize(f.path.clone()).unwrap();
        assert_eq!(reopened.list().len(), 1);
        assert!(safe_id("../escape").is_err());
    }
}
