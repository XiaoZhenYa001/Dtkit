import { registerTool } from './toolRegistry.js';

let jsonState = {
    currentInput: '',
    currentOutput: '',
    isValid: false,
    indent: 2,
};

export function initJsonFormatterTool() {
    const inputArea = document.getElementById('jsonInput');
    const outputArea = document.getElementById('jsonOutput');
    const formatBtn = document.getElementById('jsonFormatBtn');
    const compressBtn = document.getElementById('jsonCompressBtn');
    const copyOutputBtn = document.getElementById('jsonCopyOutputBtn');
    const clearBtn = document.getElementById('jsonClearBtn');

    if (!inputArea) return;

    // 输入实时校验
    inputArea.addEventListener('input', () => {
        jsonState.currentInput = inputArea.value;
        validateAndFormat();
    });

    // 格式化按钮
    if (formatBtn) {
        formatBtn.addEventListener('click', () => {
            formatJson();
        });
    }

    // 压缩按钮
    if (compressBtn) {
        compressBtn.addEventListener('click', () => {
            compressJson();
        });
    }

    // 复制输出按钮
    if (copyOutputBtn) {
        copyOutputBtn.addEventListener('click', () => {
            copyToClipboard(jsonState.currentOutput);
        });
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
        });
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

    const paddingClass = Math.min(Math.floor(indent / 2), 12);
    return `<div class="pl-${paddingClass}">${highlighted}</div>`;
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
            btn.innerHTML = '<i class="ri-check-line"></i> 已复制';
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
        statusDisplay.innerHTML = `<i class="ri-error-warning-line text-red-500 mr-1"></i><span class="text-red-600">JSON 解析失败</span>`;
        if (validBadge) {
            validBadge.className = 'px-2 py-0.5 bg-red-100 text-red-700 text-[10px] rounded-full font-medium';
            validBadge.innerHTML = 'Invalid';
        }
    } else if (jsonState.isValid) {
        const lines = jsonState.currentOutput.split('\n').length;
        statusDisplay.innerHTML = `<i class="ri-check-double-line text-green-500 mr-1"></i><span>JSON 解析成功 • ${lines} 行 • UTF-8</span>`;
        if (validBadge) {
            validBadge.className = 'px-2 py-0.5 bg-green-100 text-green-700 text-[10px] rounded-full font-medium';
            validBadge.innerHTML = 'Valid';
        }
    } else {
        statusDisplay.innerHTML = `<i class="ri-info-line text-slate-400 mr-1"></i><span class="text-slate-500">粘贴 JSON 内容开始</span>`;
        if (validBadge) {
            validBadge.className = 'px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] rounded-full font-medium';
            validBadge.innerHTML = 'Empty';
        }
    }
}

export function destroyJsonFormatterTool() {
    jsonState = {
        currentInput: '',
        currentOutput: '',
        isValid: false,
        indent: 2,
    };
}

registerTool({
    id: 'json-formatter',
    name: 'JSON 格式化',
    icon: 'ri-braces-line',
    colorClass: 'tool-card__icon--orange',
    category: 'dev',
    description: '格式化、美化和验证 JSON 数据',
    init: initJsonFormatterTool,
    destroy: destroyJsonFormatterTool
});
