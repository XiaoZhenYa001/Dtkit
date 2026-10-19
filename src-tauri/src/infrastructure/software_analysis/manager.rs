use super::SoftwareSnapshot;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(300);

struct Cached {
    stored_at: Instant,
    snapshot: SoftwareSnapshot,
}

struct ActiveScan {
    window: String,
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub(crate) struct SoftwareAnalysisManager {
    cache: Mutex<Option<Cached>>,
    cache_generation: AtomicU64,
    listing: Arc<AtomicBool>,
    active: Arc<Mutex<Option<ActiveScan>>>,
}

// Owned guards survive the async command's future and clear reservations even on panic.
pub(super) struct ListLease(Arc<AtomicBool>);
impl Drop for ListLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(super) struct ScanLease(Arc<Mutex<Option<ActiveScan>>>);
impl Drop for ScanLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.lock() {
            *active = None;
        }
    }
}

impl SoftwareAnalysisManager {
    pub(super) fn cached(&self) -> Result<Option<SoftwareSnapshot>, String> {
        let mut cache = self.cache.lock().map_err(|_| "软件列表缓存不可用")?;
        if cache
            .as_ref()
            .is_some_and(|item| item.stored_at.elapsed() >= CACHE_TTL)
        {
            *cache = None;
        }
        Ok(cache.as_ref().map(|cached| {
            let mut snapshot = cached.snapshot.clone();
            snapshot.cached = true;
            snapshot
        }))
    }

    pub(super) fn cache_generation(&self) -> u64 {
        self.cache_generation.load(Ordering::Acquire)
    }

    pub(super) fn store_cache(
        &self,
        snapshot: SoftwareSnapshot,
        generation: u64,
    ) -> Result<(), String> {
        let mut cache = self.cache.lock().map_err(|_| "软件列表缓存不可用")?;
        // An in-flight enumeration must not refill a cache released during sleep/disable.
        if generation == self.cache_generation() {
            *cache = Some(Cached {
                stored_at: Instant::now(),
                snapshot,
            });
        }
        Ok(())
    }

    pub(crate) fn release_idle_cache(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            self.cache_generation.fetch_add(1, Ordering::AcqRel);
            *cache = None;
        }
    }

    pub(super) fn reserve_list(&self) -> Result<ListLease, String> {
        self.listing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "软件列表正在读取，请稍候")?;
        Ok(ListLease(self.listing.clone()))
    }

    pub(super) fn resolve_path(&self, id: &str) -> Result<String, String> {
        let mut cache = self.cache.lock().map_err(|_| "软件列表缓存不可用")?;
        if cache
            .as_ref()
            .is_some_and(|item| item.stored_at.elapsed() >= CACHE_TTL)
        {
            *cache = None;
        }
        let software = cache
            .as_ref()
            .and_then(|cache| cache.snapshot.items.iter().find(|item| item.id == id))
            .ok_or("软件列表已过期，请刷新后重试")?;
        if !software.can_analyze {
            return Err(software
                .reason
                .clone()
                .unwrap_or_else(|| "此软件没有可扫描的目录".into()));
        }
        software
            .install_location
            .clone()
            .ok_or_else(|| "未登记软件安装目录".into())
    }

    pub(super) fn reserve_scan(
        &self,
        window: &str,
        request_id: &str,
    ) -> Result<(ScanLease, Arc<AtomicBool>), String> {
        let mut active = self.active.lock().map_err(|_| "软件扫描状态不可用")?;
        if active.is_some() {
            return Err("已有软件空间扫描正在进行，请先取消或等待完成".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveScan {
            window: window.into(),
            request_id: request_id.into(),
            cancelled: cancelled.clone(),
        });
        Ok((ScanLease(self.active.clone()), cancelled))
    }

    pub(super) fn cancel_request(&self, window: &str, request_id: &str) -> Result<bool, String> {
        let active = self.active.lock().map_err(|_| "软件扫描状态不可用")?;
        let owned = active
            .as_ref()
            .filter(|scan| scan.window == window && scan.request_id == request_id);
        if let Some(scan) = owned {
            scan.cancelled.store(true, Ordering::Release);
        }
        // Cancellation does not release the slot until its worker has actually stopped.
        Ok(owned.is_some())
    }

    pub(crate) fn cancel_window(&self, label: &str) {
        if let Ok(active) = self.active.lock() {
            if let Some(scan) = active.as_ref().filter(|scan| scan.window == label) {
                scan.cancelled.store(true, Ordering::Release);
            }
        }
    }

    pub(crate) fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            if let Some(scan) = active.as_ref() {
                scan.cancelled.store(true, Ordering::Release);
            }
        }
    }
}
