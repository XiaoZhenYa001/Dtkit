/**
 * 工具注册中心
 * 管理所有工具的注册、获取、初始化和模板管理
 * 
 * 新架构特性：
 * - 每个工具包含自己的 HTML 模板和外部 CSS 模块
 * - 动态注入工具视图到 DOM
 * - 工具样式随动态 import 由构建系统按需加载
 */

// 工具存储
const toolsRegistry = new Map();

export const TOOL_STATUSES = Object.freeze({
    READY: 'ready',
    BETA: 'beta',
    PLANNED: 'planned'
});

const VALID_TOOL_STATUSES = new Set(Object.values(TOOL_STATUSES));

function normalizeToolStatus(status, fallback = TOOL_STATUSES.READY) {
    return VALID_TOOL_STATUSES.has(status) ? status : fallback;
}

// 工具分类配置
const toolCategories = {
    dev: [],
    design: [],
    utility: [],
    other: []
};

// 动态工具容器 ID
const DYNAMIC_CONTAINER_ID = 'dynamicToolContainer';

function addToolToCategory(tool) {
    const category = toolCategories[tool.category];
    if (!category) return;

    const categoryTool = {
        id: tool.id,
        name: tool.name,
        icon: tool.icon,
        colorClass: tool.colorClass,
        description: tool.description || '点击查看详情',
        status: tool.status
    };
    const existingIndex = category.findIndex(item => item.id === tool.id);

    if (existingIndex >= 0) {
        category[existingIndex] = categoryTool;
    } else {
        category.push(categoryTool);
    }
}

/**
 * 注册轻量工具清单。loader 只会在用户首次打开工具时执行。
 * @param {Object} manifest - 工具元数据；非 planned 工具必须提供动态导入函数
 * @returns {boolean} 是否注册成功
 */
export function registerToolManifest(manifest) {
    const { id, name, loader } = manifest;
    const status = normalizeToolStatus(manifest.status);
    const hasValidStatus = VALID_TOOL_STATUSES.has(manifest.status ?? status);
    const hasRequiredLoader = status === TOOL_STATUSES.PLANNED || typeof loader === 'function';
    if (!id || !name || !hasRequiredLoader || !hasValidStatus) {
        console.error(`[ToolRegistry] 工具清单注册失败: ${id || 'unknown'}`);
        return false;
    }

    const existing = toolsRegistry.get(id);
    const tool = {
        id,
        name,
        icon: manifest.icon,
        colorClass: manifest.colorClass,
        category: manifest.category,
        description: manifest.description || '点击查看详情',
        status,
        template: existing?.template || null,
        init: existing?.init || null,
        destroy: existing?.destroy || null,
        initialized: existing?.initialized || false,
        loaded: existing?.loaded || false,
        loader,
        loadPromise: existing?.loadPromise || null
    };

    toolsRegistry.set(id, tool);
    addToolToCategory(tool);
    return true;
}

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
 * @param {Function} toolConfig.init - 工具初始化函数
 * @param {Function} [toolConfig.destroy] - 工具销毁函数（可选）
 */
export function registerTool(toolConfig) {
    const { id, name, icon, colorClass, category, description, template, init, destroy } = toolConfig;
    
    if (!id || !name || !init) {
        console.error(`[ToolRegistry] 工具注册失败，缺少必要参数: ${id || 'unknown'}`);
        return false;
    }
    
    const existing = toolsRegistry.get(id);
    const tool = {
        id,
        name,
        icon,
        colorClass,
        category,
        description: description || '点击查看详情',
        status: normalizeToolStatus(toolConfig.status, existing?.status),
        template: template || null,
        init,
        destroy: destroy || null,
        initialized: existing?.initialized || false,
        loaded: true,
        loader: existing?.loader || null,
        loadPromise: existing?.loadPromise || null
    };

    toolsRegistry.set(id, tool);
    addToolToCategory(tool);
    
    console.log(`[ToolRegistry] 工具注册成功: ${name} (${id})`);
    return true;
}

/**
 * 首次使用时加载工具模块；并发请求共享同一个 Promise。
 * @param {string} toolId - 工具 ID
 * @returns {Promise<Object>} 完整工具配置
 */
export async function loadTool(toolId) {
    const tool = toolsRegistry.get(toolId);
    if (!tool) throw new Error(`工具未找到: ${toolId}`);
    if (tool.status === TOOL_STATUSES.PLANNED) throw new Error(`工具尚未开放: ${toolId}`);
    if (tool.loaded) return tool;
    if (tool.loadPromise) return tool.loadPromise;
    if (typeof tool.loader !== 'function') throw new Error(`工具缺少加载器: ${toolId}`);

    tool.loadPromise = (async () => {
        try {
            await tool.loader();
            const loadedTool = toolsRegistry.get(toolId);
            if (!loadedTool?.loaded || typeof loadedTool.init !== 'function') {
                throw new Error(`工具模块未完成注册: ${toolId}`);
            }
            loadedTool.loadPromise = null;
            return loadedTool;
        } catch (error) {
            const failedTool = toolsRegistry.get(toolId);
            if (failedTool) failedTool.loadPromise = null;
            throw error;
        }
    })();

    return tool.loadPromise;
}

export function isToolLoaded(toolId) {
    return toolsRegistry.get(toolId)?.loaded === true;
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
