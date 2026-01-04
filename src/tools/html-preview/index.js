/**
 * HTML 代码预览工具
 * 实时预览 HTML/CSS/JavaScript 代码效果
 */
import { registerTool } from '../toolRegistry.js';

// ============================================
// 工具状态
// ============================================
const previewState = {
    autoRefresh: true,
    refreshTimer: null,
    refreshDelay: 500,
    isFullscreen: false,
    abortController: null  // 用于清理事件监听器
};

// ============================================
// HTML 模板
// ============================================
function getTemplate() {
    return `
        <div class="view-container html-preview-view">
            <div class="html-preview-container">
                <!-- 顶部工具栏 -->
                <div class="html-preview-toolbar">
                    <div class="html-preview-title">
                        <i class="ri-code-box-line"></i>
                        <span>HTML 代码预览</span>
                    </div>
                    <div class="html-preview-actions">
                        <label class="html-preview-toggle">
                            <input type="checkbox" id="autoRefreshToggle" checked>
                            <span class="toggle-slider"></span>
                            <span class="toggle-label">自动刷新</span>
                        </label>
                        <button id="refreshPreviewBtn" class="html-preview-btn" title="刷新预览">
                            <i class="ri-refresh-line"></i> 刷新
                        </button>
                        <button id="clearCodeBtn" class="html-preview-btn html-preview-btn--secondary" title="清空代码">
                            <i class="ri-delete-bin-line"></i> 清空
                        </button>
                    </div>
                </div>

                <!-- 主体区域 -->
                <div class="html-preview-main">
                    <!-- 代码编辑区 -->
                    <div class="html-preview-editor-panel">
                        <div class="html-preview-panel-header">
                            <span class="panel-tab active" data-tab="html">
                                <i class="ri-html5-line"></i> HTML
                            </span>
                            <span class="panel-tab" data-tab="css">
                                <i class="ri-css3-line"></i> CSS
                            </span>
                            <span class="panel-tab" data-tab="js">
                                <i class="ri-javascript-line"></i> JS
                            </span>
                        </div>
                        <div class="html-preview-editors">
                            <textarea id="htmlEditor" class="html-preview-textarea active" 
                                placeholder="在此输入 HTML 代码..."
                                spellcheck="false"></textarea>
                            <textarea id="cssEditor" class="html-preview-textarea" 
                                placeholder="在此输入 CSS 样式..."
                                spellcheck="false"></textarea>
                            <textarea id="jsEditor" class="html-preview-textarea" 
                                placeholder="在此输入 JavaScript 代码..."
                                spellcheck="false"></textarea>
                        </div>
                    </div>

                    <!-- 预览区 -->
                    <div id="previewResultPanel" class="html-preview-result-panel">
                        <div class="html-preview-panel-header">
                            <span><i class="ri-eye-line"></i> 预览效果</span>
                            <div class="html-preview-header-actions">
                                <div class="html-preview-size-info">
                                    <span id="previewSize">--</span>
                                </div>
                                <button id="fullscreenBtn" class="html-preview-fullscreen-btn" title="全屏预览">
                                    <i class="ri-fullscreen-line"></i>
                                </button>
                            </div>
                        </div>
                        <div class="html-preview-frame-wrapper">
                            <iframe id="previewFrame" class="html-preview-frame" 
                                sandbox="allow-scripts allow-modals"
                                title="代码预览"></iframe>
                        </div>
                    </div>
                </div>

                <!-- 示例代码 -->
                <div class="html-preview-examples">
                    <span class="html-preview-examples-label">快速示例：</span>
                    <button class="html-preview-example-btn" data-example="hello">Hello World</button>
                    <button class="html-preview-example-btn" data-example="button">按钮样式</button>
                    <button class="html-preview-example-btn" data-example="card">卡片组件</button>
                    <button class="html-preview-example-btn" data-example="animation">CSS 动画</button>
                </div>
            </div>
        </div>
    `;
}

// ============================================
// CSS 样式
// ============================================
function getStyles() {
    return `
        .html-preview-view {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 46px - 3.5rem - 2rem);
            max-height: calc(100vh - 46px - 3.5rem - 2rem);
            padding: 0;
            overflow: hidden;
            box-sizing: border-box;
        }

        .html-preview-container {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            background: var(--color-bg-secondary);
            border-radius: 16px;
            overflow: hidden;
            margin: var(--spacing-lg);
            border: 1px solid var(--color-border);
        }

        /* 顶部工具栏 */
        .html-preview-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 20px;
            background: var(--color-bg-primary);
            border-bottom: 1px solid var(--color-border);
            flex-shrink: 0;
        }

        .html-preview-title {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 16px;
            font-weight: 600;
            color: var(--color-text-primary);
        }

        .html-preview-title i {
            font-size: 20px;
            color: #6366f1;
        }

        .html-preview-actions {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        /* 自动刷新开关 */
        .html-preview-toggle {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            user-select: none;
        }

        .html-preview-toggle input {
            display: none;
        }

        .toggle-slider {
            position: relative;
            width: 40px;
            height: 22px;
            background: #cbd5e1;
            border-radius: 11px;
            transition: background 0.3s;
        }

        .toggle-slider::after {
            content: '';
            position: absolute;
            top: 3px;
            left: 3px;
            width: 16px;
            height: 16px;
            background: white;
            border-radius: 50%;
            transition: transform 0.3s;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
        }

        .html-preview-toggle input:checked + .toggle-slider {
            background: #6366f1;
        }

        .html-preview-toggle input:checked + .toggle-slider::after {
            transform: translateX(18px);
        }

        .toggle-label {
            font-size: 13px;
            color: var(--color-text-secondary);
        }

        /* 按钮 */
        .html-preview-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 14px;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .html-preview-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
        }

        .html-preview-btn:active {
            transform: translateY(0);
        }

        .html-preview-btn--secondary {
            background: var(--color-bg-secondary);
            color: var(--color-text-secondary);
            border: 1px solid var(--color-border);
        }

        .html-preview-btn--secondary:hover {
            background: var(--color-bg-tertiary);
            color: var(--color-text-primary);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        /* 主体区域 */
        .html-preview-main {
            flex: 1;
            min-height: 0;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0;
        }

        /* 编辑器面板 */
        .html-preview-editor-panel {
            display: flex;
            flex-direction: column;
            border-right: 1px solid var(--color-border);
            min-height: 0;
        }

        .html-preview-panel-header {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 12px 16px;
            background: var(--color-bg-tertiary);
            border-bottom: 1px solid var(--color-border);
            flex-shrink: 0;
            font-size: 13px;
            color: var(--color-text-secondary);
        }

        .html-preview-panel-header i {
            margin-right: 6px;
        }

        /* 标签页 */
        .panel-tab {
            display: flex;
            align-items: center;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            font-weight: 500;
        }

        .panel-tab:hover {
            background: rgba(99, 102, 241, 0.1);
            color: #6366f1;
        }

        .panel-tab.active {
            background: #6366f1;
            color: white;
        }

        .panel-tab i {
            margin-right: 6px;
            font-size: 14px;
        }

        /* 编辑器容器 */
        .html-preview-editors {
            flex: 1;
            min-height: 0;
            position: relative;
        }

        .html-preview-textarea {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            padding: 16px;
            border: none;
            background: var(--color-bg-primary);
            color: var(--color-text-primary);
            font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
            font-size: 13px;
            line-height: 1.6;
            resize: none;
            outline: none;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s;
        }

        .html-preview-textarea.active {
            opacity: 1;
            pointer-events: auto;
        }

        .html-preview-textarea::placeholder {
            color: var(--color-text-tertiary);
        }

        .html-preview-textarea::-webkit-scrollbar {
            width: 8px;
        }

        .html-preview-textarea::-webkit-scrollbar-track {
            background: transparent;
        }

        .html-preview-textarea::-webkit-scrollbar-thumb {
            background: rgba(99, 102, 241, 0.2);
            border-radius: 4px;
        }

        .html-preview-textarea::-webkit-scrollbar-thumb:hover {
            background: rgba(99, 102, 241, 0.4);
        }

        /* 预览面板 */
        .html-preview-result-panel {
            display: flex;
            flex-direction: column;
            min-height: 0;
            background: var(--color-bg-primary);
            transition: all 0.3s ease;
        }

        .html-preview-header-actions {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-left: auto;
        }

        .html-preview-size-info {
            font-size: 12px;
            color: var(--color-text-tertiary);
            padding: 4px 10px;
            background: var(--color-bg-secondary);
            border-radius: 4px;
        }

        .html-preview-fullscreen-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: 6px;
            color: var(--color-text-secondary);
            cursor: pointer;
            transition: all 0.2s;
        }

        .html-preview-fullscreen-btn:hover {
            background: #6366f1;
            border-color: #6366f1;
            color: white;
        }

        .html-preview-fullscreen-btn i {
            font-size: 16px;
        }

        /* 全屏模式 */
        .html-preview-result-panel.fullscreen {
            position: fixed;
            inset: 0;
            z-index: 9999;
            background: white;
            border-radius: 0;
        }

        .html-preview-result-panel.fullscreen .html-preview-panel-header {
            padding: 16px 24px;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: white;
            border-bottom: none;
        }

        .html-preview-result-panel.fullscreen .html-preview-panel-header span {
            color: white;
        }

        .html-preview-result-panel.fullscreen .html-preview-size-info {
            background: rgba(255, 255, 255, 0.2);
            color: rgba(255, 255, 255, 0.9);
        }

        .html-preview-result-panel.fullscreen .html-preview-fullscreen-btn {
            background: rgba(255, 255, 255, 0.2);
            border-color: rgba(255, 255, 255, 0.3);
            color: white;
        }

        .html-preview-result-panel.fullscreen .html-preview-fullscreen-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .html-preview-result-panel.fullscreen .html-preview-frame-wrapper {
            padding: 20px;
            background: #f1f5f9;
        }

        .html-preview-result-panel.fullscreen .html-preview-frame {
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
        }

        .html-preview-frame-wrapper {
            flex: 1;
            min-height: 0;
            padding: 12px;
            background: #f8fafc;
            overflow: hidden;
        }

        .html-preview-frame {
            width: 100%;
            height: 100%;
            border: none;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }

        /* 示例区域 */
        .html-preview-examples {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 20px;
            background: var(--color-bg-primary);
            border-top: 1px solid var(--color-border);
            flex-shrink: 0;
            overflow-x: auto;
        }

        .html-preview-examples-label {
            font-size: 13px;
            color: var(--color-text-secondary);
            white-space: nowrap;
        }

        .html-preview-example-btn {
            padding: 6px 14px;
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: 6px;
            font-size: 12px;
            color: var(--color-text-secondary);
            cursor: pointer;
            transition: all 0.2s;
            white-space: nowrap;
        }

        .html-preview-example-btn:hover {
            background: #eef2ff;
            border-color: #6366f1;
            color: #6366f1;
        }

        /* 响应式 */
        @media (max-width: 900px) {
            .html-preview-main {
                grid-template-columns: 1fr;
                grid-template-rows: 1fr 1fr;
            }

            .html-preview-editor-panel {
                border-right: none;
                border-bottom: 1px solid var(--color-border);
            }
        }

        @media (max-width: 600px) {
            .html-preview-toolbar {
                flex-wrap: wrap;
                gap: 10px;
            }

            .html-preview-actions {
                width: 100%;
                justify-content: flex-end;
            }

            .toggle-label {
                display: none;
            }

            .html-preview-examples {
                flex-wrap: wrap;
            }
        }
    `;
}

// ============================================
// 示例代码
// ============================================
const exampleCodes = {
    hello: {
        html: `<div class="hello-container">
    <h1>👋 Hello World!</h1>
    <p>欢迎使用 HTML 代码预览工具</p>
    <button onclick="alert('Hello!')">点击我</button>
</div>`,
        css: `.hello-container {
    text-align: center;
    padding: 40px;
    font-family: -apple-system, sans-serif;
}

h1 {
    color: #1e293b;
    font-size: 2.5rem;
    margin-bottom: 10px;
}

p {
    color: #64748b;
    margin-bottom: 20px;
}

button {
    padding: 12px 24px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 16px;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
}

button:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(99, 102, 241, 0.3);
}`,
        js: ``
    },
    button: {
        html: `<div class="button-showcase">
    <button class="btn btn-primary">主要按钮</button>
    <button class="btn btn-secondary">次要按钮</button>
    <button class="btn btn-outline">边框按钮</button>
    <button class="btn btn-ghost">幽灵按钮</button>
</div>`,
        css: `.button-showcase {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    justify-content: center;
    padding: 40px;
    font-family: -apple-system, sans-serif;
}

.btn {
    padding: 12px 28px;
    font-size: 14px;
    font-weight: 500;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.3s ease;
    border: 2px solid transparent;
}

.btn-primary {
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white;
}

.btn-primary:hover {
    transform: translateY(-3px);
    box-shadow: 0 10px 25px rgba(99, 102, 241, 0.35);
}

.btn-secondary {
    background: #f1f5f9;
    color: #475569;
}

.btn-secondary:hover {
    background: #e2e8f0;
}

.btn-outline {
    background: transparent;
    border-color: #6366f1;
    color: #6366f1;
}

.btn-outline:hover {
    background: #6366f1;
    color: white;
}

.btn-ghost {
    background: transparent;
    color: #6366f1;
}

.btn-ghost:hover {
    background: rgba(99, 102, 241, 0.1);
}`,
        js: ``
    },
    card: {
        html: `<div class="card">
    <div class="card-image">
        <span class="card-badge">热门</span>
    </div>
    <div class="card-content">
        <h3 class="card-title">精美卡片组件</h3>
        <p class="card-desc">这是一个具有现代设计感的卡片组件示例，包含图片占位、标题、描述和操作按钮。</p>
        <div class="card-footer">
            <span class="card-price">¥99</span>
            <button class="card-btn">立即购买</button>
        </div>
    </div>
</div>`,
        css: `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    background: #f1f5f9;
    font-family: -apple-system, sans-serif;
}

.card {
    width: 300px;
    background: white;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
    transition: transform 0.3s, box-shadow 0.3s;
}

.card:hover {
    transform: translateY(-8px);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.15);
}

.card-image {
    height: 160px;
    background: linear-gradient(135deg, #6366f1, #ec4899);
    position: relative;
}

.card-badge {
    position: absolute;
    top: 12px;
    right: 12px;
    padding: 4px 12px;
    background: rgba(255, 255, 255, 0.9);
    color: #ec4899;
    font-size: 12px;
    font-weight: 600;
    border-radius: 20px;
}

.card-content {
    padding: 20px;
}

.card-title {
    font-size: 18px;
    color: #1e293b;
    margin-bottom: 10px;
}

.card-desc {
    font-size: 14px;
    color: #64748b;
    line-height: 1.6;
    margin-bottom: 16px;
}

.card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.card-price {
    font-size: 24px;
    font-weight: 700;
    color: #6366f1;
}

.card-btn {
    padding: 10px 20px;
    background: #6366f1;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.2s;
}

.card-btn:hover {
    background: #4f46e5;
}`,
        js: ``
    },
    animation: {
        html: `<div class="animation-demo">
    <div class="circle circle-1"></div>
    <div class="circle circle-2"></div>
    <div class="circle circle-3"></div>
    <p class="loading-text">加载中...</p>
</div>`,
        css: `.animation-demo {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    gap: 20px;
    background: linear-gradient(135deg, #1e1b4b, #312e81);
}

.circle {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    position: absolute;
}

.animation-demo {
    position: relative;
}

.circle-1 {
    background: #6366f1;
    animation: bounce 1.2s ease-in-out infinite;
    left: calc(50% - 40px);
}

.circle-2 {
    background: #8b5cf6;
    animation: bounce 1.2s ease-in-out 0.2s infinite;
    left: 50%;
    transform: translateX(-50%);
}

.circle-3 {
    background: #a855f7;
    animation: bounce 1.2s ease-in-out 0.4s infinite;
    left: calc(50% + 20px);
}

@keyframes bounce {
    0%, 100% {
        top: 50%;
        transform: translateY(-50%);
    }
    50% {
        top: calc(50% - 30px);
        transform: translateY(-50%);
    }
}

.loading-text {
    color: rgba(255, 255, 255, 0.7);
    font-family: -apple-system, sans-serif;
    font-size: 14px;
    margin-top: 60px;
    letter-spacing: 2px;
}`,
        js: ``
    }
};

// ============================================
// 初始化函数
// ============================================
async function init() {
    console.log('[HTMLPreview] 初始化 HTML 预览工具');
    
    // 清理之前的事件监听器
    if (previewState.abortController) {
        previewState.abortController.abort();
    }
    previewState.abortController = new AbortController();
    
    bindEvents();
    refreshPreview();
}

// ============================================
// 绑定事件
// ============================================
function bindEvents() {
    const signal = previewState.abortController?.signal;
    
    // 标签页切换
    document.querySelectorAll('.panel-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab), { signal });
    });

    // 编辑器输入
    const editors = ['htmlEditor', 'cssEditor', 'jsEditor'];
    editors.forEach(id => {
        const editor = document.getElementById(id);
        if (editor) {
            editor.addEventListener('input', () => {
                if (previewState.autoRefresh) {
                    debounceRefresh();
                }
            }, { signal });

            // Tab 键支持
            editor.addEventListener('keydown', (e) => {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const start = editor.selectionStart;
                    const end = editor.selectionEnd;
                    editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
                    editor.selectionStart = editor.selectionEnd = start + 4;
                }
            }, { signal });
        }
    });

    // 刷新按钮
    const refreshBtn = document.getElementById('refreshPreviewBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', refreshPreview, { signal });
    }

    // 清空按钮
    const clearBtn = document.getElementById('clearCodeBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearCode, { signal });
    }

    // 自动刷新开关
    const autoRefreshToggle = document.getElementById('autoRefreshToggle');
    if (autoRefreshToggle) {
        autoRefreshToggle.addEventListener('change', (e) => {
            previewState.autoRefresh = e.target.checked;
        }, { signal });
    }

    // 全屏按钮
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', toggleFullscreen, { signal });
    }

    // ESC 键退出全屏（使用 signal 管理）
    document.addEventListener('keydown', handleKeydown, { signal });

    // 示例按钮
    document.querySelectorAll('.html-preview-example-btn').forEach(btn => {
        btn.addEventListener('click', () => loadExample(btn.dataset.example), { signal });
    });
}

// ============================================
// 全屏切换
// ============================================
function toggleFullscreen() {
    const panel = document.getElementById('previewResultPanel');
    const btn = document.getElementById('fullscreenBtn');
    if (!panel || !btn) return;

    previewState.isFullscreen = !previewState.isFullscreen;
    panel.classList.toggle('fullscreen', previewState.isFullscreen);
    
    // 更新按钮图标
    const icon = btn.querySelector('i');
    if (icon) {
        icon.className = previewState.isFullscreen ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line';
    }
    btn.title = previewState.isFullscreen ? '退出全屏' : '全屏预览';
}

// ============================================
// 键盘事件处理
// ============================================
function handleKeydown(e) {
    // ESC 退出全屏
    if (e.key === 'Escape' && previewState.isFullscreen) {
        toggleFullscreen();
    }
}

// ============================================
// 切换标签页
// ============================================
function switchTab(tab) {
    // 更新标签高亮
    document.querySelectorAll('.panel-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });

    // 显示对应编辑器
    document.querySelectorAll('.html-preview-textarea').forEach(editor => {
        editor.classList.remove('active');
    });

    const editorMap = {
        'html': 'htmlEditor',
        'css': 'cssEditor',
        'js': 'jsEditor'
    };

    const targetEditor = document.getElementById(editorMap[tab]);
    if (targetEditor) {
        targetEditor.classList.add('active');
        targetEditor.focus();
    }
}

// ============================================
// 防抖刷新
// ============================================
function debounceRefresh() {
    if (previewState.refreshTimer) {
        clearTimeout(previewState.refreshTimer);
    }
    previewState.refreshTimer = setTimeout(refreshPreview, previewState.refreshDelay);
}

// ============================================
// 刷新预览
// ============================================
function refreshPreview() {
    const htmlEditor = document.getElementById('htmlEditor');
    const cssEditor = document.getElementById('cssEditor');
    const jsEditor = document.getElementById('jsEditor');
    const previewFrame = document.getElementById('previewFrame');

    if (!previewFrame) return;

    const html = htmlEditor?.value || '';
    const css = cssEditor?.value || '';
    const js = jsEditor?.value || '';

    // 构建完整的 HTML 文档
    const fullHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        ${css}
    </style>
</head>
<body>
    ${html}
    <script>
        try {
            ${js}
        } catch(e) {
            console.error('JS Error:', e);
        }
    </script>
</body>
</html>
    `.trim();

    // 使用 srcdoc 加载内容
    previewFrame.srcdoc = fullHtml;

    // 更新代码大小显示
    updateSizeInfo(html, css, js);
}

// ============================================
// 更新大小信息
// ============================================
function updateSizeInfo(html, css, js) {
    const sizeEl = document.getElementById('previewSize');
    if (!sizeEl) return;

    const totalBytes = new Blob([html, css, js]).size;
    let sizeText;

    if (totalBytes < 1024) {
        sizeText = `${totalBytes} B`;
    } else {
        sizeText = `${(totalBytes / 1024).toFixed(1)} KB`;
    }

    sizeEl.textContent = sizeText;
}

// ============================================
// 清空代码
// ============================================
function clearCode() {
    const htmlEditor = document.getElementById('htmlEditor');
    const cssEditor = document.getElementById('cssEditor');
    const jsEditor = document.getElementById('jsEditor');

    if (htmlEditor) htmlEditor.value = '';
    if (cssEditor) cssEditor.value = '';
    if (jsEditor) jsEditor.value = '';

    refreshPreview();
}

// ============================================
// 加载示例
// ============================================
function loadExample(name) {
    const example = exampleCodes[name];
    if (!example) return;

    const htmlEditor = document.getElementById('htmlEditor');
    const cssEditor = document.getElementById('cssEditor');
    const jsEditor = document.getElementById('jsEditor');

    if (htmlEditor) htmlEditor.value = example.html || '';
    if (cssEditor) cssEditor.value = example.css || '';
    if (jsEditor) jsEditor.value = example.js || '';

    refreshPreview();
}

// ============================================
// 销毁函数
// ============================================
function destroy() {
    if (previewState.refreshTimer) {
        clearTimeout(previewState.refreshTimer);
        previewState.refreshTimer = null;
    }
    
    // 取消所有事件监听器（包括键盘事件）
    if (previewState.abortController) {
        previewState.abortController.abort();
        previewState.abortController = null;
    }
    
    // 如果在全屏状态，退出全屏
    if (previewState.isFullscreen) {
        previewState.isFullscreen = false;
    }
    console.log('[HTMLPreview] 工具已销毁');
}

// ============================================
// 注册工具
// ============================================
registerTool({
    id: 'html-preview',
    name: 'HTML 预览',
    icon: 'ri-code-box-line',
    colorClass: 'tool-card--orange',
    category: 'design',
    description: '实时预览 HTML/CSS/JS 代码效果',
    template: getTemplate,
    styles: getStyles,
    init,
    destroy
});

console.log('[HTMLPreview] 模块已加载');
