import { noteStats } from '../../sticky-note/editor-model.js';

export const COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink', 'purple', 'gray']);
export const COLOR_LABELS = Object.freeze({ yellow: '暖黄', green: '浅绿', blue: '雾蓝', pink: '樱粉', purple: '淡紫', gray: '岩灰' });
export const LIMITS = Object.freeze({ notes: 200, title: 80, content: 20000, importBytes: 16 * 1024 * 1024 });
export const TEMPLATES = Object.freeze({
    blank: { title: '', content: '', color: 'yellow' },
    todo: { title: '今日待办', content: '- [ ] 第一件重要的事\n- [ ] \n- [ ] ', color: 'green' },
    meeting: { title: '会议记录', content: '## 讨论要点\n\n\n## 待办与负责人\n- [ ] \n\n## 下一步\n', color: 'blue' },
    idea: { title: '灵感速记', content: '## 一个想法\n\n\n## 为什么值得做\n\n\n## 下一小步\n- [ ] ', color: 'purple' }
});

export function extractTags(text) {
    const tags = new Map();
    for (const match of String(text || '').matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{1,30})(?=$|\s|[，。！？,.;:!?])/gu)) {
        const tag = match[1];
        if (!tags.has(tag.toLocaleLowerCase())) tags.set(tag.toLocaleLowerCase(), tag);
    }
    return [...tags.values()].slice(0, 30);
}

export function taskProgress(text) {
    const stats = noteStats(text);
    return { total: stats.tasks, done: stats.completed };
}

export function normalizeNote(note) {
    if (!note || typeof note.id !== 'string' || typeof note.title !== 'string' || typeof note.content !== 'string') return null;
    const createdAt = Number.isFinite(note.createdAt) && note.createdAt >= 0 && note.createdAt <= 8.64e15 ? note.createdAt : 0;
    const updatedAt = Number.isFinite(note.updatedAt) && note.updatedAt >= createdAt && note.updatedAt <= 8.64e15 ? note.updatedAt : createdAt;
    return { ...note, color: COLORS.includes(note.color) ? note.color : 'yellow', createdAt, updatedAt,
        trashedAt: Number.isFinite(note.trashedAt) && note.trashedAt > 0 && note.trashedAt <= 8.64e15 ? note.trashedAt : null,
        opened: Boolean(note.opened), pinned: Boolean(note.pinned),
        tags: extractTags(note.title + '\n' + note.content), progress: taskProgress(note.content),
        searchText: (note.title + '\n' + note.content).toLocaleLowerCase() };
}

export function filterNotes(notes, { filter = 'all', color = 'all', tag = '', query = '', sort = 'updated' } = {}) {
    const tokens = [...query.trim().toLocaleLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map(match => match[1] || match[2]);
    const selected = notes.filter(note => {
        if (Boolean(note.trashedAt) !== (filter === 'trash')) return false;
        if (filter === 'pinned' && !note.pinned || filter === 'opened' && !note.opened) return false;
        if (color !== 'all' && note.color !== color) return false;
        if (tag && !note.tags.some(item => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) return false;
        return tokens.every(token => note.searchText.includes(token));
    });
    return selected.sort((a, b) => {
        if (filter !== 'trash' && a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
        if (sort === 'title') return (a.title.trim() || '未命名便签').localeCompare(b.title.trim() || '未命名便签', 'zh-CN') || b.updatedAt - a.updatedAt;
        return sort === 'created' ? b.createdAt - a.createdAt : (b.trashedAt || b.updatedAt) - (a.trashedAt || a.updatedAt);
    });
}

export function validateSeed(value) {
    if (!value || typeof value.title !== 'string' || value.title.length > LIMITS.title
        || typeof value.content !== 'string' || value.content.length > LIMITS.content
        || /\0/.test(value.title + value.content)) throw new Error('标题最多 80 字、正文最多 20000 字，且不能含空字符。');
    if (!COLORS.includes(value.color) || typeof value.pinned !== 'boolean') throw new Error('便签颜色或置顶设置无效。');
    return { title: value.title, content: value.content, color: value.color, pinned: value.pinned };
}

export function makeBackup(notes, now = new Date()) {
    return JSON.stringify({ format: 'dtkit-sticky-notes', version: 1, exportedAt: now.toISOString(), notes: notes.map(note => ({
        ...validateSeed(note), createdAt: note.createdAt, updatedAt: note.updatedAt, trashedAt: note.trashedAt || null
    })) }, null, 2);
}

export function parseImport(text, { filename = '导入便签.txt', currentCount = 0 } = {}) {
    if (new TextEncoder().encode(text).length > LIMITS.importBytes) throw new Error('文件超过 16 MB，请拆分后导入。');
    let values;
    if (/\.json$/i.test(filename)) {
        let backup;
        try { backup = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON 文件无法解析，请选择有效的便签备份。'); }
        if (Array.isArray(backup)) values = backup;
        else if (backup && backup.version === 1 && (!backup.format || backup.format === 'dtkit-sticky-notes') && Array.isArray(backup.notes)) values = backup.notes;
        else throw new Error('不支持此备份格式，请选择 DtKit 便签 JSON 备份。');
    } else if (/\.(md|txt)$/i.test(filename)) {
        values = [{ title: filename.replace(/\.(md|txt)$/i, '').slice(0, LIMITS.title), content: text.replace(/^\uFEFF/, ''), color: 'yellow', pinned: false }];
    } else throw new Error('支持导入 .json 备份、.md 或 .txt 文本。');
    if (!values.length) throw new Error('文件中没有便签。');
    if (values.length > LIMITS.notes || currentCount + values.length > LIMITS.notes) throw new Error(`最多保存 200 张便签，当前剩余 ${Math.max(0, LIMITS.notes - currentCount)} 个位置。`);
    return values.map((value, index) => {
        try {
            const seed = validateSeed(value);
            if (value.trashedAt != null && (!Number.isFinite(value.trashedAt) || value.trashedAt < 0)) throw new Error('回收站时间无效。');
            return { ...seed, trashedAt: value.trashedAt == null ? null : value.trashedAt };
        } catch (error) { throw new Error(`第 ${index + 1} 张便签：${error.message}`); }
    });
}

export function noteMarkdown(note) {
    return `${note.title.trim() ? '# ' + note.title.trim() + '\n\n' : ''}${note.content}\n`;
}

export function safeFilename(title, extension = 'md') {
    return (String(title || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/[. ]+$/g, '').slice(0, 64) || '未命名便签') + '.' + extension;
}
