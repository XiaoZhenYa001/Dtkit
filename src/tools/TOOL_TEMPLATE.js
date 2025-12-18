/**
 * ⚠️ 工具开发模板
 * 
 * 使用说明：
 * 1. 复制此文件并重命名为你的工具名 (kebab-case)
 * 2. 替换所有的 "ToolName" 为你的工具名 (camelCase)
 * 3. 替换所有的 "tool-name" 为你的工具 ID (kebab-case)
 * 4. 实现初始化和销毁逻辑
 * 5. 在 index.js 中导入此文件
 * 
 * 示例：
 * - 文件名: my-awesome-tool.js
 * - 函数名: initMyAwesomeTool()
 * - 工具 ID: my-awesome-tool
 */

import { registerTool } from './toolRegistry.js';

// ============================================
// 工具状态（如需保存状态）
// ============================================
let toolState = {
    // 示例：
    // data: [],
    // lastUpdate: null
};

// ============================================
// 初始化函数 - 工具展示时被调用
// ============================================
function initToolName() {
    // ⚠️ 重要：始终先检查必要的 DOM 元素是否存在
    const inputEl = document.getElementById('toolNameInput');
    const outputEl = document.getElementById('toolNameOutput');
    const actionBtn = document.getElementById('toolNameActionBtn');
    
    if (!inputEl || !outputEl || !actionBtn) {
        console.warn('[ToolName] 必要的 DOM 元素未找到，请检查 index.html');
        return;
    }
    
    console.log('[ToolName] 初始化开始...');
    
    // 定义事件处理函数
    function handleAction() {
        const input = inputEl.value.trim();
        
        // 验证输入
        if (!input) {
            outputEl.textContent = '请输入内容';
            outputEl.className = 'result-box result-box--error';
            return;
        }
        
        try {
            // 你的业务逻辑
            const result = processData(input);
            
            // 显示结果
            outputEl.textContent = result;
            outputEl.className = 'result-box result-box--success';
        } catch (error) {
            outputEl.textContent = `❌ 错误: ${error.message}`;
            outputEl.className = 'result-box result-box--error';
        }
    }
    
    // 绑定事件监听
    actionBtn.addEventListener('click', handleAction);
    inputEl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleAction();
    });
    
    // 初始化状态
    toolState = {
        initialized: true,
        lastAction: null
    };
    
    console.log('[ToolName] 初始化完成 ✓');
}

// ============================================
// 销毁函数 - 工具关闭时被调用
// ============================================
function destroyToolName() {
    console.log('[ToolName] 销毁中...');
    
    // ⚠️ 重要：移除事件监听器
    const actionBtn = document.getElementById('toolNameActionBtn');
    const inputEl = document.getElementById('toolNameInput');
    
    if (actionBtn && inputEl) {
        // 注意：此方式不能移除匿名函数，建议在上面定义具名函数
        // 或使用其他事件管理方式
    }
    
    // 清理状态
    toolState = null;
    
    console.log('[ToolName] 销毁完成 ✓');
}

// ============================================
// 业务逻辑函数
// ============================================
/**
 * 处理数据的核心函数
 * @param {string} input - 输入数据
 * @returns {string} 处理结果
 */
function processData(input) {
    // 实现你的业务逻辑
    // 示例：转换为大写
    return input.toUpperCase();
}

// ============================================
// 其他辅助函数
// ============================================
// 在这里添加其他辅助函数...

// ============================================
// 注册工具到注册中心
// ============================================
registerTool({
    id: 'tool-name',                          // 工具唯一标识 (kebab-case)
    name: 'Tool Name',                         // 显示名称
    icon: 'ri-star-line',                      // Remixicon 图标
    colorClass: 'tool-card__icon--blue',       // CSS 颜色类
    category: 'dev',                           // 分类: 'dev'|'design'|'other'
    description: 'Tool description goes here', // 工具描述
    init: initToolName,                        // 初始化函数
    destroy: destroyToolName                   // 销毁函数
});

// ============================================
// 导出（便于调试和测试）
// ============================================
export { initToolName, destroyToolName, processData };

// ============================================
// 使用检查清单
// ============================================
/*
在完成工具开发后，请检查以下项目：

□ 修改了所有的 "ToolName" 和 "tool-name"
□ 在 index.html 中添加了工具视图 HTML
  - 工具视图 ID 必须是 "toolNameView" (camelCase)
  - DOM 元素 ID 与 init() 中使用的一致
□ 在 main.js 中的 DOM 缓存添加了工具视图元素
□ 在 main.js 中的 updateContentView() 添加了视图切换逻辑
□ 在 tools/index.js 中添加了 import 语句
□ 测试了工具的初始化功能
□ 测试了工具的销毁功能（切换到其他工具）
□ 检查了是否有内存泄漏（定时器、事件监听未清理）
□ 添加了错误处理和输入验证
□ 代码添加了必要的注释

详见: DEVELOPMENT.md
*/
