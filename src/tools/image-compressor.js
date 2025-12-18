/**
 * 图片压缩工具
 */
import { registerTool } from './toolRegistry.js';

function initImageCompressorTool() {
    console.log('图片压缩工具已初始化');
}

function destroyImageCompressorTool() {
    console.log('图片压缩工具已销毁');
}

registerTool({
    id: 'image-compressor',
    name: '图片压缩',
    icon: 'ri-image-line',
    colorClass: 'tool-card__icon--indigo',
    category: 'design',
    description: '无损压缩 PNG/JPG，支持批量。',
    init: initImageCompressorTool,
    destroy: destroyImageCompressorTool
});

export { initImageCompressorTool, destroyImageCompressorTool };
