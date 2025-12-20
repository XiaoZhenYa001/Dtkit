/**
 * 工具注册中心
 * 管理所有工具的注册、获取、初始化和模板管理
 * 
 * 新架构特性：
 * - 每个工具包含自己的 HTML 模板和 CSS 样式
 * - 动态注入工具视图到 DOM
 * - 自动管理样式注入/移除
 */

// 工具存储
const toolsRegistry = new Map();

// 已注入的样式表 ID 追踪
const injectedStyles = new Set();

// 工具分类配置
const toolCategories = {
    dev: [],
    design: [],
    utility: [],
    other: []
};

// 动态工具容器 ID
const DYNAMIC_CONTAINER_ID = 'dynamicToolContainer';

/**
 * 注册工具
 * @param {Object} toolConfig - 工具配置
 * @param {string} toolConfig.id - 工具唯一标识
 * @param {string} toolConfig.name - 工具名称
 * @param {string} toolConfig.icon - 图标类名
 * @param {string} toolConfig.colorClass - 颜色类名
 * @param {string} toolConfig.category - 分类 (dev/design/other)
 * @param {string} [toolConfig.description] - 工具描述
 * @param {Function} [toolConfig.template] - HTML 模板函数（返回 HTML 字符串）
 * @param {Function} [toolConfig.styles] - CSS 样式函数（返回 CSS 字符串）
 * @param {Function} toolConfig.init - 工具初始化函数
 * @param {Function} [toolConfig.destroy] - 工具销毁函数（可选）
 */
export function registerTool(toolConfig) {
    const { id, name, icon, colorClass, category, description, template, styles, init, destroy } = toolConfig;
    
    if (!id || !name || !init) {
        console.error(`[ToolRegistry] 工具注册失败，缺少必要参数: ${id || 'unknown'}`);
        return false;
    }
    
    // 注册到工具存储
    toolsRegistry.set(id, {
        id,
        name,
        icon,
        colorClass,
        category,
        description: description || '点击查看详情',
        template: template || null,
        styles: styles || null,
        init,
        destroy: destroy || null,
        initialized: false
    });
    
    // 添加到对应分类
    if (category && toolCategories[category]) {
        // 检查是否已存在，避免重复添加
        const exists = toolCategories[category].some(t => t.id === id);
        if (!exists) {
            toolCategories[category].push({
                id,
                name,
                icon,
                colorClass,
                description: description || '点击查看详情'
            });
        }
    }
    
    console.log(`[ToolRegistry] 工具注册成功: ${name} (${id})`);
    return true;
}

/**
 * 获取工具配置
 * @param {string} toolId - 工具ID
 * @returns {Object|null} 工具配置对象
 */
export function getTool(toolId) {
    return toolsRegistry.get(toolId) || null;
}

/**
 * 检查工具是否有自己的模板
 * @param {string} toolId - 工具ID
 * @returns {boolean}
 */
export function hasToolTemplate(toolId) {
    const tool = toolsRegistry.get(toolId);
    return tool && typeof tool.template === 'function';
}

/**
 * 注入工具样式到 head
 * @param {string} toolId - 工具ID
 */
function injectToolStyles(toolId) {
    const tool = toolsRegistry.get(toolId);
    if (!tool || !tool.styles) return;
    
    const styleId = `tool-style-${toolId}`;
    
    // 检查是否已注入
    if (document.getElementById(styleId)) return;
    
    try {
        const cssContent = tool.styles();
        const styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = cssContent;
        document.head.appendChild(styleEl);
        injectedStyles.add(styleId);
        console.log(`[ToolRegistry] 样式已注入: ${toolId}`);
    } catch (error) {
        console.error(`[ToolRegistry] 样式注入失败: ${toolId}`, error);
    }
}

/**
 * 移除工具样式
 * @param {string} toolId - 工具ID
 */
function removeToolStyles(toolId) {
    const styleId = `tool-style-${toolId}`;
    const styleEl = document.getElementById(styleId);
    if (styleEl) {
        styleEl.remove();
        injectedStyles.delete(styleId);
        console.log(`[ToolRegistry] 样式已移除: ${toolId}`);
    }
}

/**
 * 渲染工具视图到动态容器
 * @param {string} toolId - 工具ID
 * @returns {HTMLElement|null} 渲染的容器元素
 */
export function renderToolView(toolId) {
    const tool = toolsRegistry.get(toolId);
    if (!tool) {
        console.warn(`[ToolRegistry] 工具未找到: ${toolId}`);
        return null;
    }
    
    // 获取或创建动态容器
    let container = document.getElementById(DYNAMIC_CONTAINER_ID);
    if (!container) {
        // 如果动态容器不存在，创建它
        const contentArea = document.getElementById('contentArea');
        if (contentArea) {
            container = document.createElement('div');
            container.id = DYNAMIC_CONTAINER_ID;
            container.className = 'view';
            contentArea.appendChild(container);
        }
    }
    
    if (!container) {
        console.error('[ToolRegistry] 无法找到或创建动态工具容器');
        return null;
    }
    
    // 如果工具有模板，渲染它
    if (typeof tool.template === 'function') {
        try {
            // 注入样式
            injectToolStyles(toolId);
            
            // 渲染 HTML
            const html = tool.template();
            container.innerHTML = html;
            container.dataset.toolId = toolId;
            
            console.log(`[ToolRegistry] 工具视图已渲染: ${toolId}`);
            return container;
        } catch (error) {
            console.error(`[ToolRegistry] 工具视图渲染失败: ${toolId}`, error);
            return null;
        }
    }
    
    return container;
}

/**
 * 清理动态工具容器
 */
export function clearDynamicContainer() {
    const container = document.getElementById(DYNAMIC_CONTAINER_ID);
    if (container) {
        const toolId = container.dataset.toolId;
        container.innerHTML = '';
        container.classList.remove('view--active');
        delete container.dataset.toolId;
    }
}

/**
 * 显示动态工具容器
 */
export function showDynamicContainer() {
    const container = document.getElementById(DYNAMIC_CONTAINER_ID);
    if (container) {
        container.classList.add('view--active');
    }
}

/**
 * 隐藏动态工具容器
 */
export function hideDynamicContainer() {
    const container = document.getElementById(DYNAMIC_CONTAINER_ID);
    if (container) {
        container.classList.remove('view--active');
    }
}

/**
 * 初始化工具
 * @param {string} toolId - 工具ID
 * @returns {boolean} 是否初始化成功
 */
export function initTool(toolId) {
    const tool = toolsRegistry.get(toolId);
    if (!tool) {
        console.warn(`[ToolRegistry] 工具未找到: ${toolId}`);
        return false;
    }
    
    if (typeof tool.init === 'function') {
        try {
            tool.init();
            tool.initialized = true;
            return true;
        } catch (error) {
            console.error(`[ToolRegistry] 工具初始化失败: ${toolId}`, error);
            return false;
        }
    }
    
    return false;
}

/**
 * 销毁工具（清理资源）
 * @param {string} toolId - 工具ID
 */
export function destroyTool(toolId) {
    const tool = toolsRegistry.get(toolId);
    if (tool && typeof tool.destroy === 'function') {
        try {
            tool.destroy();
            tool.initialized = false;
        } catch (error) {
            console.error(`[ToolRegistry] 工具销毁失败: ${toolId}`, error);
        }
    }
}

/**
 * 获取所有工具列表（扁平数组）
 * @returns {Array} 所有工具的扁平列表
 */
export function getAllTools() {
    return Array.from(toolsRegistry.values());
}

/**
 * 获取指定分类的工具列表
 * @param {string} category - 分类名称
 * @returns {Array} 工具列表
 */
export function getToolsByCategory(category) {
    return toolCategories[category] || [];
}

/**
 * 检查工具是否已注册
 * @param {string} toolId - 工具ID
 * @returns {boolean}
 */
export function hasToolRegistered(toolId) {
    return toolsRegistry.has(toolId);
}

/**
 * 获取所有已注册工具的ID列表
 * @returns {Array<string>}
 */
export function getRegisteredToolIds() {
    return Array.from(toolsRegistry.keys());
}

/**
 * 获取动态容器 ID（供 main.js 使用）
 * @returns {string}
 */
export function getDynamicContainerId() {
    return DYNAMIC_CONTAINER_ID;
}
