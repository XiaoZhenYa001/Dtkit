/**
 * Favicon 生成工具
 */
import { registerTool } from './toolRegistry.js';

function initFaviconGeneratorTool() {
    console.log('Favicon 生成工具已初始化');
}

function destroyFaviconGeneratorTool() {
    console.log('Favicon 生成工具已销毁');
}

registerTool({
    id: 'favicon-generator',
    name: 'Favicon 生成',
    icon: 'ri-file-image-line',
    colorClass: 'tool-card__icon--yellow',
    category: 'design',
    description: '一键生成多尺寸网站图标。',
    init: initFaviconGeneratorTool,
    destroy: destroyFaviconGeneratorTool
});

export { initFaviconGeneratorTool, destroyFaviconGeneratorTool };
