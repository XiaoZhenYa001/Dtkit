import '../../css/tools/color-picker.css';
/**
 * 颜色提取器工具
 * HEX, RGB, HSL 格式互转与调色
 */
import { registerTool } from '../toolRegistry.js';

let colorState = {
    currentColor: '#3b82f6',
    abortController: null,
};

/**
 * 获取工具的 HTML 模板
 */
function getTemplate() {
    return `
        <div class="view-container">
            <div class="color-picker-container">
                <!-- 颜色选择主区域 -->
                <div class="color-picker-main">
                    <!-- 颜色预览 -->
                    <div class="color-preview-section">
                        <div class="color-preview-wrapper">
                            <div id="colorPreview" class="color-preview"></div>
                            <input type="color" id="colorInput" class="color-input-native" value="#3b82f6">
                            <div class="color-preview-hint">点击选择颜色</div>
                        </div>
                    </div>

                    <!-- 颜色值显示 -->
                    <div class="color-values-section">
                        <div class="color-value-item">
                            <label class="color-value-label">HEX</label>
                            <div class="color-value-input-group">
                                <input type="text" id="hexInput" class="input color-value-input" value="#3B82F6" placeholder="#RRGGBB">
                                <button id="copyHex" class="btn btn--icon btn--copy-color" title="复制">
                                    <i class="ri-file-copy-line"></i>
                                </button>
                            </div>
                        </div>

                        <div class="color-value-item">
                            <label class="color-value-label">RGB</label>
                            <div class="color-value-input-group">
                                <input type="text" id="rgbInput" class="input color-value-input" value="rgb(59, 130, 246)" placeholder="rgb(R, G, B)">
                                <button id="copyRgb" class="btn btn--icon btn--copy-color" title="复制">
                                    <i class="ri-file-copy-line"></i>
                                </button>
                            </div>
                        </div>

                        <div class="color-value-item">
                            <label class="color-value-label">HSL</label>
                            <div class="color-value-input-group">
                                <input type="text" id="hslInput" class="input color-value-input" value="hsl(217, 91%, 60%)" placeholder="hsl(H, S%, L%)">
                                <button id="copyHsl" class="btn btn--icon btn--copy-color" title="复制">
                                    <i class="ri-file-copy-line"></i>
                                </button>
                            </div>
                        </div>

                        <div class="color-value-item">
                            <label class="color-value-label">RGBA</label>
                            <div class="color-value-input-group">
                                <input type="text" id="rgbaInput" class="input color-value-input" value="rgba(59, 130, 246, 1)" placeholder="rgba(R, G, B, A)">
                                <button id="copyRgba" class="btn btn--icon btn--copy-color" title="复制">
                                    <i class="ri-file-copy-line"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 色调变化 -->
                <div class="color-shades-section">
                    <h4 class="section-title"><i class="ri-contrast-2-line"></i> 色调变化</h4>
                    <div id="colorShades" class="color-shades-grid">
                        <!-- 动态生成 -->
                    </div>
                </div>

                <!-- 预设颜色 -->
                <div class="color-presets-section">
                    <h4 class="section-title"><i class="ri-palette-line"></i> 常用颜色</h4>
                    <div id="colorPresets" class="color-presets-grid">
                        <!-- 动态生成 -->
                    </div>
                </div>

                <!-- 最近使用 -->
                <div class="color-recent-section">
                    <h4 class="section-title"><i class="ri-history-line"></i> 最近使用</h4>
                    <div id="recentColors" class="color-recent-grid">
                        <div class="color-recent-empty">暂无记录</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 获取工具的 CSS 样式
 */


// 预设颜色
const presetColors = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
    '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
    '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
    '#ec4899', '#f43f5e', '#64748b', '#1e293b', '#ffffff'
];

// 最近使用的颜色（最多保存10个）
let recentColors = [];

/**
 * 初始化颜色选择器工具
 */
function initColorPickerTool() {
    // 清理之前的事件监听器
    if (colorState.abortController) {
        colorState.abortController.abort();
    }
    colorState.abortController = new AbortController();
    const { signal } = colorState.abortController;

    const colorInput = document.getElementById('colorInput');
    const colorPreview = document.getElementById('colorPreview');
    const hexInput = document.getElementById('hexInput');
    const rgbInput = document.getElementById('rgbInput');
    const hslInput = document.getElementById('hslInput');
    const rgbaInput = document.getElementById('rgbaInput');
    const colorPresetsGrid = document.getElementById('colorPresets');
    const colorShadesGrid = document.getElementById('colorShades');
    const recentColorsGrid = document.getElementById('recentColors');
    const copyHex = document.getElementById('copyHex');
    const copyRgb = document.getElementById('copyRgb');
    const copyHsl = document.getElementById('copyHsl');
    const copyRgba = document.getElementById('copyRgba');

    if (!colorInput) return;

    console.log('[ColorPicker] 初始化中...');

    // 加载最近使用的颜色
    try {
        const saved = localStorage.getItem('colorPickerRecent');
        if (saved) {
            recentColors = JSON.parse(saved);
        }
    } catch (e) {
        recentColors = [];
    }

    // 颜色选择器变化
    colorInput.addEventListener('input', (e) => {
        updateColor(e.target.value, true);
    }, { signal });

    // HEX 输入
    hexInput.addEventListener('input', (e) => {
        const hex = e.target.value;
        if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
            updateColor(hex, false);
        }
    }, { signal });

    // RGB 输入
    rgbInput.addEventListener('input', (e) => {
        const match = e.target.value.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
        if (match) {
            const hex = rgbToHex(parseInt(match[1]), parseInt(match[2]), parseInt(match[3]));
            updateColor(hex, false);
        }
    }, { signal });

    // 复制按钮
    copyHex?.addEventListener('click', () => copyToClipboard(hexInput.value, copyHex), { signal });
    copyRgb?.addEventListener('click', () => copyToClipboard(rgbInput.value, copyRgb), { signal });
    copyHsl?.addEventListener('click', () => copyToClipboard(hslInput.value, copyHsl), { signal });
    copyRgba?.addEventListener('click', () => copyToClipboard(rgbaInput.value, copyRgba), { signal });

    // 渲染预设颜色
    renderPresetColors(colorPresetsGrid, signal);

    // 渲染最近使用
    renderRecentColors(recentColorsGrid);
    initRecentColorsEvents(recentColorsGrid, signal);

    // 初始化色调点击事件委托
    initColorShadesEvents(signal);

    // 初始化显示
    updateColor(colorState.currentColor, false);

    console.log('[ColorPicker] 初始化完成 ✓');
}

function renderPresetColors(grid, signal) {
    if (!grid) return;
    grid.innerHTML = '';
    presetColors.forEach(color => {
        const preset = document.createElement('div');
        preset.className = 'color-preset';
        preset.style.backgroundColor = color;
        preset.title = color;
        preset.dataset.color = color;
        grid.appendChild(preset);
    });

    // 使用事件委托处理预设颜色点击
    grid.addEventListener('click', (e) => {
        const preset = e.target.closest('.color-preset');
        if (preset && preset.dataset.color) {
            updateColor(preset.dataset.color, true);
        }
    }, { signal });
}

function renderRecentColors(grid) {
    if (!grid) return;

    if (recentColors.length === 0) {
        grid.innerHTML = '<div class="color-recent-empty">暂无记录</div>';
        return;
    }

    grid.innerHTML = '';
    recentColors.forEach(color => {
        const item = document.createElement('div');
        item.className = 'color-recent';
        item.style.backgroundColor = color;
        item.title = color;
        item.dataset.color = color;
        grid.appendChild(item);
    });
}

// 初始化最近使用点击事件委托（只调用一次）
function initRecentColorsEvents(grid, signal) {
    if (!grid) return;

    grid.addEventListener('click', (e) => {
        const item = e.target.closest('.color-recent');
        if (item && item.dataset.color) {
            updateColor(item.dataset.color, false);
        }
    }, { signal });
}

function renderColorShades(hex) {
    const grid = document.getElementById('colorShades');
    if (!grid) return;

    const rgb = hexToRgb(hex);
    if (!rgb) return;

    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

    // 生成9个不同亮度的色调
    grid.innerHTML = '';
    const lightnesses = [95, 85, 70, 55, 45, 35, 25, 15, 5];

    lightnesses.forEach(l => {
        const shade = document.createElement('div');
        shade.className = 'color-shade';
        const shadeColor = `hsl(${hsl.h}, ${hsl.s}%, ${l}%)`;
        shade.style.backgroundColor = shadeColor;
        shade.title = shadeColor;
        shade.dataset.color = hslToHex(hsl.h, hsl.s, l);
        grid.appendChild(shade);
    });
}

// 初始化色调点击事件委托（只调用一次）
function initColorShadesEvents(signal) {
    const grid = document.getElementById('colorShades');
    if (!grid) return;

    grid.addEventListener('click', (e) => {
        const shade = e.target.closest('.color-shade');
        if (shade && shade.dataset.color) {
            updateColor(shade.dataset.color, true);
        }
    }, { signal });
}

function addToRecentColors(hex) {
    // 移除已存在的相同颜色
    recentColors = recentColors.filter(c => c.toLowerCase() !== hex.toLowerCase());
    // 添加到开头
    recentColors.unshift(hex.toUpperCase());
    // 限制数量
    if (recentColors.length > 10) {
        recentColors = recentColors.slice(0, 10);
    }
    // 保存
    try {
        localStorage.setItem('colorPickerRecent', JSON.stringify(recentColors));
    } catch (e) {
        // ignore
    }
    // 更新显示（事件委托已在初始化时绑定，只需重新渲染DOM）
    const grid = document.getElementById('recentColors');
    if (grid) {
        renderRecentColors(grid);
    }
}

function updateColor(hex, addRecent = false) {
    colorState.currentColor = hex;

    const colorPreview = document.getElementById('colorPreview');
    const colorInput = document.getElementById('colorInput');
    const hexInput = document.getElementById('hexInput');
    const rgbInput = document.getElementById('rgbInput');
    const hslInput = document.getElementById('hslInput');
    const rgbaInput = document.getElementById('rgbaInput');

    if (colorPreview) colorPreview.style.backgroundColor = hex;
    if (colorInput) colorInput.value = hex;
    if (hexInput) hexInput.value = hex.toUpperCase();

    // 转换为 RGB
    const rgb = hexToRgb(hex);
    if (rgb && rgbInput) {
        rgbInput.value = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    }

    // RGBA
    if (rgb && rgbaInput) {
        rgbaInput.value = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1)`;
    }

    // 转换为 HSL
    if (rgb && hslInput) {
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        hslInput.value = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
    }

    // 更新色调变化
    renderColorShades(hex);

    // 添加到最近使用
    if (addRecent) {
        addToRecentColors(hex);
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

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = Math.max(0, Math.min(255, x)).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('').toUpperCase();
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

function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
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
    // 清理事件监听器
    if (colorState.abortController) {
        colorState.abortController.abort();
        colorState.abortController = null;
    }
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
    init: initColorPickerTool,
    destroy: destroyColorPickerTool
});

export { initColorPickerTool, destroyColorPickerTool };
