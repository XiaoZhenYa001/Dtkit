import { escapeAttribute, escapeHtml, renderFileList } from './file-view.js';

function renderBreadcrumb(stack) {
    const segments = ['<button class="folder-browser__crumb" type="button" data-folder-depth="-1">桌面</button>'];
    stack.forEach((folder, index) => {
        segments.push('<i class="ri-arrow-right-s-line" aria-hidden="true"></i>');
        segments.push(`<button class="folder-browser__crumb${index === stack.length - 1 ? ' is-current' : ''}" type="button" data-folder-depth="${index}" title="${escapeAttribute(folder.path)}">${escapeHtml(folder.name)}</button>`);
    });
    return segments.join('');
}

export function renderFolderBrowserMarkup(folderView, contents = null, { syncing = false, error = null } = {}) {
    const currentFolder = folderView.stack.at(-1);
    if (!currentFolder) return null;
    const items = contents?.items || [];
    const count = contents?.total_count ?? items.length;
    const body = contents
        ? (items.length ? renderFileList(items) : '<div class="folder-browser__empty"><span><i class="ri-folder-open-line"></i></span><strong>这个文件夹是空的</strong><small>新增内容后点击右上角刷新即可。</small></div>')
        : (error
            ? `<div class="folder-browser__empty folder-browser__empty--error"><span><i class="ri-error-warning-line"></i></span><strong>暂时无法读取</strong><small>${escapeHtml(String(error))}</small></div>`
            : '<div class="folder-browser__loading" aria-label="正在读取文件夹"><i class="ri-loader-4-line"></i><span>正在读取文件夹…</span></div>');
    return {
        count,
        currentFolder,
        markup: `<section class="folder-browser" aria-label="文件夹浏览"><header class="folder-browser__toolbar"><button class="folder-browser__back" type="button" data-folder-back aria-label="返回上一层" title="返回上一层"><i class="ri-arrow-left-line"></i></button><div class="folder-browser__identity"><span>正在浏览</span><nav class="folder-browser__breadcrumb" aria-label="当前位置">${renderBreadcrumb(folderView.stack)}</nav></div><div class="folder-browser__actions"><button type="button" data-folder-refresh aria-label="刷新当前文件夹" title="刷新当前文件夹"><i class="ri-refresh-line${syncing ? ' is-spinning' : ''}"></i></button><button type="button" data-folder-external aria-label="在资源管理器中打开" title="在资源管理器中打开"><i class="ri-folder-open-line"></i></button></div></header><div class="folder-browser__summary"><span><i class="ri-folder-2-line"></i>${escapeHtml(currentFolder.name)}</span><span class="folder-browser__sync-state">${syncing ? '正在同步…' : (error && contents ? '同步失败，显示缓存' : `${count} 个项目`)}</span></div><div class="folder-browser__list">${body}</div>${contents?.truncated ? `<footer class="folder-browser__limit"><i class="ri-information-line"></i>内容较多，仅显示前 ${items.length} 项，共 ${count} 项</footer>` : ''}</section>`
    };
}
