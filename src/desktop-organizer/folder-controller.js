import { renderFolderBrowserMarkup } from './views/folder-view.js';

const DEFAULT_CACHE_LIMIT = 8;

export function createFolderController({
    state,
    categoryList,
    invoke,
    setStatus,
    renderCategories,
    hydrateIcons,
    loadDesktopFiles,
    cacheLimit = DEFAULT_CACHE_LIMIT
}) {
    const cache = new Map();
    let requestGeneration = 0;

    function readCached(path) {
        const cached = cache.get(path);
        if (!cached) return null;
        cache.delete(path);
        cache.set(path, cached);
        return cached;
    }

    function writeCached(path, contents) {
        cache.delete(path);
        cache.set(path, contents);
        while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    }

    function render(contents = null, { syncing = false, error = null } = {}) {
        const rendered = renderFolderBrowserMarkup(state.folderView, contents, { syncing, error });
        if (!rendered) return;
        const { currentFolder, count, markup } = rendered;

        categoryList.classList.add('category-list--folder-view');
        categoryList.innerHTML = markup;
        if (contents) queueMicrotask(() => hydrateIcons(categoryList));

        if (syncing) setStatus(`正在同步 · ${currentFolder.name}`);
        else if (error && contents) setStatus(`显示缓存 · ${currentFolder.name} · 同步失败`);
        else if (error) setStatus(`读取失败 · ${currentFolder.name}`);
        else setStatus(`${currentFolder.name} · ${count} 个项目`);
    }

    async function enter(folder, { push = true } = {}) {
        if (!folder?.path) return;
        if (!state.folderView.active) state.folderView.categoryScrollTop = categoryList.scrollTop;
        if (push) state.folderView.stack.push({ path: folder.path, name: folder.name || '文件夹' });
        state.folderView.active = true;
        state.selectedFile = null;

        const generation = ++requestGeneration;
        const cached = readCached(folder.path);
        render(cached, { syncing: true });

        try {
            const contents = await invoke('desktop_list_folder', { path: folder.path });
            if (generation !== requestGeneration || state.folderView.stack.at(-1)?.path !== folder.path) return;
            writeCached(folder.path, contents);
            render(contents);
        } catch (error) {
            if (generation !== requestGeneration || state.folderView.stack.at(-1)?.path !== folder.path) return;
            console.error('读取文件夹失败:', error);
            render(cached, { error });
        }
    }

    function leave() {
        requestGeneration++;
        state.folderView.active = false;
        state.folderView.stack = [];
        state.selectedFile = null;
        const scrollTop = state.folderView.categoryScrollTop;
        renderCategories();
        requestAnimationFrame(() => { categoryList.scrollTop = scrollTop; });
    }

    function back() {
        if (!state.folderView.active) return;
        if (state.folderView.stack.length <= 1) return leave();
        state.folderView.stack.pop();
        return enter(state.folderView.stack.at(-1), { push: false });
    }

    function navigateToDepth(depth) {
        if (depth < 0) return leave();
        if (depth >= state.folderView.stack.length) return;
        state.folderView.stack = state.folderView.stack.slice(0, depth + 1);
        return enter(state.folderView.stack.at(-1), { push: false });
    }

    function refresh() {
        if (state.folderView.active) {
            const currentFolder = state.folderView.stack.at(-1);
            if (currentFolder) return enter(currentFolder, { push: false });
        }
        return loadDesktopFiles();
    }

    return { enter, leave, back, navigateToDepth, refresh };
}
