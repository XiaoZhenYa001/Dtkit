const icon = name => `<i class="${name}" aria-hidden="true"></i>`;
const modeButton = (mode, label, glyph, shortcut = '', active = false) => `
    <button type="button" data-board-mode="${mode}" aria-label="${label}${shortcut ? ` (${shortcut})` : ''}" aria-pressed="${active}" title="${label}${shortcut ? ` (${shortcut})` : ''}">
        ${icon(glyph)}<span>${label}</span>${shortcut ? `<kbd>${shortcut}</kbd>` : ''}
    </button>`;

export function getTemplate() {
    return `
        <div class="whiteboard-tool">
            <header class="whiteboard-hero"><h2>无限白板</h2></header>
            <section class="whiteboard-stage" aria-label="无限白板画布">
                <div class="whiteboard-surface is-empty" id="whiteboardSurface">
                    <canvas id="whiteboardCommittedCanvas" aria-hidden="true"></canvas>
                    <div class="whiteboard-ink-layer" id="whiteboardInkLayer">
                        <canvas id="whiteboardCanvas" tabindex="0" aria-label="白板画布，使用工具栏绘制，空格拖动，滚轮缩放" aria-describedby="whiteboardCanvasHint"></canvas>
                        <svg id="whiteboardStrokeTail" aria-hidden="true"><path id="whiteboardStrokeTailPath" fill="none" stroke-linecap="round" stroke-linejoin="round"></path></svg>
                    </div>
                    <div class="whiteboard-formula-layer" id="whiteboardFormulaLayer" aria-hidden="true"></div>
                    <div class="whiteboard-cursor" id="whiteboardCursor" aria-hidden="true" hidden></div>
                    <div class="whiteboard-empty-hint" aria-hidden="true">
                        <span class="whiteboard-empty-hint__mark">${icon('ri-brush-2-line')}</span><strong>让想法，自由展开。</strong>
                        <span>从一笔开始，也可以插入文字、便签或公式</span>
                        <div><kbd>B</kbd> 画笔 <b>·</b> <kbd>V</kbd> 选择 <b>·</b> <kbd>空格</kbd> 平移</div>
                    </div>
                </div>
                <div class="whiteboard-readonly" id="whiteboardReadOnly" hidden>${icon('ri-lock-2-line')}<span>此白板正在另一窗口编辑</span><button id="whiteboardTakeOver" type="button">接管编辑</button></div>
            </section>

            <header class="whiteboard-docbar">
                <div class="whiteboard-identity"><span class="whiteboard-identity__mark" aria-hidden="true">${icon('ri-layout-grid-line')}</span><div><span class="whiteboard-kicker">白板</span><input class="whiteboard-name" id="whiteboardName" maxlength="60" value="未命名白板" aria-label="白板名称"></div></div>
                <div class="whiteboard-docbar__actions">
                    <div class="whiteboard-history-group" role="group" aria-label="撤销与重做">
                        <button id="whiteboardUndo" type="button" aria-label="撤销 (Ctrl+Z)" title="撤销 (Ctrl+Z)" disabled>${icon('ri-arrow-go-back-line')}</button>
                        <button id="whiteboardRedo" type="button" aria-label="重做 (Ctrl+Shift+Z)" title="重做 (Ctrl+Shift+Z)" disabled>${icon('ri-arrow-go-forward-line')}</button>
                    </div>
                    <button class="whiteboard-save-button" id="whiteboardSave" type="button" title="保存白板 (Ctrl+S)">${icon('ri-save-3-line')}<span>保存</span></button>
                    <div class="whiteboard-cluster whiteboard-action-group" data-board-cluster="file">
                        <button class="whiteboard-cluster-trigger whiteboard-file-trigger" type="button" data-board-panel="file" aria-label="白板文件操作" title="文件操作" aria-expanded="false" aria-controls="whiteboardFilePanel"><span class="whiteboard-more-mark" aria-hidden="true">···</span><span>文件</span></button>
                        <div class="whiteboard-cluster-panel whiteboard-cluster-panel--end whiteboard-file-panel" id="whiteboardFilePanel" data-board-panel-content="file" hidden>
                            <span class="whiteboard-panel-eyebrow">这张白板</span>
                            <button id="whiteboardSaveAs" type="button">${icon('ri-file-copy-line')}<span>另存为新白板</span></button>
                            <button id="whiteboardExport" type="button">${icon('ri-download-2-line')}<span>导出高清 PNG</span></button><hr>
                            <button id="whiteboardClear" class="whiteboard-danger-action" type="button">${icon('ri-delete-bin-6-line')}<span>清空画布</span></button>
                        </div>
                    </div>
                </div>
            </header>

            <div class="whiteboard-toolbar" role="toolbar" aria-label="白板工具栏">
                <div class="whiteboard-direct-tools whiteboard-tool-group" role="group" aria-label="常用工具">
                    ${modeButton('select', '选择', 'ri-cursor-line', 'V')}${modeButton('pan', '平移', 'ri-drag-move-2-line', '空格')}
                    ${modeButton('pen', '画笔', 'ri-brush-2-line', 'B', true)}${modeButton('highlighter', '荧光笔', 'ri-mark-pen-line', 'H')}${modeButton('eraser', '橡皮擦', 'ri-eraser-line', 'E')}
                </div>
                <span class="whiteboard-toolbar-divider" aria-hidden="true"></span>
                <div class="whiteboard-cluster" data-board-cluster="draw">
                    <button class="whiteboard-cluster-trigger whiteboard-properties-trigger" type="button" data-board-panel="draw" aria-label="颜色与笔宽" title="颜色与笔宽" aria-expanded="false" aria-controls="whiteboardDrawPanel"><span class="whiteboard-current-color" aria-hidden="true"></span><span>属性</span></button>
                    <div class="whiteboard-cluster-panel whiteboard-cluster-panel--draw" id="whiteboardDrawPanel" data-board-panel-content="draw" hidden>
                        <div class="whiteboard-panel-heading"><strong>颜色与笔宽</strong><span>下一笔，由你定义</span></div>
                        <div class="whiteboard-tool-group whiteboard-colors" role="group" aria-label="绘制颜色">
                            <button class="whiteboard-color whiteboard-color--ink" type="button" data-board-color="#242937" aria-label="墨黑" aria-pressed="true"></button>
                            <button class="whiteboard-color whiteboard-color--orange" type="button" data-board-color="#d96f3d" aria-label="暖橙" aria-pressed="false"></button>
                            <button class="whiteboard-color whiteboard-color--blue" type="button" data-board-color="#3f6d74" aria-label="深蓝" aria-pressed="false"></button>
                            <button class="whiteboard-color whiteboard-color--green" type="button" data-board-color="#3f8061" aria-label="墨绿" aria-pressed="false"></button>
                            <label class="whiteboard-color-picker" title="自定义颜色">${icon('ri-palette-line')}<input id="whiteboardColorInput" type="color" value="#242937" aria-label="自定义绘制颜色"></label>
                        </div>
                        <label class="whiteboard-size-control" for="whiteboardSize"><span>笔宽</span><output id="whiteboardSizeValue" for="whiteboardSize">4 px</output><input id="whiteboardSize" type="range" min="1" max="24" value="4" aria-label="笔宽" aria-describedby="whiteboardSizeValue"></label>
                        <div class="whiteboard-stroke-sample" aria-hidden="true"><span></span></div>
                    </div>
                </div>
                <div class="whiteboard-cluster" data-board-cluster="shape">
                    <button class="whiteboard-cluster-trigger" type="button" data-board-panel="shape" data-panel-modes="line,arrow,rect,ellipse" aria-label="图形工具" title="图形工具" aria-expanded="false" aria-controls="whiteboardShapePanel">${icon('ri-shape-line')}<span>图形</span></button>
                    <div class="whiteboard-cluster-panel" id="whiteboardShapePanel" data-board-panel-content="shape" hidden><span class="whiteboard-panel-eyebrow">图形</span><div class="whiteboard-tool-group whiteboard-shape-group" role="group" aria-label="图形工具">
                        ${modeButton('line', '直线', 'ri-subtract-line')}${modeButton('arrow', '箭头', 'ri-arrow-right-line')}${modeButton('rect', '矩形', 'ri-checkbox-blank-line')}${modeButton('ellipse', '椭圆', 'ri-checkbox-blank-circle-line')}
                    </div></div>
                </div>
                <div class="whiteboard-cluster" data-board-cluster="content">
                    <button class="whiteboard-cluster-trigger" type="button" data-board-panel="content" data-panel-modes="text,note,formula" aria-label="插入内容" title="插入内容" aria-expanded="false" aria-controls="whiteboardContentPanel">${icon('ri-add-line')}<span>插入</span></button>
                    <div class="whiteboard-cluster-panel whiteboard-content-panel" id="whiteboardContentPanel" data-board-panel-content="content" hidden><span class="whiteboard-panel-eyebrow">表达更多想法</span><div class="whiteboard-tool-group" role="group" aria-label="内容工具">
                        ${modeButton('text', '文字', 'ri-text')}${modeButton('note', '便签', 'ri-sticky-note-line')}${modeButton('formula', '公式', 'ri-function-line')}
                    </div><p>选择后，点击画布放置内容</p></div>
                </div>
                <div class="whiteboard-cluster" data-board-cluster="canvas">
                    <button class="whiteboard-cluster-trigger" type="button" data-board-panel="canvas" aria-label="画布纸张" title="画布纸张" aria-expanded="false" aria-controls="whiteboardCanvasPanel">${icon('ri-layout-grid-line')}<span>纸张</span></button>
                    <div class="whiteboard-cluster-panel whiteboard-cluster-panel--end whiteboard-canvas-panel" id="whiteboardCanvasPanel" data-board-panel-content="canvas" hidden>
                        <div class="whiteboard-panel-heading"><strong>画布纸张</strong><span>为思考找一个合适的底色</span></div>
                        <button class="whiteboard-background-trigger" id="whiteboardBackground" type="button" aria-expanded="false" aria-controls="whiteboardBackgroundMenu">${icon('ri-layout-grid-line')}<span>选择纸张样式</span>${icon('ri-arrow-down-s-line')}</button>
                        <div class="whiteboard-background-menu" id="whiteboardBackgroundMenu" role="group" aria-label="纸张样式" hidden>
                            <button type="button" data-board-background="blank" aria-pressed="false"><span class="whiteboard-paper-sample" aria-hidden="true"></span>纯白</button>
                            <button type="button" data-board-background="dots" aria-pressed="true"><span class="whiteboard-paper-sample" aria-hidden="true"></span>点阵</button>
                            <button type="button" data-board-background="grid" aria-pressed="false"><span class="whiteboard-paper-sample" aria-hidden="true"></span>方格</button>
                            <button type="button" data-board-background="math" aria-pressed="false"><span class="whiteboard-paper-sample" aria-hidden="true"></span>数学本</button>
                            <button type="button" data-board-background="ruled" aria-pressed="false"><span class="whiteboard-paper-sample" aria-hidden="true"></span>横线</button>
                            <button type="button" data-board-background="english" aria-pressed="false"><span class="whiteboard-paper-sample" aria-hidden="true"></span>英语本</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="whiteboard-selection-toolbar" id="whiteboardSelectionToolbar" role="toolbar" aria-label="所选对象操作" hidden><span id="whiteboardSelectionLabel">已选择对象</span><span class="whiteboard-toolbar-divider" aria-hidden="true"></span>
                <button id="whiteboardEditSelected" type="button" title="编辑内容" aria-label="编辑所选内容">${icon('ri-edit-line')}</button><button id="whiteboardDuplicate" type="button" title="复制对象 (Ctrl+D)" aria-label="复制所选对象">${icon('ri-file-copy-line')}</button><button id="whiteboardDelete" class="whiteboard-danger-action" type="button" title="删除对象 (Delete)" aria-label="删除所选对象">${icon('ri-delete-bin-6-line')}</button>
            </div>
            <aside class="whiteboard-history" id="whiteboardHistory" aria-label="历史白板" aria-hidden="true" inert>
                <header><div><span class="whiteboard-panel-eyebrow">你的本地空间</span><strong>历史白板</strong></div><button id="whiteboardHistoryClose" type="button" aria-label="关闭历史白板" title="关闭历史白板">${icon('ri-close-line')}</button></header>
                <div class="whiteboard-history-list" id="whiteboardHistoryList"></div><footer><button id="whiteboardNew" type="button">${icon('ri-add-line')}<span>新建白板</span></button><span>恢复草稿与正式白板，均保存在本机</span></footer>
            </aside>
            <button class="whiteboard-history-rail" id="whiteboardHistoryRail" type="button" aria-label="展开历史白板" title="历史白板" aria-expanded="false" aria-controls="whiteboardHistory">${icon('ri-history-line')}<span>历史</span>${icon('ri-arrow-right-s-line whiteboard-history-rail__arrow')}</button>
            <footer class="whiteboard-statusbar"><span class="whiteboard-status" id="whiteboardStatus" role="status" aria-live="polite"><i aria-hidden="true"></i>新白板</span><span id="whiteboardObjectCount">0 个对象</span></footer>
            <div class="whiteboard-viewport-controls" role="group" aria-label="画布缩放"><button id="whiteboardZoomOut" type="button" aria-label="缩小画布" title="缩小">${icon('ri-subtract-line')}</button><button class="whiteboard-zoom-reset" id="whiteboardZoomReset" type="button" aria-label="重置为 100% 缩放" title="重置缩放"><span id="whiteboardZoom">100%</span></button><button id="whiteboardZoomIn" type="button" aria-label="放大画布" title="放大">${icon('ri-add-line')}</button><span class="whiteboard-toolbar-divider" aria-hidden="true"></span><button id="whiteboardFit" type="button" aria-label="适应全部内容" title="适应内容">${icon('ri-focus-3-line')}</button></div>
            <button class="whiteboard-help-trigger" id="whiteboardHelp" type="button" aria-label="查看白板快捷键" title="快捷键" aria-expanded="false" aria-controls="whiteboardHelpPanel">?</button>
            <div class="whiteboard-help-panel" id="whiteboardHelpPanel" role="dialog" aria-label="白板快捷键" hidden><div class="whiteboard-panel-heading"><strong>指尖之间，思路更流畅。</strong><span>常用快捷键</span></div><dl>
                <div><dt>画笔 / 选择 / 橡皮</dt><dd><kbd>B</kbd> <kbd>V</kbd> <kbd>E</kbd></dd></div><div><dt>临时平移</dt><dd><kbd>空格</kbd> + 拖动</dd></div><div><dt>缩放画布</dt><dd>滚轮</dd></div><div><dt>撤销 / 重做</dt><dd><kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Y</kbd></dd></div><div><dt>保存白板</dt><dd><kbd>Ctrl</kbd> + <kbd>S</kbd></dd></div><div><dt>复制 / 删除对象</dt><dd><kbd>Ctrl</kbd> + <kbd>D</kbd> / <kbd>Delete</kbd></dd></div>
            </dl><p id="whiteboardCanvasHint">滚轮缩放 · 空格拖动画布 · Escape 关闭面板</p></div>
            <div class="whiteboard-object-dialog" id="whiteboardObjectDialog" hidden><div class="whiteboard-object-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="whiteboardDialogTitle" aria-describedby="whiteboardDialogHint" tabindex="-1">
                <header><div><span class="whiteboard-panel-eyebrow">把想法放上画布</span><strong id="whiteboardDialogTitle">插入内容</strong></div><button id="whiteboardDialogClose" type="button" aria-label="关闭插入内容">${icon('ri-close-line')}</button></header>
                <div class="whiteboard-formula-symbols" id="whiteboardFormulaSymbols" role="group" aria-label="插入常用数学符号" hidden><button type="button" data-formula="\\frac{}{}">分数</button><button type="button" data-formula="\\sqrt{}">根号</button><button type="button" data-formula="x^{}">上标</button><button type="button" data-formula="\\sum_{}^{}">求和</button><button type="button" data-formula="\\int_{}^{}">积分</button><button type="button" data-formula="\\lim_{}">极限</button><button type="button" data-formula="\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}">矩阵</button></div>
                <textarea id="whiteboardObjectInput" rows="5" placeholder="输入文字" aria-label="内容" aria-describedby="whiteboardDialogHint"></textarea><div class="whiteboard-formula-preview" id="whiteboardFormulaPreview" aria-label="数学表达式预览" hidden></div>
                <footer><span id="whiteboardDialogHint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 确认</span><button id="whiteboardDialogCancel" type="button">取消</button><button id="whiteboardDialogConfirm" type="button">插入</button></footer>
            </div></div>
        </div>`;
}
