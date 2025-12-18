/**
 * ⚠️ 工具开发模板 - 新架构版本
 * 
 * ========================================
 * 使用说明：
 * ========================================
 * 
 * 1. 在 tools/ 目录下创建新文件夹，如：tools/my-awesome-tool/
 * 
 * 2. 将此文件复制到该文件夹并重命名为 index.js
 * 
 * 3. 替换以下内容：
 *    - "my-awesome-tool" → 你的工具 ID (kebab-case)
 *    - "MyAwesomeTool" → 你的工具名 (PascalCase，用于函数名)
 *    - "我的工具" → 工具显示名称
 *    - 修改 getTemplate() 返回的 HTML
 *    - 修改 getStyles() 返回的 CSS
 *    - 实现 init 和 destroy 函数
 * 
 * 4. 在 tools/index.js 中添加导入：
 *    import './my-awesome-tool/index.js';
 * 
 * 这就完成了！无需修改 index.html 或 main.js
 * 
 * ========================================
 * 文件结构：
 * ========================================
 * 
 * tools/
 *   my-awesome-tool/
 *     index.js          ← 主文件（包含 HTML、CSS、JS）
 *     
 * 如果工具比较复杂，也可以拆分：
 * 
 * tools/
 *   my-awesome-tool/
 *     index.js          ← 导出和注册
 *     template.js       ← HTML 模板
 *     styles.js         ← CSS 样式
 *     logic.js          ← 业务逻辑
 * 
 */

import { registerTool } from '../toolRegistry.js';

// ============================================
// 工具状态（如需保存状态）
// ============================================
let toolState = {
    // 示例：
    // data: [],
    // lastUpdate: null
};

// ============================================
// HTML 模板
// ============================================
function getTemplate() {
    return `
        <div class="view-container">
            <div class="my-tool-container">
                <!-- 工具标题区域 -->
                <div class="my-tool-header">
                    <h2 class="my-tool-title">我的工具</h2>
                    <p class="my-tool-desc">这是工具的描述文字</p>
                </div>

                <!-- 主要内容区域 -->
                <div class="my-tool-content">
                    <div class="input-group">
                        <label class="label">输入</label>
                        <input type="text" id="myToolInput" class="input" placeholder="请输入内容...">
                    </div>
                    
                    <div class="button-group">
                        <button id="myToolActionBtn" class="btn btn--primary">
                            <i class="ri-play-line"></i> 执行
                        </button>
                        <button id="myToolClearBtn" class="btn btn--secondary">
                            <i class="ri-delete-bin-line"></i> 清空
                        </button>
                    </div>
                    
                    <div class="input-group">
                        <label class="label">输出</label>
                        <div id="myToolOutput" class="result-box">
                            等待输入...
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ============================================
// CSS 样式
// ============================================
function getStyles() {
    return `
        .my-tool-container {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-lg);
            padding: var(--spacing-lg);
            max-width: 800px;
            margin: 0 auto;
        }

        .my-tool-header {
            text-align: center;
            padding: var(--spacing-md);
        }

        .my-tool-title {
            font-size: var(--font-size-xl);
            font-weight: 600;
            color: var(--color-text-primary);
            margin: 0 0 var(--spacing-xs) 0;
        }

        .my-tool-desc {
            font-size: var(--font-size-sm);
            color: var(--color-text-secondary);
            margin: 0;
        }

        .my-tool-content {
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
        }

        .result-box {
            background: var(--color-bg-tertiary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            padding: var(--spacing-md);
            font-family: var(--font-mono);
            font-size: var(--font-size-sm);
            min-height: 60px;
            color: var(--color-text-secondary);
        }

        .result-box--success {
            background: rgba(34, 197, 94, 0.1);
            border-color: rgba(34, 197, 94, 0.3);
            color: var(--color-text-primary);
        }

        .result-box--error {
            background: rgba(239, 68, 68, 0.1);
            border-color: rgba(239, 68, 68, 0.3);
            color: #ef4444;
        }
    `;
}

// ============================================
// 初始化函数 - 工具展示时被调用
// ============================================
function initMyAwesomeTool() {
    const inputEl = document.getElementById('myToolInput');
    const outputEl = document.getElementById('myToolOutput');
    const actionBtn = document.getElementById('myToolActionBtn');
    const clearBtn = document.getElementById('myToolClearBtn');
    
    // ⚠️ 重要：始终先检查必要的 DOM 元素是否存在
    if (!inputEl || !outputEl || !actionBtn) {
        console.warn('[MyAwesomeTool] 必要的 DOM 元素未找到');
        return;
    }
    
    console.log('[MyAwesomeTool] 初始化开始...');
    
    // 定义事件处理函数
    function handleAction() {
        const input = inputEl.value.trim();
        
        // 验证输入
        if (!input) {
            outputEl.textContent = '❌ 请输入内容';
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
    
    function handleClear() {
        inputEl.value = '';
        outputEl.textContent = '等待输入...';
        outputEl.className = 'result-box';
    }
    
    // 绑定事件监听
    actionBtn.addEventListener('click', handleAction);
    clearBtn?.addEventListener('click', handleClear);
    inputEl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleAction();
    });
    
    // 初始化状态
    toolState = {
        initialized: true,
        lastAction: null
    };
    
    console.log('[MyAwesomeTool] 初始化完成 ✓');
}

// ============================================
// 销毁函数 - 工具关闭时被调用
// ============================================
function destroyMyAwesomeTool() {
    console.log('[MyAwesomeTool] 销毁中...');
    
    // 清理状态
    toolState = {};
    
    console.log('[MyAwesomeTool] 已销毁');
}

// ============================================
// 业务逻辑函数
// ============================================
function processData(input) {
    // 在这里实现你的业务逻辑
    // 示例：将输入转换为大写
    return input.toUpperCase();
}

// ============================================
// 注册工具
// ============================================
registerTool({
    id: 'my-awesome-tool',           // 工具唯一 ID (kebab-case)
    name: '我的工具',                 // 工具显示名称
    icon: 'ri-tools-line',           // 图标类名 (Remix Icon)
    colorClass: 'tool-card__icon--blue',  // 卡片颜色
    category: 'other',               // 分类: dev / design / other
    description: '这是一个工具模板示例',  // 工具描述
    template: getTemplate,           // HTML 模板函数
    styles: getStyles,               // CSS 样式函数
    init: initMyAwesomeTool,         // 初始化函数
    destroy: destroyMyAwesomeTool    // 销毁函数
});

// 导出以便其他模块引用（可选）
export { initMyAwesomeTool, destroyMyAwesomeTool };
