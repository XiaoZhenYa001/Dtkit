/**
 * 工具注册中心
 * 管理所有工具的注册、获取和初始化
 */

// 工具存储
const toolsRegistry = new Map();

// 工具分类配置
const toolCategories = {
    dev: [],
    design: [],
    other: []
};

/**
 * 注册工具
 * @param {Object} toolConfig - 工具配置
 * @param {string} toolConfig.id - 工具唯一标识
 * @param {string} toolConfig.name - 工具名称
 * @param {string} toolConfig.icon - 图标类名
 * @param {string} toolConfig.colorClass - 颜色类名
 * @param {string} toolConfig.category - 分类 (dev/design/other)
 * @param {string} [toolConfig.description] - 工具描述
 * @param {Function} toolConfig.init - 工具初始化函数
 * @param {Function} [toolConfig.destroy] - 工具销毁函数（可选）
 */
export function registerTool(toolConfig) {
    const { id, name, icon, colorClass, category, description, init, destroy } = toolConfig;
    
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
