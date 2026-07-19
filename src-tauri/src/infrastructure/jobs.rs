#![allow(dead_code)] // Shared API for the upcoming batch and transfer tools.

use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum JobStatus {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Cancelling)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobRecord {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) status: JobStatus,
    pub(crate) progress: f32,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) error: Option<String>,
}

struct ManagedJob {
    record: JobRecord,
    cancel_requested: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(crate) struct JobTicket {
    id: String,
    cancel_requested: Arc<AtomicBool>,
}

impl JobTicket {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel_requested.load(Ordering::Relaxed)
    }
}

#[derive(Default)]
pub(crate) struct JobManager(RwLock<HashMap<String, ManagedJob>>);

impl JobManager {
    pub(crate) fn begin(&self, kind: &str, label: &str) -> Result<JobTicket, String> {
        self.begin_limited(kind, label, usize::MAX)
    }

    pub(crate) fn begin_limited(
        &self,
        kind: &str,
        label: &str,
        active_limit: usize,
    ) -> Result<JobTicket, String> {
        if !is_safe_identifier(kind) || label.trim().is_empty() {
            return Err("任务类型或名称无效".to_string());
        }
        if active_limit == 0 {
            return Err("后台任务并发上限无效".to_string());
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let record = JobRecord {
            id: id.clone(),
            kind: kind.to_string(),
            label: label.trim().to_string(),
            status: JobStatus::Queued,
            progress: 0.0,
            created_at: now,
            updated_at: now,
            error: None,
        };
        let mut jobs = self
            .0
            .write()
            .map_err(|_| "任务管理器状态不可用".to_string())?;
        if jobs
            .values()
            .filter(|job| job.record.status.is_active())
            .count()
            >= active_limit
        {
            return Err(format!("后台任务已达到并发上限（{active_limit}）"));
        }
        if jobs.len() >= 100 {
            let mut finished = jobs
                .iter()
                .filter(|(_, job)| !job.record.status.is_active())
                .map(|(id, job)| (id.clone(), job.record.updated_at))
                .collect::<Vec<_>>();
            finished.sort_by_key(|(_, updated_at)| *updated_at);
            let remove_count = jobs.len().saturating_sub(79).min(finished.len());
            for (finished_id, _) in finished.into_iter().take(remove_count) {
                jobs.remove(&finished_id);
            }
        }
        jobs.insert(
            id.clone(),
            ManagedJob {
                record,
                cancel_requested: Arc::clone(&cancel_requested),
            },
        );
        Ok(JobTicket {
            id,
            cancel_requested,
        })
    }

    pub(crate) fn mark_running(&self, id: &str) -> Result<(), String> {
        self.update(id, |record| {
            record.status = JobStatus::Running;
            record.error = None;
        })
    }

    pub(crate) fn set_progress(&self, id: &str, progress: f32) -> Result<(), String> {
        self.update(id, |record| {
            record.progress = progress.clamp(0.0, 1.0);
        })
    }

    pub(crate) fn complete(&self, id: &str) -> Result<(), String> {
        self.update(id, |record| {
            record.status = JobStatus::Completed;
            record.progress = 1.0;
        })
    }

    pub(crate) fn fail(&self, id: &str, error: impl Into<String>) -> Result<(), String> {
        let error = error.into();
        self.update(id, move |record| {
            record.status = JobStatus::Failed;
            record.error = Some(error);
        })
    }

    pub(crate) fn mark_cancelled(&self, id: &str) -> Result<(), String> {
        self.update(id, |record| {
            record.status = JobStatus::Cancelled;
        })
    }

    pub(crate) fn request_cancel(&self, id: &str) -> Result<bool, String> {
        let mut jobs = self
            .0
            .write()
            .map_err(|_| "任务管理器状态不可用".to_string())?;
        let Some(job) = jobs.get_mut(id) else {
            return Ok(false);
        };
        if !job.record.status.is_active() {
            return Ok(false);
        }
        job.cancel_requested.store(true, Ordering::Relaxed);
        job.record.status = JobStatus::Cancelling;
        job.record.updated_at = Utc::now().timestamp_millis();
        Ok(true)
    }

    pub(crate) fn snapshot(&self) -> Result<Vec<JobRecord>, String> {
        let mut records = self
            .0
            .read()
            .map_err(|_| "任务管理器状态不可用".to_string())?
            .values()
            .map(|job| job.record.clone())
            .collect::<Vec<_>>();
        records.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(records)
    }

    pub(crate) fn active_count(&self) -> usize {
        self.0
            .read()
            .map(|jobs| {
                jobs.values()
                    .filter(|job| job.record.status.is_active())
                    .count()
            })
            .unwrap_or(0)
    }

    fn update(&self, id: &str, mutate: impl FnOnce(&mut JobRecord)) -> Result<(), String> {
        let mut jobs = self
            .0
            .write()
            .map_err(|_| "任务管理器状态不可用".to_string())?;
        let job = jobs
            .get_mut(id)
            .ok_or_else(|| format!("任务不存在: {id}"))?;
        mutate(&mut job.record);
        job.record.updated_at = Utc::now().timestamp_millis();
        Ok(())
    }
}

fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

#[tauri::command]
pub(crate) fn get_jobs(manager: tauri::State<'_, JobManager>) -> Result<Vec<JobRecord>, String> {
    manager.snapshot()
}

#[tauri::command]
pub(crate) fn cancel_job(
    manager: tauri::State<'_, JobManager>,
    job_id: String,
) -> Result<bool, String> {
    manager.request_cancel(&job_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jobs_expose_progress_and_finish_without_background_polling() {
        let manager = JobManager::default();
        let ticket = manager.begin("file-hash", "计算文件哈希").unwrap();
        manager.mark_running(ticket.id()).unwrap();
        manager.set_progress(ticket.id(), 0.42).unwrap();
        assert_eq!(manager.active_count(), 1);

        let snapshot = manager.snapshot().unwrap();
        assert_eq!(snapshot[0].status, JobStatus::Running);
        assert_eq!(snapshot[0].progress, 0.42);

        manager.complete(ticket.id()).unwrap();
        assert_eq!(manager.active_count(), 0);
        assert_eq!(manager.snapshot().unwrap()[0].progress, 1.0);
    }

    #[test]
    fn cancellation_is_cooperative_and_does_not_kill_threads() {
        let manager = JobManager::default();
        let ticket = manager.begin("batch-rename", "批量重命名").unwrap();
        assert!(!ticket.is_cancelled());
        assert!(manager.request_cancel(ticket.id()).unwrap());
        assert!(ticket.is_cancelled());
        assert_eq!(manager.snapshot().unwrap()[0].status, JobStatus::Cancelling);
        manager.mark_cancelled(ticket.id()).unwrap();
        assert_eq!(manager.active_count(), 0);
    }

    #[test]
    fn finished_history_is_pruned_before_it_can_grow_without_bound() {
        let manager = JobManager::default();
        for index in 0..110 {
            let ticket = manager
                .begin("file-batch", &format!("批处理 {index}"))
                .unwrap();
            manager.complete(ticket.id()).unwrap();
        }
        assert!(manager.snapshot().unwrap().len() <= 100);
    }

    #[test]
    fn active_job_limit_is_checked_atomically() {
        let manager = JobManager::default();
        manager.begin_limited("file-batch", "任务一", 1).unwrap();
        assert!(manager.begin_limited("file-batch", "任务二", 1).is_err());
        assert_eq!(manager.active_count(), 1);
    }
}
