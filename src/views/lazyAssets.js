const assetLoaders = {
    settings: () => Promise.all([
        import('../css/settings.css'),
        import('./settings.js')
    ]).then(([, settingsModule]) => settingsModule),
    downloads: () => Promise.all([
        import('../css/downloads.css'),
        import('./downloads.js')
    ]).then(([, downloadsModule]) => downloadsModule)
};

const assetLoadPromises = new Map();

/**
 * Load view-specific code and styles once. A rejected load is evicted so a
 * transient disk/network error can be retried on the next navigation.
 *
 * @param {'settings' | 'downloads'} viewId
 * @returns {Promise<unknown>}
 */
export function loadViewAssets(viewId) {
    const loader = assetLoaders[viewId];
    if (!loader) return Promise.resolve(null);

    const existing = assetLoadPromises.get(viewId);
    if (existing) return existing;

    const promise = loader().catch(error => {
        assetLoadPromises.delete(viewId);
        throw error;
    });
    assetLoadPromises.set(viewId, promise);
    return promise;
}
