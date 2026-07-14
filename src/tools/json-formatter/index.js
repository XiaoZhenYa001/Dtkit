/**
 * JSON 格式化工具
 * 格式化、美化和验证 JSON 数据
 */
import { registerTool } from '../toolRegistry.js';
import '../../css/tools/json-formatter.css';

let jsonState = {
    currentInput: '',
    currentOutput: '',
    isValid: false,
    indent: 2,
    abortController: null,
};

/**
 * 获取工具的 HTML 模板
 */
function getTemplate() {
    return `
        <div class="view-container--json">
            <!-- 工具栏 -->
            <div class="json-toolbar">
                <div class="json-toolbar-left">
                    <h2 class="json-title">JSON 格式化</h2>
                    <span id="jsonValidBadge" class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full font-medium">Empty</span>
                </div>
                <div class="json-toolbar-actions">
                    <button id="jsonFormatBtn" class="btn btn--primary">
                        <i class="ri-code-s-slash-line"></i> 格式化
                    </button>
                    <button id="jsonCompressBtn" class="btn btn--secondary">
                        <i class="ri-contract-left-right-line"></i> 压缩
                    </button>
                    <button id="jsonClearBtn" class="btn btn--secondary">
                        <i class="ri-delete-bin-line"></i> 清空
                    </button>
                </div>
            </div>

            <!-- 编辑器区域 -->
            <div class="json-editor-container">
                <!-- 输入面板 -->
                <div class="json-editor-panel">
                    <div class="json-editor-header">
                        <span class="json-editor-label">输入</span>
                        <div class="json-editor-actions">
                            <button id="jsonPasteBtn" class="json-editor-btn" title="粘贴">
                                <i class="ri-clipboard-line"></i>
                            </button>
                        </div>
                    </div>
                    <textarea id="jsonInput" class="json-editor-textarea" placeholder="在此粘贴 JSON 数据..."></textarea>
                </div>

                <!-- 输出面板 -->
                <div class="json-editor-panel">
                    <div class="json-editor-header">
                        <span class="json-editor-label">输出</span>
                        <div class="json-editor-actions">
                            <button id="jsonCopyOutputBtn" class="json-editor-btn" title="复制">
                                <i class="ri-file-copy-line"></i>
                            </button>
                        </div>
                    </div>
                    <div id="jsonOutput" class="json-editor-output"></div>
                </div>
            </div>

            <!-- 状态栏 -->
            <div class="json-statusbar">
                <div id="jsonStatus" class="json-status-left">
                    <i class="ri-info-line"></i>
                    <span>粘贴 JSON 内容开始</span>
                </div>
                <div class="json-status-right">
                    缩进: ${jsonState.indent} 空格
                </div>
            </div>
        </div>
    `;
}

/**
 * 获取工具的 CSS 样式
 */


/**
 * 初始化 JSON 格式化工具
 */
export function initJsonFormatterTool() {
    // 清理之前的事件监听器
    if (jsonState.abortController) {
        jsonState.abortController.abort();
    }
    jsonState.abortController = new AbortController();
    const { signal } = jsonState.abortController;

    const inputArea = document.getElementById('jsonInput');
    const outputArea = document.getElementById('jsonOutput');
    const formatBtn = document.getElementById('jsonFormatBtn');
    const compressBtn = document.getElementById('jsonCompressBtn');
    const copyOutputBtn = document.getElementById('jsonCopyOutputBtn');
    const clearBtn = document.getElementById('jsonClearBtn');
    const pasteBtn = document.getElementById('jsonPasteBtn');

    if (!inputArea) return;

    // 输入实时校验
    inputArea.addEventListener('input', () => {
        jsonState.currentInput = inputArea.value;
        validateAndFormat();
    }, { signal });

    // 格式化按钮
    if (formatBtn) {
        formatBtn.addEventListener('click', () => {
            formatJson();
        }, { signal });
    }

    // 压缩按钮
    if (compressBtn) {
        compressBtn.addEventListener('click', () => {
            compressJson();
        }, { signal });
    }

    // 复制输出按钮
    if (copyOutputBtn) {
        copyOutputBtn.addEventListener('click', () => {
            copyToClipboard(jsonState.currentOutput);
        }, { signal });
    }

    // 粘贴按钮
    if (pasteBtn) {
        pasteBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                inputArea.value = text;
                jsonState.currentInput = text;
                validateAndFormat();
            } catch (err) {
                console.error('无法读取剪贴板:', err);
            }
        }, { signal });
    }

    // 清空按钮
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            inputArea.value = '';
            outputArea.innerHTML = '';
            jsonState.currentInput = '';
            jsonState.currentOutput = '';
            jsonState.isValid = false;
            updateStatus();
        }, { signal });
    }

    updateStatus();
}

function validateAndFormat() {
    const input = jsonState.currentInput.trim();

    if (!input) {
        jsonState.isValid = false;
        jsonState.currentOutput = '';
        updateStatus();
        return;
    }

    try {
        const parsed = JSON.parse(input);
        jsonState.isValid = true;
        const formatted = JSON.stringify(parsed, null, jsonState.indent);
        jsonState.currentOutput = formatted;
        renderOutput(formatted);
        updateStatus();
    } catch (error) {
        jsonState.isValid = false;
        jsonState.currentOutput = '';
        updateStatus(error.message);
    }
}

function formatJson() {
    validateAndFormat();
}

function compressJson() {
    const input = jsonState.currentInput.trim();

    if (!input) {
        updateStatus('输入为空');
        return;
    }

    try {
        const parsed = JSON.parse(input);
        const compressed = JSON.stringify(parsed);
        jsonState.currentOutput = compressed;
        jsonState.isValid = true;
        renderOutput(compressed, true);
        updateStatus();
    } catch (error) {
        jsonState.isValid = false;
        updateStatus(error.message);
    }
}

function renderOutput(text, isCompressed = false) {
    const outputArea = document.getElementById('jsonOutput');
    if (!outputArea) return;

    if (isCompressed) {
        outputArea.innerHTML = `<div class="text-slate-600">${escapeHtml(text)}</div>`;
        return;
    }

    // 格式化模式：带着色显示
    const lines = text.split('\n');
    let html = '';

    lines.forEach((line) => {
        const colored = syntaxHighlight(line);
        html += colored;
    });

    outputArea.innerHTML = html;
    outputArea.querySelectorAll('.json-output-line[data-indent]').forEach(outputLine => {
        outputLine.style.paddingLeft = `${outputLine.dataset.indent}em`;
    });
}

function syntaxHighlight(line) {
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    const content = line.substring(indent);

    let highlighted = escapeHtml(content);

    // 字符串和键值对
    highlighted = highlighted.replace(/"([^"\\]|\\.)*"/g, (match) => {
        if (/:\s*/.test(highlighted.substring(highlighted.indexOf(match) + match.length))) {
            return `<span class="text-purple-600">${match}</span>`;
        }
        return `<span class="text-green-600">${match}</span>`;
    });

    // 布尔值和null
    highlighted = highlighted.replace(/\b(true|false|null)\b/g, '<span class="text-orange-600">$1</span>');

    // 数字
    highlighted = highlighted.replace(/:\s*(-?\d+\.?\d*([eE][+-]?\d+)?)/g, ': <span class="text-blue-600">$1</span>');

    // 括号
    highlighted = highlighted.replace(/[{[\]},]/g, (m) => `<span class="text-slate-500">${m}</span>`);

    const paddingLeft = indent * 0.5;
    return `<div class="json-output-line" data-indent="${paddingLeft}">${highlighted}</div>`;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function copyToClipboard(text) {
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('jsonCopyOutputBtn');
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '<i class="ri-check-line"></i>';
            setTimeout(() => {
                btn.innerHTML = orig;
            }, 2000);
        }
    });
}

function updateStatus(errorMsg = null) {
    const statusDisplay = document.getElementById('jsonStatus');
    const validBadge = document.getElementById('jsonValidBadge');

    if (!statusDisplay) return;

    if (errorMsg) {
        statusDisplay.innerHTML = `<i class="ri-error-warning-line text-red-500"></i><span class="text-red-600">JSON 解析失败</span>`;
        if (validBadge) {
            validBadge.className = 'px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-medium';
            validBadge.textContent = 'Invalid';
        }
    } else if (jsonState.isValid) {
        const lines = jsonState.currentOutput.split('\n').length;
        statusDisplay.innerHTML = `<i class="ri-check-double-line json-status__success-icon"></i><span>JSON 解析成功 • ${lines} 行 • UTF-8</span>`;
        if (validBadge) {
            validBadge.className = 'px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full font-medium';
            validBadge.textContent = 'Valid';
        }
    } else {
        statusDisplay.innerHTML = `<i class="ri-info-line"></i><span>粘贴 JSON 内容开始</span>`;
        if (validBadge) {
            validBadge.className = 'px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full font-medium';
            validBadge.textContent = 'Empty';
        }
    }
}

export function destroyJsonFormatterTool() {
    // 清理事件监听器
    if (jsonState.abortController) {
        jsonState.abortController.abort();
        jsonState.abortController = null;
    }
    jsonState.currentInput = '';
    jsonState.currentOutput = '';
    jsonState.isValid = false;
    jsonState.indent = 2;
}

registerTool({
    id: 'json-formatter',
    name: 'JSON 格式化',
    icon: 'ri-braces-line',
    colorClass: 'tool-card__icon--orange',
    category: 'dev',
    description: '格式化、美化和验证 JSON 数据',
    template: getTemplate,
    init: initJsonFormatterTool,
    destroy: destroyJsonFormatterTool
});
