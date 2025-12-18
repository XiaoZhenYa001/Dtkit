/**
 * Crontab 解释工具
 */
import { registerTool } from './toolRegistry.js';

function initCrontabExplainerTool() {
    console.log('Crontab 解释工具已初始化');
}

function destroyCrontabExplainerTool() {
    console.log('Crontab 解释工具已销毁');
}

registerTool({
    id: 'crontab-explainer',
    name: 'Crontab 解释',
    icon: 'ri-terminal-box-line',
    colorClass: 'tool-card__icon--rose',
    category: 'other',
    description: '翻译复杂的 Cron 表达式。',
    init: initCrontabExplainerTool,
    destroy: destroyCrontabExplainerTool
});

export { initCrontabExplainerTool, destroyCrontabExplainerTool };
