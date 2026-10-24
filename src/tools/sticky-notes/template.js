const paths = {
    note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8l6-6V5a2 2 0 0 0-2-2h-4Z"/><path d="M14 21v-5a1 1 0 0 1 1-1h5M8 8h8M8 12h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pin: '<path d="m16 3 5 5-4 1-4 4-1 4-5-5 4-1 4-4 1-4ZM7 17l-4 4"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1.4"/><rect x="14" y="4" width="6" height="6" rx="1.4"/><rect x="4" y="14" width="6" height="6" rx="1.4"/><rect x="14" y="14" width="6" height="6" rx="1.4"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
    import: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    export: '<path d="M12 15V3m-4 4 4-4 4 4M4 16v4h16v-4"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    arrowUpRight: '<path d="M6 18 18 6M6 6h12v12"/>',
    duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.2.8-1.2 2.3M12 17h.01"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8h18M7 6h.01M10 6h.01"/>',
    restore: '<path d="M3 10h5V5"/><path d="M4 10a8 8 0 1 1 1 8M12 8v5l3 2"/>',
    chevronDown: '<path d="m7 10 5 5 5-5"/>',
    checklist: '<path d="m3 6 1.5 1.5L7 4M10 6h10M10 12h10M10 18h10"/><rect x="3" y="11" width="4" height="4" rx=".7"/><path d="M3 19h4"/>',
    meeting: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 17h2"/>',
    bulb: '<path d="M9 18h6M10 21h4M9 15c0-1.5-3-3-3-6a6 6 0 0 1 12 0c0 3-3 4.5-3 6H9ZM12 1v1M3 4l1 1M20 5l1-1"/>',
    select: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8 12 3 3 5-6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M8 14h3M8 17h5"/>',
    shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    undo: '<path d="M3 10h5V5"/><path d="M4 10a8 8 0 1 1 1 8"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/>',
    folder: '<path d="M3 7V5h7l2 2h7a2 2 0 0 1 2 2v10H3V7Z"/>',
    tag: '<path d="M3 3h8l10 10-8 8L3 11V3Z"/><circle cx="7.5" cy="7.5" r="1"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

export function icon(name, className = '') {
    return `<svg class="notes-icon${className ? ` ${className}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.note}</svg>`;
}

const colorNames = { yellow: '暖黄', green: '薄荷', blue: '雾蓝', pink: '樱粉', purple: '浅紫', gray: '石灰' };

export function template() {
    return `<div class="notes-shell">
        <div class="notes-container">
            <header class="notes-header">
                <div class="notes-heading"><div class="notes-eyebrow">A LITTLE SPACE FOR YOUR MIND</div><h2>我的便签<span class="notes-heading-dot"></span></h2><p>随手记下，让思绪留在眼前。</p></div>
                <div class="notes-header-actions"><button id="notesQuickCreate" class="notes-button notes-button--quiet" type="button" title="直接打开一张空白桌面便签">${icon('window')}<span>桌面速记</span></button><button id="notesCreate" class="notes-button notes-button--primary" type="button">${icon('plus')}<span>新建便签</span><kbd>Ctrl N</kbd></button></div>
            </header>
            <div class="notes-workspace">
                <aside class="notes-sidebar" aria-label="整理便签">
                    <span class="notes-section-label">我的空间</span>
                    <div id="notesFilters" class="notes-filters" role="group" aria-label="便签分类"><span class="notes-filter-indicator" aria-hidden="true"></span>
                        <button id="notesActiveTab" data-filter="all" type="button" aria-pressed="true">${icon('note')}<span>全部便签</span><small id="notesActiveCount">0</small></button>
                        <button id="notesPinnedTab" data-filter="pinned" type="button" aria-pressed="false">${icon('pin')}<span>已置顶</span><small id="notesPinnedCount">0</small></button>
                        <button id="notesOpenedTab" data-filter="opened" type="button" aria-pressed="false">${icon('window')}<span>桌面上</span><small id="notesOpenedCount">0</small></button>
                        <button id="notesTrashTab" data-filter="trash" type="button" aria-pressed="false">${icon('trash')}<span>回收站</span><small id="notesTrashCount">0</small></button>
                    </div>
                    <div class="notes-color-section"><span class="notes-section-label">按颜色整理</span><div id="notesColorFilter" class="notes-color-filter" role="group" aria-label="按便签颜色筛选"><button data-filter-color="all" class="notes-color-all" type="button" aria-label="全部颜色" title="全部颜色" aria-pressed="true">${icon('grid')}</button>${Object.entries(colorNames).map(([color, label]) => `<button type="button" data-filter-color="${color}" data-color="${color}" aria-label="${label}便签" title="${label}便签" aria-pressed="false"><span></span></button>`).join('')}</div></div>
                    <div id="notesTagSection" class="notes-tag-section"><span class="notes-section-label">内容标签</span><div id="notesTags" class="notes-tags" aria-label="从正文提取的标签"></div></div>
                    <div class="notes-window-controls" aria-label="桌面小窗管理"><button id="notesShowAll" type="button" title="显示已经打开的桌面便签">${icon('eye')}显示小窗</button><button id="notesHideAll" type="button" title="暂时隐藏桌面便签">${icon('window')}暂时隐藏</button></div>
                    <div class="notes-sidebar-bottom"><span>${icon('shield')}只留在你的设备上</span><div><button id="notesImport" type="button">${icon('import')}导入</button><button id="notesExport" type="button">${icon('export')}导出</button><button id="notesHelpTrigger" type="button" aria-label="便签使用帮助" title="使用帮助">${icon('help')}</button></div></div>
                </aside>
                <section class="notes-library" aria-label="便签库">
                    <div class="notes-toolbar"><label class="notes-search">${icon('search')}<input id="notesSearch" type="search" placeholder="搜索标题、内容或 #标签" aria-label="搜索便签" autocomplete="off"><kbd>Ctrl F</kbd></label><div class="notes-toolbar-actions"><label class="notes-sort"><span class="notes-sr-only">排序方式</span><select id="notesSort" aria-label="排序方式"><option value="updated">最近修改</option><option value="created">创建时间</option><option value="title">标题名称</option></select>${icon('chevronDown')}</label><div class="notes-layout" role="group" aria-label="查看方式"><button type="button" data-layout="grid" aria-pressed="true" aria-label="卡片视图" title="卡片视图">${icon('grid')}</button><button type="button" data-layout="list" aria-pressed="false" aria-label="列表视图" title="列表视图">${icon('list')}</button></div><button id="notesSelect" class="notes-icon-button" type="button" aria-label="批量选择便签" aria-pressed="false" title="批量选择">${icon('select')}</button><button id="notesRefresh" class="notes-icon-button" type="button" aria-label="刷新便签" title="刷新">${icon('refresh')}</button></div></div>
                    <div class="notes-library-caption"><div><strong id="notesSummary">全部便签</strong><span id="notesResultCount">0 张便签</span></div><span class="notes-library-hint">${icon('checkCircle')}自动保存，随时继续</span></div>
                    <div id="notesList" class="notes-grid" data-layout="grid" aria-label="便签列表"></div>
                    <footer class="notes-footer"><span>${icon('note')}小窗可置顶、折叠和调整大小</span><span>关闭小窗，内容依然在这里</span></footer>
                </section>
            </div>
            <div id="notesBulk" class="notes-bulk" role="region" aria-label="批量操作" hidden><span class="notes-bulk-count">已选 <strong id="notesSelectedCount">0</strong> 张</span><div class="notes-bulk-actions"><button data-bulk-action="all" type="button" title="选择当前列表全部便签">${icon('select')}<span>全选</span></button><button data-bulk-action="open" type="button" title="在桌面打开">${icon('window')}<span>打开</span></button><button data-bulk-action="close" type="button" title="关闭桌面小窗">${icon('close')}<span>关闭</span></button><button data-bulk-action="export" type="button" title="导出选中便签">${icon('export')}<span>导出</span></button><button data-bulk-action="trash" class="is-danger" type="button" title="移入回收站">${icon('trash')}<span>移入回收站</span></button><button data-bulk-action="restore" type="button" title="恢复选中便签" hidden>${icon('restore')}<span>恢复</span></button><button data-bulk-action="delete" class="is-danger" type="button" title="永久删除选中便签" hidden>${icon('trash')}<span>永久删除</span></button></div><button data-bulk-action="clear" class="notes-bulk-clear" type="button" aria-label="取消选择" title="取消选择">${icon('close')}</button></div>
            <div id="notesNotice" class="notes-notice" role="status" aria-live="polite" hidden>${icon('checkCircle')}<span id="notesNoticeText"></span><button id="notesUndo" type="button" hidden>${icon('undo')}撤销</button></div>
        </div>
        <input id="notesImportFile" class="notes-sr-only" type="file" accept=".json,.md,.txt,application/json,text/markdown,text/plain" tabindex="-1" aria-label="导入便签文件">
        <dialog id="notesComposer" class="notes-dialog notes-composer" data-color="yellow" aria-labelledby="notesComposerHeading">
            <form id="notesComposeForm" class="notes-compose-form">
                <header class="notes-dialog-header"><div><span class="notes-eyebrow">MAKE ROOM FOR A THOUGHT</span><h3 id="notesComposerHeading">写下一点什么</h3></div><button id="notesComposeCancel" class="notes-icon-button" type="button" aria-label="关闭新建便签">${icon('close')}</button></header>
                <div class="notes-templates" role="group" aria-label="选择便签模板"><button type="button" data-template="blank" aria-pressed="true">${icon('note')}空白</button><button type="button" data-template="todo" aria-pressed="false">${icon('checklist')}待办清单</button><button type="button" data-template="meeting" aria-pressed="false">${icon('meeting')}会议记录</button><button type="button" data-template="idea" aria-pressed="false">${icon('bulb')}灵感</button></div>
                <div id="notesComposePaper" class="notes-compose-paper" data-color="yellow"><label class="notes-sr-only" for="notesComposeTitle">便签标题</label><input id="notesComposeTitle" type="text" placeholder="给它一个标题" maxlength="80" autocomplete="off"><label class="notes-sr-only" for="notesComposeContent">便签内容</label><textarea id="notesComposeContent" placeholder="从一句话开始…&#10;&#10;用 #标签 为想法分类。" maxlength="20000" spellcheck="false"></textarea><span id="notesComposeCount" class="notes-compose-count">0 / 20000</span></div>
                <div class="notes-compose-options"><div id="notesComposeColors" class="notes-compose-colors" role="group" aria-label="便签颜色">${Object.entries(colorNames).map(([color, label]) => `<button type="button" data-compose-color="${color}" data-color="${color}" aria-label="${label}" title="${label}" aria-pressed="${color === 'yellow'}"><span>${icon('check')}</span></button>`).join('')}</div><label class="notes-compose-pin"><input id="notesComposePin" type="checkbox">${icon('pin')}置顶小窗</label></div>
                <p id="notesComposeNotice" class="notes-compose-notice" role="status" aria-live="polite" hidden></p>
                <footer class="notes-dialog-footer"><label class="notes-compose-open"><input id="notesComposeOpen" type="checkbox" checked><span>创建后在桌面打开</span></label><button id="notesComposeSubmit" class="notes-button notes-button--primary" type="submit">创建便签${icon('arrowUpRight')}</button></footer>
            </form>
        </dialog>
        <dialog id="notesHelp" class="notes-dialog notes-help" aria-labelledby="notesHelpHeading"><header class="notes-dialog-header"><div><span class="notes-eyebrow">A FEW LITTLE SHORTCUTS</span><h3 id="notesHelpHeading">让记录顺手一点</h3></div><button class="notes-icon-button" type="button" data-close-dialog="notesHelp" aria-label="关闭使用帮助">${icon('close')}</button></header><div class="notes-help-body"><div class="notes-help-feature"><span>${icon('window')}</span><div><strong>灵感，留在桌面上</strong><p>便签在独立小窗里编辑，自动保存。拖动标题栏移动，拖动边缘调整大小；置顶后可随时看到。</p></div></div><div class="notes-help-feature"><span>${icon('tag')}</span><div><strong>用颜色与标签，轻轻整理</strong><p>在正文输入 #工作 或 #灵感，标签就会出现在便签库。支持搜索、筛选与批量操作。</p></div></div><div class="notes-help-feature"><span>${icon('restore')}</span><div><strong>关掉小窗，也不会丢失</strong><p>关闭便签会保留内容。移入回收站后可恢复，也可以导出备份，或导入文本与 Markdown。</p></div></div><div class="notes-shortcuts"><div><span>新建便签</span><kbd>Ctrl N</kbd></div><div><span>搜索便签</span><kbd>Ctrl F</kbd></div><div><span>全选便签（批量模式）</span><kbd>Ctrl A</kbd></div><div><span>创建便签（编辑时）</span><kbd>Ctrl Enter</kbd></div><div><span>关闭弹层 / 取消选择</span><kbd>Esc</kbd></div></div></div></dialog>
        <dialog id="notesConfirm" class="notes-dialog notes-confirm" aria-labelledby="notesConfirmTitle"><div class="notes-confirm-mark">${icon('trash')}</div><h3 id="notesConfirmTitle">确认操作</h3><p id="notesConfirmMessage"></p><div class="notes-confirm-actions"><button id="notesConfirmCancel" class="notes-button" type="button">取消</button><button id="notesConfirmAccept" class="notes-button notes-button--danger" type="button">确认</button></div></dialog>
    </div>`;
}
