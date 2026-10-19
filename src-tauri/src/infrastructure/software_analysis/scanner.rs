use super::{paths, SpaceItem, SpaceProgress, SpaceReport};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::{self, DirEntry, ReadDir};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const TOP_ITEMS: usize = 20;
const MAX_WARNINGS: usize = 16;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy)]
pub(super) struct Budget {
    pub(super) max_entries: u64,
    pub(super) max_duration: Duration,
    pub(super) max_depth: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            max_entries: 1_000_000,
            max_duration: Duration::from_secs(120),
            max_depth: 128,
        }
    }
}

#[derive(Default)]
struct TopItems(BinaryHeap<Reverse<(u64, String)>>);
impl TopItems {
    fn offer(&mut self, path: &Path, bytes: u64) {
        if self.0.len() == TOP_ITEMS && self.0.peek().is_some_and(|item| bytes <= item.0 .0) {
            return;
        }
        self.0.push(Reverse((bytes, paths::display(path))));
        if self.0.len() > TOP_ITEMS {
            self.0.pop();
        }
    }
    fn finish(self) -> Vec<SpaceItem> {
        let mut items: Vec<_> = self
            .0
            .into_iter()
            .map(|Reverse((bytes, path))| SpaceItem { path, bytes })
            .collect();
        items.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
        items
    }
}

pub(super) fn cancelled_report(
    request_id: String,
    software_id: Option<String>,
    root: String,
) -> SpaceReport {
    SpaceReport {
        request_id,
        software_id,
        root,
        total_bytes: 0,
        files: 0,
        directories: 0,
        skipped: 0,
        complete: false,
        cancelled: true,
        elapsed_ms: 0,
        largest_directories: Vec::new(),
        largest_files: Vec::new(),
        warnings: vec!["扫描已取消；结果不完整".into()],
    }
}

struct Work<'a, F: FnMut(SpaceProgress)> {
    report: SpaceReport,
    largest_files: TopItems,
    largest_directories: TopItems,
    cancelled: &'a AtomicBool,
    budget: Budget,
    entries: u64,
    links: u64,
    started: Instant,
    last_progress: Instant,
    emit: F,
}

impl<F: FnMut(SpaceProgress)> Work<'_, F> {
    fn warn(&mut self, message: String) {
        if self.report.warnings.len() < MAX_WARNINGS {
            self.report.warnings.push(message);
        }
    }

    fn io_error(&mut self, message: String) {
        self.report.complete = false;
        self.report.skipped += 1;
        self.warn(message);
    }

    fn keep_going(&mut self) -> bool {
        if self.cancelled.load(Ordering::Acquire) {
            self.report.cancelled = true;
            self.report.complete = false;
            self.warn("扫描已取消；结果不完整".into());
            return false;
        }
        if self.entries >= self.budget.max_entries
            || self.started.elapsed() >= self.budget.max_duration
        {
            self.report.complete = false;
            self.warn("已达到扫描的时间或条目预算；当前结果不完整，可缩小目录后重试".into());
            return false;
        }
        if self.last_progress.elapsed() >= PROGRESS_INTERVAL {
            self.last_progress = Instant::now();
            (self.emit)(SpaceProgress {
                request_id: self.report.request_id.clone(),
                files: self.report.files,
                directories: self.report.directories,
                total_bytes: self.report.total_bytes,
                skipped: self.report.skipped,
                elapsed_ms: self.started.elapsed().as_millis() as u64,
            });
        }
        true
    }

    fn inspect(&mut self, entry: std::io::Result<DirEntry>) -> Option<PathBuf> {
        self.entries += 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                self.io_error(format!("无法读取部分目录项：{error}"));
                return None;
            }
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                self.io_error(format!("无法读取 {}：{error}", paths::display(&path)));
                return None;
            }
        };
        if paths::is_reparse(&metadata) {
            self.report.skipped += 1;
            self.links += 1;
        } else if metadata.is_dir() {
            self.report.directories += 1;
            return Some(path);
        } else if metadata.is_file() {
            self.report.files += 1;
            if let Some(total) = self.report.total_bytes.checked_add(metadata.len()) {
                self.report.total_bytes = total;
            } else {
                self.report.complete = false;
                self.report.total_bytes = u64::MAX;
                self.warn("文件总大小超出统计范围，结果已截断".into());
            }
            self.largest_files.offer(&path, metadata.len());
        } else {
            self.report.skipped += 1;
        }
        None
    }

    fn open_directory(&mut self, path: &Path) -> Option<ReadDir> {
        // Recheck immediately before opening; directory entries may change mid-scan.
        match fs::symlink_metadata(path) {
            Ok(metadata) if paths::is_reparse(&metadata) => {
                self.report.skipped += 1;
                self.links += 1;
                return None;
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                self.io_error(format!("目录已变化：{}", paths::display(path)));
                return None;
            }
            Err(error) => {
                self.io_error(format!("无法访问 {}：{error}", paths::display(path)));
                return None;
            }
        }
        match fs::read_dir(path) {
            Ok(reader) => Some(reader),
            Err(error) => {
                self.io_error(format!("无法遍历 {}：{error}", paths::display(path)));
                None
            }
        }
    }

    fn walk_child(&mut self, path: &Path) {
        let Some(reader) = self.open_directory(path) else {
            return;
        };
        // At most max_depth directory iterators are alive. Sibling paths and the
        // full file list are never collected; a wide directory uses constant memory.
        let mut stack = vec![reader];
        while !stack.is_empty() {
            if !self.keep_going() {
                break;
            }
            match stack.last_mut().and_then(Iterator::next) {
                None => {
                    stack.pop();
                }
                Some(entry) => {
                    if let Some(child) = self.inspect(entry) {
                        if stack.len() >= self.budget.max_depth {
                            self.io_error(format!(
                                "目录层级超过预算，已跳过：{}",
                                paths::display(&child)
                            ));
                        } else if let Some(reader) = self.open_directory(&child) {
                            stack.push(reader);
                        }
                    }
                }
            }
        }
    }
}

pub(super) fn scan(
    root: PathBuf,
    request_id: String,
    software_id: Option<String>,
    cancelled: &AtomicBool,
    budget: Budget,
    emit: impl FnMut(SpaceProgress),
) -> Result<SpaceReport, String> {
    if cancelled.load(Ordering::Acquire) {
        return Ok(cancelled_report(
            request_id,
            software_id,
            paths::display(&root),
        ));
    }
    // A completely unreadable root is an error, not a successful empty report.
    let mut reader = fs::read_dir(&root)
        .map_err(|error| format!("无法遍历软件目录 {}：{error}", paths::display(&root)))?;
    let started = Instant::now();
    let mut work = Work {
        report: SpaceReport {
            request_id,
            software_id,
            root: paths::display(&root),
            total_bytes: 0,
            files: 0,
            directories: 0,
            skipped: 0,
            complete: true,
            cancelled: false,
            elapsed_ms: 0,
            largest_directories: Vec::new(),
            largest_files: Vec::new(),
            warnings: vec!["统计文件的逻辑大小，硬链接可能重复计数；不代表磁盘物理占用".into()],
        },
        largest_files: TopItems::default(),
        largest_directories: TopItems::default(),
        cancelled,
        budget,
        entries: 0,
        links: 0,
        started,
        last_progress: started,
        emit,
    };
    while work.keep_going() {
        let Some(entry) = reader.next() else {
            break;
        };
        if let Some(child) = work.inspect(entry) {
            let before = work.report.total_bytes;
            work.walk_child(&child);
            work.largest_directories
                .offer(&child, work.report.total_bytes.saturating_sub(before));
            if work.report.cancelled
                || work.entries >= budget.max_entries
                || work.started.elapsed() >= budget.max_duration
            {
                // walk_child already recorded the cancellation/budget reason.
                break;
            }
        }
    }
    if work.links > 0 {
        work.warn(format!(
            "已跳过 {} 个符号链接、目录联接或其他重解析点",
            work.links
        ));
    }
    work.report.elapsed_ms = work.started.elapsed().as_millis() as u64;
    work.report.largest_directories = work.largest_directories.finish();
    work.report.largest_files = work.largest_files.finish();
    Ok(work.report)
}
