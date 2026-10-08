import { registerTool } from '../toolRegistry.js';
import { createSystemAssistantView } from './view.js';

const view = createSystemAssistantView({ toolId: 'system-assistant' });

registerTool({
    id: 'system-assistant', name: '系统助手', icon: 'ri-windows-line',
    colorClass: 'tool-card__icon--purple', category: 'utility', status: 'ready',
    description: '按需检测并安全管理开机启动项，后续系统小功能统一在这里扩展。',
    ...view
});

export const initializeSystemAssistant = view.init;
export const destroySystemAssistant = view.destroy;
