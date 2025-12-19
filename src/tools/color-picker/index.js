/**
 * 颜色提取器工具
 * HEX, RGB, HSL 格式互转与调色
 */
import { registerTool } from '../toolRegistry.js';

let colorState = {
    currentColor: '#3b82f6',
};

/**
 * 获取工具的 HTML 模板
 */
function getTemplate() {
    return `
        <div class="view-container">
            <div class="color-picker-container">
                <!-- 标题 -->
                <div class="color-picker-header">
                    <h2 class="color-picker-title">颜色提取器</h2>
                    <p class="color-picker-desc">HEX, RGB, HSL 格式互转与调色</p>
                </div>

                <!-- 颜色选择区域 -->
                <div class="color-picker-main">
                    <!-- 颜色预览 -->
                    <div class="color-preview-section">
                        <div id="colorPreview" class="color-preview" style="background-color: #3b82f6;"></div>
                        <input type="color" id="colorInput" class="color-input-native" value="#3b82f6">
                    </div>

                    <!-- 颜色值显示 -->
                    <div class="color-values-section">
                        <div class="color-value-item">
                            <label class="color-value-label">HEX</label>
                            <div class="color-value-input-group">
                                <input type="text" id="hexInput" class="input color-value-input" value="#3b82f6" placeholder="#RRGGBB">
                                <button id="copyHex" class="btn btn--icon" title="复制">
                                    <i class="ri-file-copy-line"></i>
                                </button>
                            </div>
                        </div>

                        <div class="color-value-item">
                            <label class="color-value-label">RGB</label>
                            <div class="color-value-input-group">
                                <input type="text" id="rgbInput" class="input color-value-input" value="rgb(59, 130, 246)" placeholder="rgb(R, G, B)">
                                <button id="copyRgb" class="btn btn--icon" title="复制">
                                    <i class="ri-file-copy-line"></i>
                                </button>
                            </div>
                        </div>

                        <div class="color-value-item">
                            <label class="color-value-label">HSL</label>
                            <div class="color-value-input-group">
                                <input type="text" id="hslInput" class="input color-value-input" value="hsl(217, 91%, 60%)" placeholder="hsl(H, S%, L%)">
                                <button id="copyHsl" class="btn btn--icon" title="复制">
                                    <i class="ri-file-copy-line"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 预设颜色 -->
                <div class="color-presets-section">
                    <h4 class="color-presets-title">常用颜色</h4>
                    <div id="colorPresets" class="color-presets-grid">
                        <!-- 动态生成 -->
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 获取工具的 CSS 样式
 */
function getStyles() {
    return `
        .color-picker-container {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-lg);
            padding: var(--spacing-lg);
            max-width: 600px;
            margin: 0 auto;
        }

        .color-picker-header {
            text-align: center;
        }

        .color-picker-title {
            font-size: var(--font-size-xl);
            font-weight: 600;
            color: var(--color-text-primary);
            margin: 0 0 var(--spacing-xs) 0;
        }

        .color-picker-desc {
            font-size: var(--font-size-sm);
            color: var(--color-text-secondary);
            margin: 0;
        }

        .color-picker-main {
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
            display: flex;
            flex-direction: column;
            gap: var(--spacing-lg);
        }

        .color-preview-section {
            display: flex;
            justify-content: center;
            position: relative;
        }

        .color-preview {
            width: 120px;
            height: 120px;
            border-radius: var(--radius-lg);
            border: 3px solid var(--color-border);
            cursor: pointer;
            transition: transform 0.2s ease;
            box-shadow: var(--shadow-lg);
        }

        .color-preview:hover {
            transform: scale(1.05);
        }

        .color-input-native {
            position: absolute;
            width: 120px;
            height: 120px;
            opacity: 0;
            cursor: pointer;
        }

        .color-values-section {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
        }

        .color-value-item {
            display: flex;
            align-items: center;
            gap: var(--spacing-md);
        }

        .color-value-label {
            font-size: var(--font-size-sm);
            font-weight: 600;
            color: var(--color-text-secondary);
            min-width: 40px;
        }

        .color-value-input-group {
            flex: 1;
            display: flex;
            gap: var(--spacing-sm);
        }

        .color-value-input {
            flex: 1;
            font-family: var(--font-mono);
        }

        .color-presets-section {
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
        }

        .color-presets-title {
            font-size: var(--font-size-sm);
            font-weight: 600;
            color: var(--color-text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin: 0 0 var(--spacing-md) 0;
        }

        .color-presets-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
            gap: var(--spacing-sm);
        }

        .color-preset {
            width: 40px;
            height: 40px;
            border-radius: var(--radius-md);
            border: 2px solid transparent;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .color-preset:hover {
            transform: scale(1.1);
            border-color: var(--color-primary);
        }
    `;
}

// 预设颜色
const presetColors = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
    '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
    '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
    '#ec4899', '#f43f5e', '#64748b', '#1e293b', '#ffffff'
];

/**
 * 初始化颜色选择器工具
 */
function initColorPickerTool() {
    const colorInput = document.getElementById('colorInput');
    const colorPreview = document.getElementById('colorPreview');
    const hexInput = document.getElementById('hexInput');
    const rgbInput = document.getElementById('rgbInput');
    const hslInput = document.getElementById('hslInput');
    const colorPresetsGrid = document.getElementById('colorPresets');
    const copyHex = document.getElementById('copyHex');
    const copyRgb = document.getElementById('copyRgb');
    const copyHsl = document.getElementById('copyHsl');

    if (!colorInput) return;

    console.log('[ColorPicker] 初始化中...');

    // 颜色选择器变化
    colorInput.addEventListener('input', (e) => {
        updateColor(e.target.value);
    });

    // HEX 输入
    hexInput.addEventListener('input', (e) => {
        const hex = e.target.value;
        if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
            updateColor(hex);
        }
    });

    // 复制按钮
    copyHex?.addEventListener('click', () => copyToClipboard(hexInput.value, copyHex));
    copyRgb?.addEventListener('click', () => copyToClipboard(rgbInput.value, copyRgb));
    copyHsl?.addEventListener('click', () => copyToClipboard(hslInput.value, copyHsl));

    // 渲染预设颜色
    colorPresetsGrid.innerHTML = '';
    presetColors.forEach(color => {
        const preset = document.createElement('div');
        preset.className = 'color-preset';
        preset.style.backgroundColor = color;
        preset.title = color;
        preset.addEventListener('click', () => updateColor(color));
        colorPresetsGrid.appendChild(preset);
    });

    // 初始化显示
    updateColor(colorState.currentColor);

    console.log('[ColorPicker] 初始化完成 ✓');
}

function updateColor(hex) {
    colorState.currentColor = hex;

    const colorPreview = document.getElementById('colorPreview');
    const colorInput = document.getElementById('colorInput');
    const hexInput = document.getElementById('hexInput');
    const rgbInput = document.getElementById('rgbInput');
    const hslInput = document.getElementById('hslInput');

    if (colorPreview) colorPreview.style.backgroundColor = hex;
    if (colorInput) colorInput.value = hex;
    if (hexInput) hexInput.value = hex.toUpperCase();

    // 转换为 RGB
    const rgb = hexToRgb(hex);
    if (rgb && rgbInput) {
        rgbInput.value = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    }

    // 转换为 HSL
    if (rgb && hslInput) {
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        hslInput.value = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
    }
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return {
        h: Math.round(h * 360),
        s: Math.round(s * 100),
        l: Math.round(l * 100)
    };
}

function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '<i class="ri-check-line"></i>';
            setTimeout(() => {
                btn.innerHTML = orig;
            }, 1500);
        }
    });
}

function destroyColorPickerTool() {
    console.log('[ColorPicker] 已销毁');
}

// 注册工具
registerTool({
    id: 'color-picker',
    name: '颜色提取器',
    icon: 'ri-palette-line',
    colorClass: 'tool-card__icon--pink',
    category: 'design',
    description: 'HEX, RGB, HSL 格式互转与调色。',
    template: getTemplate,
    styles: getStyles,
    init: initColorPickerTool,
    destroy: destroyColorPickerTool
});

export { initColorPickerTool, destroyColorPickerTool };
