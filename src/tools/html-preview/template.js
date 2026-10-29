const tabs = [['html', 'HTML', 'ri-html5-line'], ['css', 'CSS', 'ri-css3-line'], ['js', 'JavaScript', 'ri-javascript-line']];

export function getTemplate() {
    return `
    <div class="view-container html-preview-view">
        <section class="html-preview-container" aria-label="HTML 预览工作区">
            <header class="html-preview-toolbar">
                <div class="html-preview-title">
                    <span class="html-preview-mark" aria-hidden="true"><i class="ri-code-box-line"></i></span>
                    <div><h1>HTML 预览</h1><p>写下代码，即刻看见。</p></div>
                </div>
                <div class="html-preview-actions">
                    <label class="html-preview-toggle">
                        <input type="checkbox" id="autoRefreshToggle" checked>
                        <span class="toggle-slider" aria-hidden="true"></span>
                        <span class="toggle-label">实时预览</span>
                    </label>
                    <button type="button" id="clearCodeBtn" class="html-preview-btn html-preview-btn--secondary" title="清空三个编辑器">
                        <i class="ri-delete-bin-line" aria-hidden="true"></i><span>清空</span>
                    </button>
                    <button type="button" id="refreshPreviewBtn" class="html-preview-btn" title="运行预览（Ctrl+Enter）">
                        <i class="ri-play-line" aria-hidden="true"></i><span>运行</span><kbd>Ctrl ↵</kbd>
                    </button>
                </div>
            </header>

            <div class="html-preview-main">
                <section id="previewEditorPanel" class="html-preview-editor-panel" aria-label="代码编辑">
                    <div class="html-preview-panel-header html-preview-code-header" role="tablist" aria-label="代码语言">
                        ${tabs.map(([key, name, icon], index) => `<button type="button" id="${key}Tab" class="panel-tab${index === 0 ? ' active' : ''}" data-tab="${key}" role="tab" aria-selected="${index === 0}" aria-controls="${key}EditorPane" tabindex="${index === 0 ? '0' : '-1'}"><i class="${icon}" aria-hidden="true"></i>${name}<span class="html-preview-tab-dot" aria-hidden="true"></span></button>`).join('')}
                        <span class="html-preview-code-label" aria-hidden="true">CODE</span>
                    </div>
                    <div class="html-preview-editors">
                        ${tabs.map(([key, name], index) => `<div id="${key}EditorPane" class="html-preview-editor-pane" role="tabpanel" aria-labelledby="${key}Tab"${index ? ' hidden' : ''}>
                            <div class="html-preview-line-numbers" aria-hidden="true"><div>1</div></div>
                            <textarea id="${key}Editor" class="html-preview-textarea${index === 0 ? ' active' : ''}" aria-label="${name} 代码" placeholder="${key === 'html' ? '<!-- 在这里粘贴完整页面，或从下方选择一个示例 -->' : key === 'css' ? '/* 在这里编写 CSS 样式 */' : '// 在这里编写 JavaScript'}" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
                        </div>`).join('')}
                    </div>
                    <footer class="html-preview-editor-status">
                        <span id="editorPosition">行 1，列 1</span><span id="editorLineCount">1 行</span>
                        <span class="html-preview-editor-hint">Tab 缩进 · Esc 离开编辑区</span><span id="previewSize">0 B</span>
                    </footer>
                </section>

                <div id="previewDivider" class="html-preview-divider" role="separator" tabindex="0" aria-label="调整编辑区宽度" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="70" aria-valuenow="45" aria-controls="previewEditorPanel" title="拖动或按左右方向键调整；双击复位"><span></span></div>

                <section id="previewResultPanel" class="html-preview-result-panel" aria-label="预览效果">
                    <header class="html-preview-panel-header html-preview-render-header">
                        <span class="html-preview-result-title"><span class="html-preview-live-dot" aria-hidden="true"></span>预览</span>
                        <div class="html-preview-header-actions">
                            <div class="html-preview-devices" role="group" aria-label="预览尺寸">
                                <button type="button" data-viewport="responsive" aria-pressed="true" title="自适应宽度" aria-label="自适应宽度"><i class="ri-computer-line" aria-hidden="true"></i><span>自适应</span></button>
                                <button type="button" data-viewport="tablet" aria-pressed="false" title="平板 · 768 × 1024" aria-label="平板 768 × 1024"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M10 18h4"/></svg></button>
                                <button type="button" data-viewport="mobile" aria-pressed="false" title="手机 · 390 × 844" aria-label="手机 390 × 844"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4m-3 14h2"/></svg></button>
                            </div>
                            <button type="button" id="fullscreenBtn" class="html-preview-fullscreen-btn" title="全屏预览" aria-label="全屏预览" aria-pressed="false"><i class="ri-fullscreen-line" aria-hidden="true"></i></button>
                        </div>
                    </header>
                    <div id="previewNotice" class="html-preview-notice" role="status" hidden></div>
                    <div class="html-preview-frame-wrapper">
                        <div id="previewViewport" class="html-preview-viewport">
                            <iframe id="previewFrame" class="html-preview-frame" sandbox="allow-scripts allow-modals" title="代码预览"></iframe>
                        </div>
                        <div id="previewEmpty" class="html-preview-empty">
                            <span class="html-preview-empty-art" aria-hidden="true"><i class="ri-code-box-line"></i><span>&lt;/&gt;</span></span>
                            <h2>让想法在这里成形</h2>
                            <p>粘贴 HTML，或打开一个示例。<br>样式和交互会在这里实时呈现。</p>
                            <button type="button" class="html-preview-example-btn" data-example="hello">试试 Hello World <i class="ri-arrow-right-line" aria-hidden="true"></i></button>
                        </div>
                    </div>
                    <footer class="html-preview-render-status"><span id="previewRunStatus" role="status" aria-live="polite" data-state="empty">等待代码</span><span><span id="viewportSize">—</span><span id="viewportScale"></span></span></footer>
                </section>
            </div>

            <footer class="html-preview-examples">
                <span class="html-preview-examples-label">从示例开始</span>
                <div class="html-preview-example-list">
                    <button type="button" class="html-preview-example-btn" data-example="hello">Hello World</button>
                    <button type="button" class="html-preview-example-btn" data-example="button">交互按钮</button>
                    <button type="button" class="html-preview-example-btn" data-example="card">卡片组件</button>
                    <button type="button" class="html-preview-example-btn" data-example="animation">CSS 动画</button>
                </div>
                <span class="html-preview-sandbox-note"><i class="ri-shield-check-line" aria-hidden="true"></i>独立沙盒运行</span>
            </footer>
        </section>
    </div>`;
}
