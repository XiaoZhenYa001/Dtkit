const paths = {
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    warning: '<path d="M10.3 3.9 1.8 18.5A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.5L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
    remove: '<path d="m6 6 12 12M6 18 18 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    undo: '<path d="M3 10h12a6 6 0 0 1 0 12M3 10l5-5M3 10l5 5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9a2.7 2.7 0 1 1 4.5 2c-1.2.8-1.9 1.2-1.9 3m0 3h.01"/>',
    rename: '<path d="M4 7V4h10v3M9 4v16m-3 0h6m5-11h4m-2-2v13m-2 0h4"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    move: '<path d="M12 3v12m-4-4 4 4 4-4M4 14v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/>',
    delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    media: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4Z"/>',
};

export const batchIcon = name => `<svg class="batch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.file}</svg>`;

export const batchEmptyArt = () => `<span class="batch-empty-art" aria-hidden="true"><span>${batchIcon('file')}</span><span>${batchIcon('file')}</span><span>${batchIcon('file')}</span></span>`;

export function getTemplate() {
    const shortcuts = `<div class="batch-help-shortcuts" aria-label="键盘快捷键"><span><kbd>Ctrl + O</kbd>添加文件</span><span><kbd>Ctrl + Enter</kbd>检查变更</span><span><kbd>/</kbd>搜索清单</span></div>`;
    return `
    <div class="batch-tool-shell">
        <header class="batch-header">
            <div class="batch-heading"><span class="batch-app-icon">${batchIcon('folder')}</span><div><h2>文件批处理</h2><p>把繁琐的整理，一次做好。</p></div></div>
            <button id="batchHelp" class="batch-button batch-button--quiet" type="button" aria-label="使用帮助">${batchIcon('help')}<span>使用帮助</span></button>
        </header>

        <ol class="batch-workflow" aria-label="批处理流程"><li data-batch-step="select"><span>1</span>添加文件</li><li data-batch-step="check"><span>2</span>设置并检查</li><li data-batch-step="execute"><span>3</span>执行与查看结果</li></ol>

        <div class="batch-layout">
            <aside class="batch-config-card" aria-label="处理规则">
                <section class="batch-source-section">
                    <div class="batch-section-heading"><h3>文件</h3><button id="batchClearFiles" class="batch-text-button" type="button" disabled>清空</button></div>
                    <div id="batchDropZone" class="batch-source-box">
                        <span class="batch-source-icon">${batchIcon('add')}</span>
                        <strong>选择文件，开始整理</strong>
                        <span class="batch-source-hint">支持多选 · 每批最多 500 项</span>
                        <button id="batchSelectFiles" class="batch-button batch-button--secondary" type="button">${batchIcon('folder')}增加文件</button>
                    </div>
                    <div id="batchSelectionSummary" class="batch-selection batch-selection--empty" aria-live="polite">尚未选择文件</div>
                </section>

                <div class="batch-folder-import"><button id="batchSelectFolder" class="batch-text-button" type="button">${batchIcon('folder')}从文件夹添加</button><label class="batch-check"><input id="batchIncludeSubfolders" type="checkbox"><span>包含子文件夹</span></label></div>

                <div class="batch-config-footer"><div class="batch-actions"><button id="batchPreview" class="batch-button batch-button--secondary" type="button">检查变更</button><button id="batchExecute" class="batch-button batch-button--primary" type="button" disabled><span data-batch-execute-label>执行重命名</span>${batchIcon('arrow')}</button></div><p id="batchStatus" class="batch-status" role="status" aria-live="polite">选择文件后，先检查变更。</p></div>

                <section class="batch-rules-section">
                    <div class="batch-section-heading"><h3>处理方式</h3><button id="batchResetRules" class="batch-text-button" type="button">重置规则</button></div>
                    <div class="batch-operation-grid" role="radiogroup" aria-label="批处理方式">
                        <span class="batch-operation-indicator" aria-hidden="true"></span>
                        ${[['rename', '重命名'], ['copy', '复制'], ['move', '移动'], ['delete', '删除']].map(([value, title], index) => `<label><input type="radio" name="batchOperation" value="${value}" ${index ? '' : 'checked'}><span>${title}</span></label>`).join('')}
                    </div>

                    <div id="batchOptions" class="batch-options">
                        <section id="batchRenameOptions" class="batch-operation-panel">
                            <label class="batch-field"><span>命名方式</span><select id="batchRenamePreset"><option value="numbered" selected>原名 + 序号</option><option value="sequence">统一名称 + 序号</option><option value="parent">父文件夹 + 序号</option><option value="original">保留原名</option><option value="prefix">添加前缀</option><option value="suffix">添加后缀</option><option value="custom">自定义模板</option></select></label>
                            <label class="batch-field"><span>文件名模板</span><input id="batchNamePattern" type="text" value="{name}_{n}{dotext}" maxlength="160" autocomplete="off" spellcheck="false" aria-describedby="batchPatternHint"></label>
                            <div class="batch-template-tokens" aria-label="插入模板变量"><button type="button" data-batch-token="{name}" title="插入原文件名">原名</button><button type="button" data-batch-token="{n}" title="插入序号">序号</button><button type="button" data-batch-token="{dotext}" title="插入点号与扩展名">扩展名</button><button type="button" data-batch-token="{folder}" title="插入父文件夹名">父文件夹</button></div>
                            <p id="batchPatternHint" class="batch-field-hint">轻点变量插入光标位置；扩展名建议保留。</p>
                            <div class="batch-options-grid"><label class="batch-field"><span>起始序号</span><input id="batchStartIndex" type="number" min="0" max="999999" value="1"></label><label class="batch-field"><span>序号位数</span><select id="batchNumberPadding"><option value="1">1 · 2 · 3</option><option value="2">01 · 02 · 03</option><option value="3">001 · 002 · 003</option><option value="4">0001 · 0002</option></select></label></div>
                            <details class="batch-disclosure batch-advanced"><summary><span>更多命名规则</span>${batchIcon('chevron')}</summary><div class="batch-disclosure-content">
                                <div class="batch-options-grid"><label class="batch-field"><span>查找文字</span><input id="batchFind" type="text" maxlength="160" placeholder="原名中的文字" autocomplete="off"></label><label class="batch-field"><span>替换为</span><input id="batchReplace" type="text" maxlength="160" placeholder="留空即删除" autocomplete="off"></label></div>
                                <p class="batch-field-hint">替换与大小写仅应用于原名，不改变扩展名。</p>
                                <div class="batch-options-grid"><label class="batch-field"><span>字母大小写</span><select id="batchCaseMode"><option value="keep">保持原样</option><option value="lower">全部小写</option><option value="upper">全部大写</option></select></label><label class="batch-field"><span>序号间隔</span><input id="batchNumberStep" type="number" min="1" max="10000" value="1"></label></div>
                                <label class="batch-check"><input id="batchTrimWhitespace" type="checkbox"><span>去除原名首尾空白</span></label>
                                <div class="batch-options-grid"><label class="batch-field"><span>移除开头字符数</span><input id="batchRemoveStart" type="number" min="0" max="160" value="0"></label><label class="batch-field"><span>移除结尾字符数</span><input id="batchRemoveEnd" type="number" min="0" max="160" value="0"></label></div>
                                <label class="batch-field"><span>扩展名大小写</span><select id="batchExtensionCase"><option value="keep">保留原扩展名</option><option value="lower">扩展名转小写</option><option value="upper">扩展名转大写</option></select></label>
                                <p class="batch-field-hint">先整理空白和移除首尾字符，再查找替换、调整原名大小写。扩展名单独设置，不转换文件格式。</p>
                            </div></details>
                        </section>

                        <section id="batchDestinationOptions" class="batch-operation-panel" hidden inert>
                            <div class="batch-destination"><span class="batch-destination-icon">${batchIcon('folder')}</span><span class="batch-field-label">目标文件夹</span><strong id="batchDestinationPath">尚未选择</strong><button id="batchSelectDestination" class="batch-button batch-button--secondary" type="button">选择文件夹${batchIcon('chevron')}</button></div>
                            <p class="batch-field-hint">保留文件原名，已存在的同名文件会在检查时提示。</p>
                        </section>

                        <section id="batchDeleteOptions" class="batch-operation-panel batch-delete-options" hidden inert>
                            <div class="batch-recovery-note"><span>${batchIcon('shield')}</span><div><strong>先移入恢复区</strong><p>默认保留恢复机会，可在本次任务完成后找回文件。</p></div></div>
                            <label class="batch-check batch-permanent-check"><input id="batchPermanent" type="checkbox"><span>彻底删除，不保留恢复副本</span></label>
                        </section>
                    </div>

                    <label class="batch-field batch-filter-field"><span>仅处理这些类型<span class="batch-optional">可选</span></span><input id="batchExtensions" type="text" placeholder="例如 jpg, png, pdf" autocomplete="off" spellcheck="false"><small>留空处理全部已选文件。</small></label>
                </section>

            </aside>

            <main class="batch-main">
                <section class="batch-preview-card" aria-labelledby="batchPreviewTitle">
                    <div class="batch-preview-header"><div><span class="batch-eyebrow">一目了然</span><h3 id="batchPreviewTitle">文件与变更</h3><span id="batchCheckState" class="batch-check-state">本地草稿</span></div><button id="batchExport" class="batch-button batch-button--quiet" type="button" disabled>${batchIcon('download')}<span>导出清单</span></button></div>
                    <div class="batch-stats" aria-label="本批文件统计"><div><span id="batchTotalLabel">已选文件</span><strong id="batchCountTotal">0</strong></div><div><span><i class="batch-dot batch-dot--ready"></i><span id="batchReadyLabel">预计处理</span></span><strong id="batchCountReady">—</strong></div><div><span><i class="batch-dot batch-dot--conflict"></i>需检查</span><strong id="batchCountConflict">—</strong></div></div>
                    <div class="batch-list-toolbar"><label class="batch-search">${batchIcon('search')}<input id="batchSearch" type="search" placeholder="搜索文件名或路径" aria-label="搜索文件名或路径" autocomplete="off"></label><label class="batch-sort"><span class="batch-sr-only">文件排序</span><select id="batchSort" aria-label="文件排序"><option value="manual">选择顺序</option><option value="name-asc">名称 A → Z</option><option value="name-desc">名称 Z → A</option><option value="extension">文件类型</option></select></label></div>
                    <div class="batch-list-meta"><span id="batchPreviewMeta">增加文件，查看待处理清单。</span><div class="batch-list-actions"><button id="batchRemoveConflicts" type="button" class="batch-text-button" disabled>从清单移除冲突</button><button id="batchRemoveVisible" type="button" class="batch-text-button" disabled>移除当前筛选项</button><label class="batch-check batch-conflict-filter"><input id="batchOnlyConflicts" type="checkbox"><span>仅看冲突</span></label></div></div>
                    <div class="batch-list-columns" aria-hidden="true"><span>原文件</span><span>变更后</span><span>状态</span></div>
                    <div id="batchPreviewList" class="batch-preview-list"><div class="batch-empty-state"><span class="batch-empty-art"><span>${batchIcon('file')}</span><span>${batchIcon('file')}</span><span>${batchIcon('file')}</span></span><strong>从一份清晰的清单开始</strong><p>照片、文档、素材，都可以一起整理。<br>选择文件后，在这里查看每一项变更。</p></div></div>
                    <div class="batch-list-footer"><span id="batchListCount">0 个文件</span><button id="batchShowMore" class="batch-text-button" type="button" hidden>显示更多</button><span class="batch-safety-note">${batchIcon('shield')}检查后执行</span></div>

                    <div id="batchProgressPanel" class="batch-progress" hidden><div class="batch-progress-heading"><span class="batch-progress-orb">${batchIcon('spark')}</span><div><strong id="batchProgressLabel">正在处理</strong><span class="batch-progress-caption">完成结果会显示在下方记录中</span></div><span id="batchProgressValue">0%</span></div><progress id="batchProgressBar" max="1" value="0" aria-label="文件处理进度"></progress><div class="batch-progress-actions"><button id="batchCancel" class="batch-button batch-button--secondary" type="button">取消任务</button><button id="batchRestore" class="batch-button batch-button--secondary" type="button" hidden>${batchIcon('undo')}恢复本批文件</button></div></div>
                </section>

                <details class="batch-disclosure batch-history"><summary><span>${batchIcon('clock')}最近任务<span class="batch-history-hint">本次使用期间</span></span>${batchIcon('chevron')}</summary><div class="batch-disclosure-content"><div id="batchHistoryList" class="batch-history-list"><p class="batch-history-empty">完成任务后，可在这里查看结果。</p></div></div></details>
            </main>
        </div>

        <dialog id="batchDangerDialog" class="batch-dialog batch-danger-dialog" aria-labelledby="batchDangerTitle"><form method="dialog"><button class="batch-dialog-close" type="button" data-batch-close aria-label="关闭">${batchIcon('remove')}</button><span class="batch-danger-icon">${batchIcon('delete')}</span><h3 id="batchDangerTitle">确认彻底删除？</h3><p>这些文件不会进入恢复区，也无法通过 DtKit 撤销。请确认你已经检查预览列表。</p><div class="batch-dialog-actions"><button type="button" data-batch-close class="batch-button batch-button--secondary">返回检查</button><button id="batchConfirmPermanent" value="default" class="batch-button batch-button--danger">仍然彻底删除</button></div></form></dialog>

        <dialog id="batchHelpDialog" class="batch-dialog batch-help-dialog" aria-labelledby="batchHelpTitle"><div class="batch-help-content"><button class="batch-dialog-close" type="button" data-batch-close aria-label="关闭">${batchIcon('remove')}</button><span class="batch-help-icon">${batchIcon('spark')}</span><h3 id="batchHelpTitle">整理文件，三步就好</h3><ol><li><span>1</span><div><strong>选好文件</strong><p>可多次增加文件，或从文件夹导入并选择包含子文件夹；每批最多 500 项。</p></div></li><li><span>2</span><div><strong>设置处理方式</strong><p>重命名、复制、移动或删除。支持父文件夹变量、首尾字符整理、编号和独立扩展名大小写。</p></div></li><li><span>3</span><div><strong>检查，再执行</strong><p>核对原生检查的目标名称和冲突。可批量从清单移除冲突或筛选项，规则和清单改变后需要重新检查。</p></div></li></ol><div class="batch-help-tokens"><strong>模板小提示</strong><p><code>{name}</code> 原名 <code>{n}</code> 序号 <code>{dotext}</code> 点号与扩展名 <code>{folder}</code> 父文件夹名</p><p>例如 <code>旅行_{n}{dotext}</code> → 旅行_01.jpg</p></div>${shortcuts}<p class="batch-help-footnote">默认删除移入 DtKit 恢复区；仅本次使用期间保留最近任务记录。</p><button class="batch-button batch-button--primary" type="button" data-batch-close>开始整理</button></div></dialog>
    </div>`;
}
