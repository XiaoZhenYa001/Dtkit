export function formatFileSize(bytes) {
    if (bytes === 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let index = 0;
    let size = bytes;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index++;
    }
    return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function getFileIcon(file) {
    if (file.icon) return `<img src="${file.icon}" class="file-icon-img" alt="" loading="lazy">`;
    if (file.is_folder) return '<i class="ri-folder-2-line"></i>';
    const iconMap = {
        document: '<i class="ri-file-text-line"></i>',
        image: '<i class="ri-image-line"></i>',
        video: '<i class="ri-video-line"></i>',
        audio: '<i class="ri-music-2-line"></i>',
        archive: '<i class="ri-archive-line"></i>',
        program: '<i class="ri-apps-2-line"></i>',
        other: '<i class="ri-attachment-2"></i>'
    };
    return iconMap[file.category] || iconMap.document;
}

export function escapeHtml(text) {
    return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function escapeAttribute(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

export function highlightText(text, query) {
    if (!query) return escapeHtml(text);
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escapeHtml(text).replace(regex, '<span class="search-highlight">$1</span>');
}

export function renderFileList(files) {
    return files.map(file => {
        const trailingContent = file.is_folder
            ? '<span class="folder-drill">浏览 <i class="ri-arrow-right-s-line"></i></span>'
            : `<span class="file-size">${formatFileSize(file.size)}</span>`;
        return `
        <button type="button" class="file-item${file.is_folder ? ' file-item--folder' : ''}" data-path="${escapeAttribute(file.path)}" data-name="${escapeAttribute(file.name)}" data-is-folder="${file.is_folder ? 'true' : 'false'}"${file.app_id ? ` data-app-id="${escapeAttribute(file.app_id)}"` : ''}>
            <span class="file-icon${file.icon ? ' file-icon-real' : ''}">${getFileIcon(file)}</span>
            <span class="file-name">${escapeHtml(file.name)}</span>
            ${trailingContent}
        </button>`;
    }).join('');
}

export function renderSearchResultsMarkup(files, query) {
    if (!files.length) {
        return '<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-text">未找到匹配的文件</div></div>';
    }
    const highlightQuery = query.replace(/^\/[a-z]\s*/i, '');
    return files.map(file => `
        <button type="button" class="file-item${file.is_folder ? ' file-item--folder' : ''}" data-path="${escapeAttribute(file.path)}" data-name="${escapeAttribute(file.name)}" data-is-folder="${file.is_folder ? 'true' : 'false'}"${file.app_id ? ` data-app-id="${escapeAttribute(file.app_id)}"` : ''}>
            <span class="file-icon">${getFileIcon(file)}</span>
            <span class="file-name">${highlightText(file.name, highlightQuery)}</span>
            <span class="file-size">${file.is_folder ? '→' : formatFileSize(file.size)}</span>
        </button>`).join('');
}
