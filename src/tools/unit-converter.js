/**
 * 单位换算工具
 */
import { registerTool } from './toolRegistry.js';

function initUnitConverterTool() {
    console.log('单位换算工具已初始化');
}

function destroyUnitConverterTool() {
    console.log('单位换算工具已销毁');
}

registerTool({
    id: 'unit-converter',
    name: '单位换算',
    icon: 'ri-calculator-line',
    colorClass: 'tool-card__icon--slate',
    category: 'other',
    description: '字节、长度、温度等转换。',
    init: initUnitConverterTool,
    destroy: destroyUnitConverterTool
});

export { initUnitConverterTool, destroyUnitConverterTool };
