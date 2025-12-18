/**
 * 颜色提取器工具
 */
import { registerTool } from './toolRegistry.js';

function initColorPickerTool() {
    console.log('颜色提取器工具已初始化');
}

function destroyColorPickerTool() {
    console.log('颜色提取器工具已销毁');
}

registerTool({
    id: 'color-picker',
    name: '颜色提取器',
    icon: 'ri-palette-line',
    colorClass: 'tool-card__icon--pink',
    category: 'design',
    description: 'HEX, RGB, HSL 格式互转与调色。',
    init: initColorPickerTool,
    destroy: destroyColorPickerTool
});

export { initColorPickerTool, destroyColorPickerTool };
