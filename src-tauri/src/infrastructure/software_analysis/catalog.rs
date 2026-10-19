use super::Software;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) const MAX_SOFTWARE: usize = 4096;

#[derive(Default)]
pub(super) struct Catalog {
    items: BTreeMap<String, Software>,
    pub(super) truncated: bool,
}

fn identity(item: &Software) -> String {
    let path = item
        .install_location
        .as_deref()
        .unwrap_or("")
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    // Registry view and registration key are intentionally absent: 32/64 bit
    // mirrors identify the same installation. Versions with distinct roots remain distinct.
    serde_json::to_string(&[
        item.scope.to_lowercase(),
        item.name.trim().to_lowercase(),
        item.publisher
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_lowercase(),
        path.clone(),
        if path.is_empty() {
            item.version.as_deref().unwrap_or("").to_lowercase()
        } else {
            String::new()
        },
    ])
    .unwrap_or_default()
}

fn rank(item: &Software) -> (usize, bool, String) {
    (
        usize::from(item.version.is_some())
            + usize::from(item.estimated_bytes.is_some())
            + usize::from(item.install_date.is_some())
            + usize::from(item.can_analyze),
        item.source.contains("64"),
        serde_json::to_string(item).unwrap_or_default(),
    )
}

impl Catalog {
    pub(super) fn insert(&mut self, mut item: Software) {
        let key = identity(&item);
        item.id = hex::encode(Sha256::digest(key.as_bytes()));
        if let Some(existing) = self.items.get_mut(&key) {
            if rank(&item) > rank(existing) {
                std::mem::swap(existing, &mut item);
            }
            // Keep one coherent registration. Merging fields into the winner would
            // change its rank and make three-way deduplication depend on read order.
        } else if self.items.len() < MAX_SOFTWARE {
            self.items.insert(key, item);
        } else {
            self.truncated = true;
        }
    }

    pub(super) fn finish(self) -> Vec<Software> {
        let mut items: Vec<_> = self.items.into_values().collect();
        items.sort_by_cached_key(|item| (item.name.to_lowercase(), item.id.clone()));
        items
    }
}
