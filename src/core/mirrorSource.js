/**
 * 镜像源管理模块
 * 用于管理 GitHub、npm、Google Fonts 等资源的镜像加速下载
 */

// 存储键名
const STORAGE_KEY = 'dtkit_mirror_source';
const CUSTOM_CONFIG_KEY = 'dtkit_custom_mirror';
const CACHE_KEY = 'dtkit_mirror_cache';
const AUTO_DETECT_KEY = 'dtkit_auto_mirror_detect';

// 缓存有效期（10分钟）
const CACHE_TTL = 10 * 60 * 1000;

// 测速超时时间（4秒）
const SPEED_TEST_TIMEOUT = 4000;

// ============================================
// 受限域名配置
// ============================================
const RESTRICTED_DOMAINS = {
    // 高优先级
    github: {
        domains: [
            'github.com',
            'raw.githubusercontent.com',
            'github.githubassets.com',
            'codeload.github.com',
            'objects.githubusercontent.com',
            'releases.github.com',
            'gist.githubusercontent.com'
        ],
        label: 'GitHub',
        priority: 'high'
    },
    googleFonts: {
        domains: [
            'fonts.googleapis.com',
            'fonts.gstatic.com'
        ],
        label: 'Google Fonts',
        priority: 'high'
    },
    npm: {
        domains: ['registry.npmjs.org'],
        label: 'npm',
        priority: 'high'
    },
    googleAjax: {
        domains: ['ajax.googleapis.com'],
        label: 'Google CDN',
        priority: 'high'
    },
    // 中优先级
    unsplash: {
        domains: ['unsplash.com', 'images.unsplash.com'],
        label: 'Unsplash',
        priority: 'medium'
    },
    docker: {
        domains: ['docker.io', 'registry-1.docker.io'],
        label: 'Docker Hub',
        priority: 'medium'
    }
};

// ============================================
// 镜像源配置
// ============================================
const MIRROR_SOURCES = {
    direct: {
        name: '直连 (Direct)',
        prefix: '',
        test_url: 'https://github.com',
        supports: ['github'], // 直连也支持 GitHub，作为最后备选
        transform: (url) => url
    },
    // GitHub 加速 - 2024年底仍在运营的服务
    // 优先使用域名替换类（更稳定），其次是代理类
    
    // 1. hub.nuaa.cf - 南航镜像，稳定
    hubNuaa: {
        name: 'hub.nuaa.cf',
        prefix: 'https://hub.nuaa.cf/',
        test_url: 'https://hub.nuaa.cf',
        supports: ['github'],
        transform: (url) => {
            if (isRestrictedUrl(url, 'github')) {
                return url.replace('github.com', 'hub.nuaa.cf')
                          .replace('raw.githubusercontent.com', 'raw.nuaa.cf')
                          .replace('objects.githubusercontent.com', 'objects.nuaa.cf');
            }
            return url;
        }
    },
    // 2. hub.yzuu.cf - 稳定
    hubYzuu: {
        name: 'hub.yzuu.cf', 
        prefix: 'https://hub.yzuu.cf/',
        test_url: 'https://hub.yzuu.cf',
        supports: ['github'],
        transform: (url) => {
            if (isRestrictedUrl(url, 'github')) {
                return url.replace('github.com', 'hub.yzuu.cf')
                          .replace('raw.githubusercontent.com', 'raw.yzuu.cf')
                          .replace('objects.githubusercontent.com', 'objects.yzuu.cf');
            }
            return url;
        }
    },
    // 3. kkgithub - 域名替换
    kkgithub: {
        name: 'kkgithub',
        prefix: 'https://kkgithub.com/',
        test_url: 'https://kkgithub.com',
        supports: ['github'],
        transform: (url) => {
            if (isRestrictedUrl(url, 'github')) {
                return url.replace('github.com', 'kkgithub.com')
                          .replace('raw.githubusercontent.com', 'raw.kkgithub.com')
                          .replace('objects.githubusercontent.com', 'objects.kkgithub.com');
            }
            return url;
        }
    },
    // 4. ghproxy.net - 新版本
    ghproxyNet: {
        name: 'ghproxy.net',
        prefix: 'https://ghproxy.net/',
        test_url: 'https://ghproxy.net',
        supports: ['github'],
        transform: (url) => {
            if (isRestrictedUrl(url, 'github')) {
                return `https://ghproxy.net/${url}`;
            }
            return url;
        }
    },
    // 5. gh-proxy.com
    ghProxyCom: {
        name: 'gh-proxy.com',
        prefix: 'https://gh-proxy.com/',
        test_url: 'https://gh-proxy.com',
        supports: ['github'],
        transform: (url) => {
            if (isRestrictedUrl(url, 'github')) {
                return `https://gh-proxy.com/${url}`;
            }
            return url;
        }
    },
    // Google Fonts 镜像
    fontsLoli: {
        name: 'Loli Fonts',
        prefix: 'https://fonts.loli.net/',
        test_url: 'https://fonts.loli.net',
        supports: ['googleFonts'],
        transform: (url) => {
            if (isRestrictedUrl(url, 'googleFonts')) {
                return url
                    .replace('fonts.googleapis.com', 'fonts.loli.net')
                    .replace('fonts.gstatic.com', 'gstatic.loli.net');
            }
            return url;
        }
    },
    fontsGeekzu: {
        name: 'Geekzu Fonts',
        prefix: 'https://fonts.geekzu.org/',
        test_url: 'https://fonts.geekzu.org',
        supports: ['googleFonts'],
        transform: (url) => {
            if (isRestrictedUrl(url, 'googleFonts')) {
                return url
                    .replace('fonts.googleapis.com', 'fonts.geekzu.org')
                    .replace('fonts.gstatic.com', 'gfonts.geekzu.org');
            }
            return url;
        }
    },
    // npm 镜像
    npmmirror: {
        name: 'npmmirror',
        prefix: 'https://registry.npmmirror.com/',
        test_url: 'https://registry.npmmirror.com',
        supports: ['npm'],
        transform: (url) => {
            if (isRestrictedUrl(url, 'npm')) {
                return url.replace('registry.npmjs.org', 'registry.npmmirror.com');
            }
            return url;
        }
    },
    custom: {
        name: '自定义源',
        prefix: '',
        test_url: '',
        transform: (url) => {
            const customConfig = getCustomConfig();
            if (customConfig && customConfig.prefix && isGitHubUrl(url)) {
                return customConfig.prefix + url;
            }
            return url;
        }
    }
};

// 需要镜像加速的域名列表（兼容旧代码）
const MIRROR_DOMAINS = [
    'github.com',
    'raw.githubusercontent.com',
    'github.githubassets.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'releases.github.com'
];

// ============================================
// 核心检测函数
// ============================================

/**
 * 检测 URL 是否属于特定受限类型
 * @param {string} url - 要检测的 URL
 * @param {string} type - 受限类型 (github, googleFonts, npm 等)
 * @returns {boolean}
 */
export function isRestrictedUrl(url, type) {
    try {
        const urlObj = new URL(url);
        const config = RESTRICTED_DOMAINS[type];
        if (!config) return false;
        return config.domains.some(domain => 
            urlObj.hostname === domain || urlObj.hostname.endsWith('.' + domain)
        );
    } catch {
        return false;
    }
}

/**
 * 检测 URL 是否受限，返回受限类型信息
 * @param {string} url - 要检测的 URL
 * @returns {{ restricted: boolean, type: string|null, label: string|null, priority: string|null }}
 */
export function detectRestrictedUrl(url) {
    try {
        const urlObj = new URL(url);
        
        for (const [type, config] of Object.entries(RESTRICTED_DOMAINS)) {
            const isMatch = config.domains.some(domain => 
                urlObj.hostname === domain || urlObj.hostname.endsWith('.' + domain)
            );
            
            if (isMatch) {
                return {
                    restricted: true,
                    type,
                    label: config.label,
                    priority: config.priority
                };
            }
        }
        
        return { restricted: false, type: null, label: null, priority: null };
    } catch {
        return { restricted: false, type: null, label: null, priority: null };
    }
}

/**
 * 检测是否为 GitHub 相关 URL（兼容旧代码）
 */
export function isGitHubUrl(url) {
    return isRestrictedUrl(url, 'github');
}

/**
 * 检测是否需要使用镜像源（兼容旧代码）
 */
export function needsMirror(url) {
    return detectRestrictedUrl(url).restricted;
}

// ============================================
// 自动检测开关
// ============================================

/**
 * 获取自动镜像检测开关状态
 */
export function isAutoDetectEnabled() {
    const saved = localStorage.getItem(AUTO_DETECT_KEY);
    return saved === null ? true : saved === 'true';
}

/**
 * 设置自动镜像检测开关
 */
export function setAutoDetectEnabled(enabled) {
    localStorage.setItem(AUTO_DETECT_KEY, String(enabled));
}

/**
 * 获取当前选择的镜像源
 */
export function getCurrentMirrorSource() {
    return localStorage.getItem(STORAGE_KEY) || 'direct';
}

/**
 * 设置镜像源
 */
export function setMirrorSource(sourceId) {
    if (MIRROR_SOURCES[sourceId] || sourceId === 'custom') {
        localStorage.setItem(STORAGE_KEY, sourceId);
        return true;
    }
    return false;
}

/**
 * 获取自定义配置
 */
export function getCustomConfig() {
    try {
        const config = localStorage.getItem(CUSTOM_CONFIG_KEY);
        return config ? JSON.parse(config) : null;
    } catch {
        return null;
    }
}

/**
 * 保存自定义配置
 */
export function saveCustomConfig(config) {
    try {
        // 验证配置格式
        if (typeof config === 'string') {
            config = JSON.parse(config);
        }
        
        if (!config.name || !config.prefix) {
            throw new Error('配置必须包含 name 和 prefix 字段');
        }
        
        localStorage.setItem(CUSTOM_CONFIG_KEY, JSON.stringify(config));
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 将原始 URL 转换为镜像 URL
 */
export function transformUrl(url, sourceId = null) {
    const source = sourceId || getCurrentMirrorSource();
    const config = MIRROR_SOURCES[source];
    
    if (config && config.transform) {
        return config.transform(url);
    }
    
    return url;
}

/**
 * 获取所有可用的镜像源列表（用于自动切换）
 */
export function getMirrorSourceList() {
    const list = ['direct', 'ghproxy', 'gitclone'];
    const customConfig = getCustomConfig();
    if (customConfig) {
        list.push('custom');
    }
    return list;
}

/**
 * 获取镜像源名称
 */
export function getMirrorSourceName(sourceId) {
    if (sourceId === 'custom') {
        const customConfig = getCustomConfig();
        return customConfig?.name || '自定义源';
    }
    return MIRROR_SOURCES[sourceId]?.name || sourceId;
}

/**
 * 测试镜像源延迟
 */
export async function testMirrorLatency(sourceId) {
    const config = MIRROR_SOURCES[sourceId];
    if (!config) {
        throw new Error('未知的镜像源');
    }
    
    let testUrl = config.test_url;
    
    // 自定义源使用自定义的测试 URL
    if (sourceId === 'custom') {
        const customConfig = getCustomConfig();
        if (!customConfig || !customConfig.prefix) {
            throw new Error('请先配置自定义源');
        }
        testUrl = customConfig.prefix;
    }
    
    if (!testUrl) {
        throw new Error('无测试地址');
    }
    
    const startTime = performance.now();
    
    try {
        // 使用 HEAD 请求测试延迟
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        await fetch(testUrl, {
            method: 'HEAD',
            mode: 'no-cors',  // 避免 CORS 问题
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        const endTime = performance.now();
        return Math.round(endTime - startTime);
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('超时');
        }
        throw error;
    }
}

/**
 * 镜像下载管理器 - 用于自动切换镜像源
 */
export class MirrorDownloadManager {
    constructor() {
        this.currentSourceIndex = 0;
        this.sourceList = [];
        this.checkInterval = 7000; // 7秒检测间隔
        this.minSpeed = 20 * 1024; // 20KB/s 最低速度
        this.onSourceChange = null;
        this.onFailed = null;
    }
    
    /**
     * 初始化镜像源列表
     */
    initSourceList() {
        // 优先使用当前选择的镜像源
        const currentSource = getCurrentMirrorSource();
        const allSources = getMirrorSourceList();
        
        // 将当前源放到第一位
        this.sourceList = [currentSource, ...allSources.filter(s => s !== currentSource)];
        this.currentSourceIndex = 0;
    }
    
    /**
     * 获取当前使用的镜像源
     */
    getCurrentSource() {
        return this.sourceList[this.currentSourceIndex];
    }
    
    /**
     * 切换到下一个镜像源
     * 返回新的镜像源 ID，如果没有更多则返回 null
     */
    switchToNextSource() {
        if (this.currentSourceIndex < this.sourceList.length - 1) {
            this.currentSourceIndex++;
            const newSource = this.sourceList[this.currentSourceIndex];
            
            if (this.onSourceChange) {
                this.onSourceChange(newSource, getMirrorSourceName(newSource));
            }
            
            return newSource;
        }
        
        // 所有镜像源都尝试过了
        if (this.onFailed) {
            this.onFailed();
        }
        return null;
    }
    
    /**
     * 检查下载速度是否合格
     */
    isSpeedAcceptable(bytesPerSecond) {
        return bytesPerSecond >= this.minSpeed;
    }
    
    /**
     * 转换 URL 使用当前镜像源
     */
    transformUrl(url) {
        return transformUrl(url, this.getCurrentSource());
    }
    
    /**
     * 重置状态
     */
    reset() {
        this.currentSourceIndex = 0;
        this.sourceList = [];
    }
}

// 导出单例实例
export const mirrorManager = new MirrorDownloadManager();

// ============================================
// 智能镜像检测器类
// ============================================

/**
 * MirrorDetector - 智能镜像源检测器
 * 提供自动检测、测速、缓存等功能
 */
export class MirrorDetector {
    constructor() {
        this.cache = this.loadCache();
    }
    
    /**
     * 加载缓存
     */
    loadCache() {
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const data = JSON.parse(cached);
                // 检查是否过期
                if (Date.now() - data.timestamp < CACHE_TTL) {
                    return data.results || {};
                }
            }
        } catch (e) {
            console.warn('加载镜像缓存失败:', e);
        }
        return {};
    }
    
    /**
     * 保存缓存
     */
    saveCache() {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                timestamp: Date.now(),
                results: this.cache
            }));
        } catch (e) {
            console.warn('保存镜像缓存失败:', e);
        }
    }
    
    /**
     * 清除缓存
     */
    clearCache() {
        this.cache = {};
        localStorage.removeItem(CACHE_KEY);
    }
    
    /**
     * 判断 URL 是否受限
     * @param {string} url - 要检测的 URL
     * @returns {{ restricted: boolean, type: string|null, label: string|null }}
     */
    isRestricted(url) {
        return detectRestrictedUrl(url);
    }
    
    /**
     * 测试单个镜像的延迟
     * @param {string} sourceId - 镜像源 ID
     * @returns {Promise<{ sourceId: string, latency: number, success: boolean }>}
     */
    async testMirrorSpeed(sourceId) {
        const config = MIRROR_SOURCES[sourceId];
        if (!config || !config.test_url) {
            return { sourceId, latency: Infinity, success: false };
        }
        
        const startTime = performance.now();
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), SPEED_TEST_TIMEOUT);
            
            await fetch(config.test_url, {
                method: 'HEAD',
                mode: 'no-cors',
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            const latency = Math.round(performance.now() - startTime);
            
            return { sourceId, latency, success: true };
        } catch (error) {
            return { sourceId, latency: Infinity, success: false };
        }
    }
    
    /**
     * 获取适用于特定类型的镜像源列表
     * @param {string} restrictedType - 受限类型
     * @returns {string[]}
     */
    getMirrorsForType(restrictedType) {
        const mirrors = [];
        
        for (const [sourceId, config] of Object.entries(MIRROR_SOURCES)) {
            // 跳过直连和自定义（直连作为最后备选单独添加）
            if (sourceId === 'direct' || sourceId === 'custom') continue;
            
            if (config.supports && config.supports.includes(restrictedType)) {
                mirrors.push(sourceId);
            }
        }
        
        // 直连作为最后备选（有时候直连反而能成功）
        mirrors.push('direct');
        
        return mirrors;
    }
    
    /**
     * 并发测试多个镜像源，返回最快的
     * @param {string[]} sourceIds - 要测试的镜像源 ID 列表
     * @returns {Promise<{ sourceId: string, latency: number } | null>}
     */
    async findFastestMirror(sourceIds) {
        if (!sourceIds || sourceIds.length === 0) return null;
        
        // 并发测试所有镜像
        const results = await Promise.all(
            sourceIds.map(id => this.testMirrorSpeed(id))
        );
        
        // 过滤成功的结果并按延迟排序
        const successResults = results
            .filter(r => r.success)
            .sort((a, b) => a.latency - b.latency);
        
        if (successResults.length === 0) return null;
        
        return successResults[0];
    }
    
    /**
     * 获取最佳镜像地址
     * @param {string} url - 原始 URL
     * @param {Function} onProgress - 进度回调
     * @returns {Promise<{ url: string, sourceId: string, sourceName: string, latency: number, isAccelerated: boolean }>}
     */
    async getBestMirror(url, onProgress = null) {
        // 检查是否启用自动检测
        if (!isAutoDetectEnabled()) {
            return {
                url,
                sourceId: 'direct',
                sourceName: '直连',
                latency: 0,
                isAccelerated: false
            };
        }
        
        // 检查是否受限
        const restriction = this.isRestricted(url);
        
        if (!restriction.restricted) {
            return {
                url,
                sourceId: 'direct',
                sourceName: '直连',
                latency: 0,
                isAccelerated: false
            };
        }
        
        // 检查缓存
        const cacheKey = restriction.type;
        if (this.cache[cacheKey]) {
            const cached = this.cache[cacheKey];
            const config = MIRROR_SOURCES[cached.sourceId];
            if (config) {
                return {
                    url: config.transform(url),
                    sourceId: cached.sourceId,
                    sourceName: config.name,
                    latency: cached.latency,
                    isAccelerated: true,
                    fromCache: true
                };
            }
        }
        
        // 获取适用的镜像源
        const availableMirrors = this.getMirrorsForType(restriction.type);
        
        if (availableMirrors.length === 0) {
            return {
                url,
                sourceId: 'direct',
                sourceName: '直连',
                latency: 0,
                isAccelerated: false,
                reason: '无可用镜像'
            };
        }
        
        if (onProgress) onProgress('正在选择最优线路...');
        
        // 测试并选择最快的镜像
        const best = await this.findFastestMirror(availableMirrors);
        
        // 如果测速失败（可能是 CORS 问题），直接使用第一个镜像
        // 因为测速失败不代表镜像不可用，后端下载不受 CORS 限制
        const selectedSourceId = best ? best.sourceId : availableMirrors[0];
        const selectedLatency = best ? best.latency : 0;
        
        // 缓存结果
        this.cache[cacheKey] = {
            sourceId: selectedSourceId,
            latency: selectedLatency
        };
        this.saveCache();
        
        // 转换 URL
        const config = MIRROR_SOURCES[selectedSourceId];
        const transformedUrl = config.transform(url);
        
        if (onProgress) {
            if (best) {
                onProgress(`使用 ${config.name} 加速`);
            } else {
                onProgress(`使用 ${config.name} 加速（跳过测速）`);
            }
        }
        
        return {
            url: transformedUrl,
            sourceId: selectedSourceId,
            sourceName: config.name,
            latency: selectedLatency,
            isAccelerated: true,
            availableMirrors // 返回所有可用镜像供重试
        };
    }
    
    /**
     * 获取备用镜像 URL（用于下载失败时重试）
     * @param {string} originalUrl - 原始 URL
     * @param {string} failedSourceId - 失败的镜像源 ID
     * @returns {{ url: string, sourceId: string, sourceName: string } | null}
     */
    getAlternativeMirror(originalUrl, failedSourceId) {
        const restriction = this.isRestricted(originalUrl);
        if (!restriction.restricted) return null;
        
        const availableMirrors = this.getMirrorsForType(restriction.type);
        
        // 过滤掉失败的镜像
        const remaining = availableMirrors.filter(id => id !== failedSourceId);
        
        if (remaining.length === 0) return null;
        
        // 返回第一个可用的备用镜像
        const nextSourceId = remaining[0];
        const config = MIRROR_SOURCES[nextSourceId];
        
        return {
            url: config.transform(originalUrl),
            sourceId: nextSourceId,
            sourceName: config.name
        };
    }
    
    /**
     * 获取所有可用镜像的 URL 列表（用于批量重试）
     * @param {string} originalUrl - 原始 URL
     * @returns {Array<{ url: string, sourceId: string, sourceName: string }>}
     */
    getAllMirrorUrls(originalUrl) {
        const restriction = this.isRestricted(originalUrl);
        if (!restriction.restricted) {
            return [{ url: originalUrl, sourceId: 'direct', sourceName: '直连' }];
        }
        
        const availableMirrors = this.getMirrorsForType(restriction.type);
        
        return availableMirrors.map(sourceId => {
            const config = MIRROR_SOURCES[sourceId];
            return {
                url: config.transform(originalUrl),
                sourceId,
                sourceName: config.name
            };
        });
    }
}

// 导出单例
export const mirrorDetector = new MirrorDetector();

// 挂载到 window 供调试使用
window.mirrorSource = {
    isGitHubUrl,
    needsMirror,
    detectRestrictedUrl,
    isRestrictedUrl,
    getCurrentMirrorSource,
    setMirrorSource,
    transformUrl,
    testMirrorLatency,
    getMirrorSourceList,
    getMirrorSourceName,
    getCustomConfig,
    saveCustomConfig,
    isAutoDetectEnabled,
    setAutoDetectEnabled,
    mirrorManager,
    mirrorDetector,
    MirrorDetector
};
