import { registerTool } from './toolRegistry.js';

let base64State = {
    currentText: '',
    currentEncoded: '',
};

export function initBase64Tool() {
    const inputArea = document.getElementById('base64Input');
    const outputArea = document.getElementById('base64Output');
    const encodeBtn = document.getElementById('base64EncodeBtn');
    const decodeBtn = document.getElementById('base64DecodeBtn');
    const copyBtn = document.getElementById('base64CopyBtn');
    const clearBtn = document.getElementById('base64ClearBtn');
    const copyInputBtn = document.getElementById('base64CopyInputBtn');

    if (!inputArea) return;

    // 输入变化时实时转换
    inputArea.addEventListener('input', () => {
        base64State.currentText = inputArea.value;
        autoConvert();
        updateStats();
    });

    // 手动编码
    if (encodeBtn) {
        encodeBtn.addEventListener('click', () => {
            encodeBase64();
        });
    }

    // 手动解码
    if (decodeBtn) {
        decodeBtn.addEventListener('click', () => {
            decodeBase64();
        });
    }

    // 复制输出
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            copyToClipboard(base64State.currentEncoded);
        });
    }

    // 复制输入
    if (copyInputBtn) {
        copyInputBtn.addEventListener('click', () => {
            copyToClipboard(inputArea.value);
        });
    }

    // 清空
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            inputArea.value = '';
            outputArea.value = '';
            base64State.currentText = '';
            base64State.currentEncoded = '';
            updateStats();
        });
    }

    updateStats();
}

function autoConvert() {
    const input = base64State.currentText;
    const outputArea = document.getElementById('base64Output');
    if (!outputArea) return;

    // 尝试自动检测输入是否为 Base64
    if (isBase64(input)) {
        try {
            const decoded = atob(input);
            outputArea.value = decoded;
            base64State.currentEncoded = input;
        } catch (e) {
            encodeBase64();
        }
    } else {
        // 编码普通文本
        try {
            const encoded = btoa(input);
            outputArea.value = encoded;
            base64State.currentEncoded = encoded;
        } catch (e) {
            outputArea.value = '输入包含非 UTF-8 字符';
        }
    }
}

function encodeBase64() {
    const inputArea = document.getElementById('base64Input');
    const outputArea = document.getElementById('base64Output');
    const input = inputArea.value;

    try {
        const encoded = btoa(input);
        outputArea.value = encoded;
        base64State.currentEncoded = encoded;
        updateStats();
    } catch (error) {
        outputArea.value = '❌ 编码失败：' + error.message;
    }
}

function decodeBase64() {
    const inputArea = document.getElementById('base64Input');
    const outputArea = document.getElementById('base64Output');
    const input = inputArea.value;

    try {
        const decoded = atob(input);
        outputArea.value = decoded;
        base64State.currentEncoded = input;
        updateStats();
    } catch (error) {
        outputArea.value = '❌ 解码失败：请确保输入为有效的 Base64 字符串';
    }
}

function isBase64(str) {
    if (!str || str.length === 0) return false;
    if (str.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}

function copyToClipboard(text) {
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
        const btn = event?.target;
        if (btn) {
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="ri-check-line"></i> 已复制';
            setTimeout(() => {
                btn.innerHTML = originalText;
            }, 2000);
        }
    });
}

function updateStats() {
    const inputArea = document.getElementById('base64Input');
    const statsDiv = document.getElementById('base64Stats');

    if (!statsDiv || !inputArea) return;

    const input = inputArea.value;
    const inputSize = new Blob([input]).size;
    const output = document.getElementById('base64Output').value;
    const outputSize = new Blob([output]).size;

    statsDiv.innerHTML = `
        <div class="stat-item">
            <span class="stat-label">输入:</span>
            <span class="stat-value">${input.length} 字符 (${inputSize} 字节)</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">输出:</span>
            <span class="stat-value">${output.length} 字符 (${outputSize} 字节)</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">膨胀比:</span>
            <span class="stat-value">${input.length > 0 ? ((outputSize / inputSize * 100).toFixed(1) + '%') : '-'}</span>
        </div>
    `;
}

export function destroyBase64Tool() {
    base64State = {
        currentText: '',
        currentEncoded: '',
    };
}

registerTool({
    id: 'base64-codec',
    name: 'Base64 编解码',
    icon: 'ri-lock-2-line',
    colorClass: 'tool-card__icon--green',
    category: 'dev',
    description: 'Base64 编码和解码，支持文本和二进制数据',
    init: initBase64Tool,
    destroy: destroyBase64Tool
});
