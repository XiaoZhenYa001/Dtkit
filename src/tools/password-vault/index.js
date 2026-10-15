import { registerTool } from '../toolRegistry.js';
import { mainTemplate, quickTemplate } from './view.js';
import { initializePasswordVault, destroyPasswordVault, serialize, restore } from './runtime.js';
import '../../css/tools/password-vault.css';

registerTool({
    id: 'password-vault', name: '密码', icon: 'ri-lock-2-line', colorClass: 'tool-card__icon--orange',
    category: 'utility', status: 'ready',
    description: '由当前 Windows 用户保护的本机密码库，支持搜索、导入导出与安全复制。',
    template: location.pathname.toLowerCase().endsWith('/quick.html') ? quickTemplate : mainTemplate,
    init: initializePasswordVault, destroy: destroyPasswordVault, serialize, restore
});
export { destroyPasswordVault, initializePasswordVault };
