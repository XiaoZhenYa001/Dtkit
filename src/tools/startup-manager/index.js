import { registerTool } from '../toolRegistry.js';
import { createSystemAssistantView } from '../system-assistant/view.js';

registerTool({
    id: 'startup-manager', name: '自启动管理', icon: 'ri-rocket-2-line',
    colorClass: 'tool-card__icon--purple', category: 'utility', status: 'ready',
    description: '检测登录时自动启动的程序，打开文件位置并关闭或恢复自启动。',
    ...createSystemAssistantView({ toolId: 'startup-manager', standalone: true })
});
