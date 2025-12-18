/**
 * Hash 计算工具
 * 计算文本或文件的哈希值 (MD5, SHA-1, SHA-256 等)
 */
import { registerTool } from './toolRegistry.js';

/**
 * 初始化 Hash 计算工具
 */
function initHashCalculator() {
    // TODO: 实现 Hash 计算逻辑
    console.log('[Hash Calculator] 工具初始化');
}

/**
 * 销毁工具
 */
function destroyHashCalculator() {
    // TODO: 清理资源
}

// 注册工具
registerTool({
    id: 'hash-calculator',
    name: 'MD5 / Hash',
    icon: 'ri-hashtag',
    colorClass: 'tool-card__icon--teal',
    category: 'other',
    description: '计算文本或文件的哈希值。',
    init: initHashCalculator,
    destroy: destroyHashCalculator
});

export { initHashCalculator, destroyHashCalculator };
