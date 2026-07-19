/**
 * 下载视图
 * 管理文件下载列表、下载进度、下载历史等功能
 */
import { getDownloadPath } from '../core/state.js';
import { escapeAttribute, escapeHtml } from '../core/html.js';
import { showToast } from '../core/utils.js';
import { 
    mirrorDetector, 
    detectRestrictedUrl, 
    isAutoDetectEnabled,
    getMirrorSourceName 
} from '../core/mirrorSource.js';

// DOM 元素引用
let downloadsContent = null;

// 下载任务列表（前端状态）
let downloadTasks = [];

// 临时保存路径（关闭标签后重置）
let tempSavePath = null;

// Tauri API 引用
let tauriInvoke = null;
let tauriListen = null;
let tauriDialog = null;

// 事件监听器取消函数
let unlistenProgress = null;
let unlistenStatusChanged = null;
let unlistenStarted = null;
let unlistenRetry = null;
let renderingSuspended = false;

window.addEventListener('dtkit:power-state', event => {
    renderingSuspended = Boolean(event.detail?.suspended);
    if (!renderingSuspended && document.getElementById('downloadsList')) {
        loadExistingTasks();
    }
});

const DOWNLOAD_STATUS_CLASSES = new Set(['downloading', 'completed', 'error', 'cancelled']);

/**
 * 初始化下载视图
 */
export function initDownloadsView() {
    downloadsContent = document.getElementById('downloadsContent');
    
    // 初始化 Tauri API
    ensureTauriApi();
}

/**
 * 确保 Tauri API 已初始化
 */
function ensureTauriApi() {
    if (window.__TAURI__) {
        // Tauri 2.0 API 路径
        tauriInvoke = window.__TAURI__.core?.invoke;
        tauriListen = window.__TAURI__.event?.listen;
        tauriDialog = window.__TAURI__.dialog;
        
        // 调试日志
        console.log('Tauri API 状态:', {
            hasTauri: !!window.__TAURI__,
            hasCore: !!window.__TAURI__.core,
            hasInvoke: !!tauriInvoke,
            hasListen: !!tauriListen,
            hasDialog: !!tauriDialog,
            tauriKeys: Object.keys(window.__TAURI__)
        });
    } else {
        console.log('window.__TAURI__ 不存在');
    }
}

/**
 * 设置事件监听器
 */
async function setupEventListeners() {
    if (!tauriListen) return;
    
    // 清理旧的监听器
    await cleanupEventListeners();
    
    // 监听下载进度
    unlistenProgress = await tauriListen('download-progress', (event) => {
        updateTaskProgress(event.payload);
    });
    
    // 监听状态变化
    unlistenStatusChanged = await tauriListen('download-status-changed', (event) => {
        updateTaskFromBackend(event.payload);
    });
    
    // 监听新下载开始
    unlistenStarted = await tauriListen('download-started', (event) => {
        addTaskToList(event.payload);
    });
    
    // 监听镜像重试
    unlistenRetry = await tauriListen('download-retry', (event) => {
        const { id, attempt, message } = event.payload;
        showToast(`${message}`, 'info');
        updateTaskRetryStatus(id, attempt);
    });
}

/**
 * 清理事件监听器
 */
async function cleanupEventListeners() {
    if (unlistenProgress) {
        await unlistenProgress();
        unlistenProgress = null;
    }
    if (unlistenStatusChanged) {
        await unlistenStatusChanged();
        unlistenStatusChanged = null;
    }
    if (unlistenStarted) {
        await unlistenStarted();
        unlistenStarted = null;
    }
    if (unlistenRetry) {
        await unlistenRetry();
        unlistenRetry = null;
    }
}

/**
 * 渲染下载页面
 */
export function renderDownloadsPage() {
    if (!downloadsContent) {
        downloadsContent = document.getElementById('downloadsContent');
    }
    if (!downloadsContent) return;
    
    downloadsContent.innerHTML = `
        <div class="downloads-page">
            <!-- 头部 -->
            <div class="downloads-header">
                <div class="downloads-header__left">
                    <h1>📥 下载管理器</h1>
                    <p>智能管理你的所有下载任务</p>
                </div>
            </div>

            <!-- 统计卡片 -->
            <div class="downloads-stats">
                <div class="stat-card">
                    <div class="stat-icon downloading">
                        <i class="ri-download-line"></i>
                    </div>
                    <div class="stat-info">
                        <h3 id="statDownloading">0</h3>
                        <p>正在下载</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon completed">
                        <i class="ri-check-line"></i>
                    </div>
                    <div class="stat-info">
                        <h3 id="statCompleted">0</h3>
                        <p>已完成</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon failed">
                        <i class="ri-error-warning-line"></i>
                    </div>
                    <div class="stat-info">
                        <h3 id="statFailed">0</h3>
                        <p>失败任务</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon speed">
                        <i class="ri-speed-line"></i>
                    </div>
                    <div class="stat-info">
                        <h3 id="statSpeed">0</h3>
                        <p>MB/s</p>
                    </div>
                </div>
            </div>

            <!-- 新建下载区域 -->
            <div class="add-download-section">
                <div class="add-download-header">
                    <div class="add-download-title">
                        <i class="ri-add-circle-line"></i>
                        <span>新建下载任务</span>
                    </div>
                    <button class="toggle-advanced-btn" id="toggleAdvancedBtn">
                        <i class="ri-settings-3-line"></i>
                        <span>高级选项</span>
                        <i class="ri-arrow-down-s-line toggle-arrow"></i>
                    </button>
                </div>
                
                <div class="input-container">
                    <div class="url-input-wrapper">
                        <i class="ri-link"></i>
                        <input 
                            type="url" 
                            id="downloadUrlInput" 
                            placeholder="粘贴下载链接（支持 HTTP/HTTPS）"
                            class="url-input"
                        >
                    </div>
                    <button class="btn-start-download" id="startDownloadBtn">
                        <i class="ri-download-2-line"></i>
                        开始下载
                    </button>
                </div>
                
                <!-- 镜像源提示（动态显示） -->
                <div class="mirror-tip is-initially-hidden" id="mirrorTip">
                    <i class="ri-flashlight-line"></i>
                    <span id="mirrorTipText"></span>
                </div>
                
                <!-- 高级选项（可折叠） -->
                <div class="advanced-options" id="advancedOptions">
                    <div class="advanced-options-grid">
                        <div class="option-item">
                            <label class="option-label">自定义文件名</label>
                            <input type="text" id="customFilename" placeholder="留空则使用原始文件名" class="option-input">
                        </div>
                        <div class="option-item">
                            <label class="option-label">保存路径</label>
                            <div class="path-input-group">
                                <input type="text" id="savePath" placeholder="默认下载目录" readonly class="option-input">
                                <button class="btn-browse" id="browsePathBtn">
                                    <i class="ri-folder-open-line"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 工具栏 -->
            <div class="downloads-toolbar">
                <div class="downloads-search">
                    <i class="ri-search-line"></i>
                    <input type="text" id="downloadSearchInput" placeholder="搜索任务名称、文件类型...">
                </div>
                <button class="filter-btn active" data-filter="all">
                    <i class="ri-filter-3-line"></i>
                    全部
                </button>
                <button class="filter-btn" data-filter="downloading">
                    <i class="ri-download-line"></i>
                    下载中
                </button>
                <button class="filter-btn" data-filter="completed">
                    <i class="ri-check-line"></i>
                    已完成
                </button>
            </div>

            <!-- 任务列表 -->
            <div class="downloads-list" id="downloadsList">
                <!-- 任务将通过 JavaScript 动态渲染 -->
            </div>
            
            <!-- 空状态提示 -->
            <div class="empty-state is-initially-hidden" id="emptyState">
                <i class="ri-download-cloud-line"></i>
                <p>暂无下载任务</p>
                <span>在上方输入URL开始下载文件</span>
            </div>
        </div>
    `;
    
    // 确保 Tauri API 已初始化
    ensureTauriApi();
    
    // 绑定事件
    bindDownloadsEvents();
    
    // 设置 Tauri 事件监听
    setupEventListeners();
    
    // 重置临时路径为默认路径
    tempSavePath = getDownloadPath();
    const savePathInput = document.getElementById('savePath');
    if (savePathInput) {
        savePathInput.value = tempSavePath || '默认下载目录';
    }
    
    // 加载已有任务
    loadExistingTasks();
    
    // 更新统计数据和空状态
    updateEmptyState();
    updateStats();
}
/**
 * 绑定下载页面事件
 */
function bindDownloadsEvents() {
    // 新建下载 - 开始下载按钮
    const startDownloadBtn = document.getElementById('startDownloadBtn');
    startDownloadBtn?.addEventListener('click', handleStartDownload);
    
    // 新建下载 - 回车键触发
    const urlInput = document.getElementById('downloadUrlInput');
    urlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleStartDownload();
    });
    
    // 实时检测受限链接
    urlInput?.addEventListener('input', handleUrlInputChange);
    urlInput?.addEventListener('paste', () => {
        // 延迟处理粘贴事件，等待值更新
        setTimeout(handleUrlInputChange, 50);
    });
    
    // 高级选项切换
    const toggleAdvancedBtn = document.getElementById('toggleAdvancedBtn');
    toggleAdvancedBtn?.addEventListener('click', toggleAdvancedOptions);
    
    // 浏览保存路径
    const browsePathBtn = document.getElementById('browsePathBtn');
    browsePathBtn?.addEventListener('click', handleBrowsePath);
    
    // 筛选按钮事件
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const filter = btn.dataset.filter;
            filterTasks(filter);
        });
    });
    
    // 搜索事件
    const searchInput = document.getElementById('downloadSearchInput');
    searchInput?.addEventListener('input', (e) => {
        searchTasks(e.target.value);
    });
    
    // 任务按钮事件 - 波纹效果
    const taskBtns = document.querySelectorAll('.task-btn');
    taskBtns.forEach(btn => {
        btn.addEventListener('click', function(e) {
            // 添加点击波纹效果
            const ripple = document.createElement('span');
            const rect = this.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = e.clientX - rect.left - size / 2;
            const y = e.clientY - rect.top - size / 2;

            ripple.className = 'task-btn__ripple';
            ripple.style.width = `${size}px`;
            ripple.style.height = `${size}px`;
            ripple.style.left = `${x}px`;
            ripple.style.top = `${y}px`;
            this.appendChild(ripple);
            
            setTimeout(() => ripple.remove(), 600);
        });
    });
}

/**
 * 处理 URL 输入变化，实时检测受限链接
 */
function handleUrlInputChange() {
    const urlInput = document.getElementById('downloadUrlInput');
    const mirrorTip = document.getElementById('mirrorTip');
    const mirrorTipText = document.getElementById('mirrorTipText');
    
    if (!urlInput || !mirrorTip || !mirrorTipText) return;
    
    const url = urlInput.value.trim();
    
    // 清空时隐藏提示
    if (!url) {
        mirrorTip.style.display = 'none';
        mirrorTip.className = 'mirror-tip';
        return;
    }
    
    // 简单验证 URL 格式
    if (!url.match(/^https?:/i)) {
        mirrorTip.style.display = 'none';
        return;
    }
    
    // 检测是否受限
    const restriction = detectRestrictedUrl(url);
    
    if (restriction.restricted && isAutoDetectEnabled()) {
        mirrorTip.style.display = 'flex';
        mirrorTip.className = 'mirror-tip mirror-tip--warning';
        mirrorTipText.textContent = `检测到 ${restriction.label} 链接，将自动使用镜像加速`;
    } else if (restriction.restricted) {
        mirrorTip.style.display = 'flex';
        mirrorTip.className = 'mirror-tip mirror-tip--info';
        mirrorTipText.textContent = `检测到 ${restriction.label} 链接（自动加速已禁用）`;
    } else {
        mirrorTip.style.display = 'none';
    }
}

/**
 * 显示镜像提示
 */
function showMirrorTip(message, type = 'info') {
    const mirrorTip = document.getElementById('mirrorTip');
    const mirrorTipText = document.getElementById('mirrorTipText');
    
    if (!mirrorTip || !mirrorTipText) return;
    
    mirrorTip.style.display = 'flex';
    mirrorTip.className = `mirror-tip mirror-tip--${type}`;
    mirrorTipText.textContent = message;
}

/**
 * 隐藏镜像提示
 */
function hideMirrorTip() {
    const mirrorTip = document.getElementById('mirrorTip');
    if (mirrorTip) {
        mirrorTip.style.display = 'none';
    }
}

/**
 * 处理开始下载
 */
async function handleStartDownload() {
    const urlInput = document.getElementById('downloadUrlInput');
    const customFilename = document.getElementById('customFilename');
    const savePath = document.getElementById('savePath');
    const startBtn = document.getElementById('startDownloadBtn');
    
    const url = urlInput?.value.trim();
    
    if (!url) {
        // 输入框报错效果
        urlInput?.classList.add('error');
        urlInput?.focus();
        setTimeout(() => urlInput?.classList.remove('error'), 1000);
        showToast('请输入下载链接', 'error');
        return;
    }
    
    // 简单的 URL 验证
    if (!url.match(/^https?:/i)) {
        urlInput?.classList.add('error');
        setTimeout(() => urlInput?.classList.remove('error'), 1000);
        showToast('请输入有效的下载链接', 'error');
        return;
    }
    
    // 获取保存路径（优先使用临时路径，否则使用默认路径）
    const downloadPath = tempSavePath || getDownloadPath() || '';
    
    if (!downloadPath) {
        showToast('请先设置下载目录', 'error');
        return;
    }
    
    const filename = customFilename?.value.trim() || null;
    
    // 智能镜像检测
    let finalUrl = url;
    let mirrorInfo = null;
    let mirrorUrls = []; // 备用镜像 URL 列表
    
    if (isAutoDetectEnabled()) {
        // 显示检测中状态
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.innerHTML = '<i class="ri-loader-4-line spinning"></i> 检测中...';
        }
        showMirrorTip('正在选择最优线路...', 'info');
        
        try {
            mirrorInfo = await mirrorDetector.getBestMirror(url);
            finalUrl = mirrorInfo.url;
            
            // 获取所有备用镜像 URL（排除已选中的）
            const allMirrors = mirrorDetector.getAllMirrorUrls(url);
            mirrorUrls = allMirrors
                .filter(m => m.url !== finalUrl)
                .map(m => m.url);
            
            if (mirrorInfo.isAccelerated) {
                const mirrorCount = mirrorUrls.length;
                showMirrorTip(`使用 ${mirrorInfo.sourceName} 加速${mirrorCount > 0 ? ` | ${mirrorCount} 个备用镜像` : ''}`, 'success');
            } else if (mirrorInfo.reason) {
                showMirrorTip(mirrorInfo.reason, 'warning');
            }
        } catch (error) {
            console.error('镜像检测失败:', error);
            showMirrorTip('镜像检测失败，将使用原始链接', 'warning');
        }
        
        // 恢复按钮状态
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.innerHTML = '<i class="ri-download-2-line"></i> 开始下载';
        }
    }
    
    // 调用 Tauri API 开始下载
    if (tauriInvoke) {
        try {
            // 调试输出
            console.log('下载参数:', {
                url: finalUrl,
                mirrorUrls: mirrorUrls,
                mirrorCount: mirrorUrls.length
            });
            
            await tauriInvoke('start_download', {
                url: finalUrl,
                savePath: downloadPath,
                customFilename: filename,
                mirrorUrls: mirrorUrls.length > 0 ? mirrorUrls : null // Tauri 会自动转换为 snake_case
            });
            
            // 清空输入框
            if (urlInput) urlInput.value = '';
            if (customFilename) customFilename.value = '';
            
            // 隐藏镜像提示
            hideMirrorTip();
            
            // 显示成功反馈
            showDownloadAddedFeedback();
            showToast('下载任务已添加', 'success');
        } catch (error) {
            console.error('启动下载失败:', error);
            showToast(`下载失败: ${error}`, 'error');
        }
    } else {
        // 非 Tauri 环境，显示提示
        showToast('下载功能需要在桌面应用中使用', 'warning');
        console.log('模拟下载:', { url, filename, savePath: downloadPath });
    }
}

/**
 * 切换高级选项显示
 */
function toggleAdvancedOptions() {
    const advancedOptions = document.getElementById('advancedOptions');
    const toggleBtn = document.getElementById('toggleAdvancedBtn');
    const arrow = toggleBtn?.querySelector('.toggle-arrow');
    
    if (advancedOptions) {
        const isOpen = advancedOptions.classList.toggle('open');
        arrow?.classList.toggle('rotated', isOpen);
    }
}

/**
 * 浏览保存路径
 */
async function handleBrowsePath() {
    if (tauriDialog) {
        try {
            const selected = await tauriDialog.open({
                directory: true,
                multiple: false,
                title: '选择下载保存目录'
            });
            
            if (selected) {
                tempSavePath = selected;
                const savePathInput = document.getElementById('savePath');
                if (savePathInput) {
                    savePathInput.value = selected;
                }
            }
        } catch (error) {
            console.error('选择目录失败:', error);
            showToast('选择目录失败', 'error');
        }
    } else {
        showToast('目录选择功能需要在桌面应用中使用', 'warning');
    }
}

/**
 * 显示下载添加成功反馈
 */
function showDownloadAddedFeedback() {
    const btn = document.getElementById('startDownloadBtn');
    if (!btn) return;
    
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<i class="ri-check-line"></i> 已添加';
    btn.classList.add('success');
    
    setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.classList.remove('success');
    }, 1500);
}

/**
 * 筛选任务
 */
function filterTasks(filter) {
    const tasks = document.querySelectorAll('.task-card');
    tasks.forEach(task => {
        if (filter === 'all') {
            task.style.display = '';
        } else if (filter === 'downloading') {
            task.style.display = task.classList.contains('downloading') ? '' : 'none';
        } else if (filter === 'completed') {
            task.style.display = task.classList.contains('completed') ? '' : 'none';
        }
    });
}

/**
 * 搜索任务
 */
function searchTasks(keyword) {
    const tasks = document.querySelectorAll('.task-card');
    const lowerKeyword = keyword.toLowerCase();
    
    tasks.forEach(task => {
        const fileName = task.querySelector('.file-name')?.textContent.toLowerCase() || '';
        task.style.display = fileName.includes(lowerKeyword) ? '' : 'none';
    });
}

/**
 * 更新统计数据
 */
function updateStats() {
    let downloading = 0;
    let completed = 0;
    let failed = 0;
    let totalSpeed = 0;
    
    downloadTasks.forEach(task => {
        if (task.status === 'downloading') {
            downloading++;
            totalSpeed += task.speed || 0;
        } else if (task.status === 'completed') {
            completed++;
        } else if (task.status === 'error') {
            failed++;
        }
    });
    
    const statDownloading = document.getElementById('statDownloading');
    const statCompleted = document.getElementById('statCompleted');
    const statFailed = document.getElementById('statFailed');
    const statSpeed = document.getElementById('statSpeed');
    
    if (statDownloading) statDownloading.textContent = downloading;
    if (statCompleted) statCompleted.textContent = completed;
    if (statFailed) statFailed.textContent = failed;
    if (statSpeed) statSpeed.textContent = formatSpeed(totalSpeed);
}

/**
 * 添加下载项
 * @param {Object} downloadItem - 下载项信息
 */
export function addDownloadItem(downloadItem) {
    addTaskToList(downloadItem);
}

/**
 * 更新下载进度
 * @param {string} id - 下载项ID
 * @param {number} progress - 进度百分比 (0-100)
 */
export function updateDownloadProgress(id, progress) {
    const task = downloadTasks.find(t => t.id === id);
    if (task) {
        task.downloaded = progress;
        renderTaskList();
        updateStats();
    }
}

/**
 * 加载已有任务
 */
async function loadExistingTasks() {
    if (!tauriInvoke) return;
    
    try {
        const tasks = await tauriInvoke('get_download_tasks');
        downloadTasks = tasks || [];
        renderTaskList();
        updateStats();
        updateEmptyState();
    } catch (error) {
        console.error('加载任务列表失败:', error);
    }
}

/**
 * 添加任务到列表
 */
function addTaskToList(task) {
    // 检查是否已存在
    const existingIndex = downloadTasks.findIndex(t => t.id === task.id);
    if (existingIndex >= 0) {
        downloadTasks[existingIndex] = task;
    } else {
        downloadTasks.unshift(task); // 添加到开头
    }
    if (renderingSuspended) return;
    renderTaskList();
    updateStats();
    updateEmptyState();
}

/**
 * 从后端更新任务
 */
function updateTaskFromBackend(task) {
    const index = downloadTasks.findIndex(t => t.id === task.id);
    if (index >= 0) {
        downloadTasks[index] = task;
        if (renderingSuspended) return;
        renderTaskList();
        updateStats();
        
        // 如果完成，显示通知
        if (task.status === 'completed') {
            showToast(`${task.filename} 下载完成`, 'success');
        } else if (task.status === 'error') {
            showToast(`${task.filename} 下载失败: ${task.error_message || '未知错误'}`, 'error');
        }
    }
}

/**
 * 更新任务重试状态
 */
function updateTaskRetryStatus(taskId, attempt) {
    if (renderingSuspended) return;
    const taskCard = document.querySelector(`[data-task-id="${taskId}"]`);
    if (!taskCard) return;
    
    // 在任务卡片上显示重试信息
    const fileStatus = taskCard.querySelector('.file-status');
    if (fileStatus) {
        fileStatus.innerHTML = `
            <span class="retry-badge">
                <i class="ri-refresh-line spinning"></i>
                正在尝试镜像 ${attempt}...
            </span>
        `;
    }
    
    // 重置进度条
    const progressBar = taskCard.querySelector('.progress-bar');
    if (progressBar) {
        progressBar.style.width = '0%';
    }
}

/**
 * 更新任务进度
 */
function updateTaskProgress(progress) {
    // 更新本地状态
    const task = downloadTasks.find(t => t.id === progress.id);
    if (task) {
        task.downloaded = progress.downloaded;
        task.total_size = progress.total_size;
        task.speed = progress.speed;
    }

    if (renderingSuspended) return;
    const taskCard = document.querySelector(`[data-task-id="${progress.id}"]`);
    if (!taskCard) return;
    
    // 更新 UI
    const progressBar = taskCard.querySelector('.progress-bar');
    const progressPercentage = taskCard.querySelector('.progress-percentage');
    const progressText = taskCard.querySelector('.progress-text');
    const badge = taskCard.querySelector('.badge');
    const fileStatus = taskCard.querySelector('.file-status');
    const speedBadge = taskCard.querySelector('.speed-badge');
    
    if (progressBar) {
        progressBar.style.width = `${progress.percentage}%`;
    }
    if (progressPercentage) {
        progressPercentage.textContent = `${progress.percentage}%`;
    }
    if (badge) {
        badge.textContent = `${progress.percentage}%`;
    }
    
    // 更新状态信息
    if (fileStatus) {
        const downloadedStr = formatFileSize(progress.downloaded);
        const totalStr = formatFileSize(progress.total_size);
        const speedStr = formatSpeed(progress.speed);
        
        fileStatus.innerHTML = `
            <span>${downloadedStr} / ${totalStr}</span>
            <span class="speed-badge">${speedStr}/s</span>
        `;
    }
    
    // 更新剩余时间
    if (progressText && progress.speed > 0 && progress.total_size > 0) {
        const remaining = (progress.total_size - progress.downloaded) / progress.speed;
        progressText.textContent = `剩余时间: ${formatTime(remaining)}`;
    }
    
    // 更新统计
    updateStats();
}

/**
 * 渲染任务列表
 */
function renderTaskList() {
    const listContainer = document.getElementById('downloadsList');
    if (!listContainer) return;
    
    listContainer.innerHTML = downloadTasks.map(task => renderTaskCard(task)).join('');

    listContainer.querySelectorAll('.progress-bar[data-progress]').forEach(progressBar => {
        progressBar.style.width = `${progressBar.dataset.progress}%`;
    });
    
    // 绑定任务按钮事件
    bindTaskButtonEvents();
}

/**
 * 渲染单个任务卡片
 */
function renderTaskCard(task) {
    const percentage = task.total_size > 0 
        ? Math.round((task.downloaded / task.total_size) * 100) 
        : 0;
    
    const fileIcon = getFileIcon(task.filename);
    const statusClass = DOWNLOAD_STATUS_CLASSES.has(task.status) ? task.status : 'error';
    const badgeText = getBadgeText(task.status, percentage);
    const safeTaskId = escapeAttribute(task.id);
    const safePath = escapeAttribute(task.save_path);
    const safeUrl = escapeAttribute(task.url);
    const safeFilename = escapeAttribute(task.filename);
    
    let statusInfo = '';
    let progressSection = '';
    let controlButtons = '';
    
    if (task.status === 'downloading') {
        const downloadedStr = formatFileSize(task.downloaded);
        const totalStr = formatFileSize(task.total_size);
        const speedStr = formatSpeed(task.speed);
        const remainingTime = task.speed > 0 && task.total_size > 0
            ? formatTime((task.total_size - task.downloaded) / task.speed)
            : '计算中...';
        
        statusInfo = `
            <span>${downloadedStr} / ${totalStr}</span>
            <span class="speed-badge">${speedStr}/s</span>
        `;
        
        progressSection = `
            <div class="progress-section">
                <div class="progress-header">
                    <span class="progress-text">剩余时间: ${remainingTime}</span>
                    <span class="progress-percentage">${percentage}%</span>
                </div>
                <div class="progress-container">
                    <div class="progress-bar" data-progress="${percentage}"></div>
                </div>
            </div>
        `;
        
        controlButtons = `
            <button class="task-btn btn-open-folder" data-path="${safePath}">
                <i class="ri-folder-open-line"></i>
                打开目录
            </button>
            <button class="task-btn danger btn-cancel" data-id="${safeTaskId}">
                <i class="ri-close-line"></i>
                取消
            </button>
        `;
    } else if (task.status === 'completed') {
        const totalStr = formatFileSize(task.total_size);
        statusInfo = `<span>${totalStr} • 已完成</span>`;
        
        progressSection = `
            <div class="progress-section">
                <div class="progress-container">
                    <div class="progress-bar completed" data-progress="100"></div>
                </div>
            </div>
        `;
        
        controlButtons = `
            <button class="task-btn success btn-open-file" data-path="${safePath}">
                <i class="ri-play-line"></i>
                打开文件
            </button>
            <button class="task-btn btn-open-folder" data-path="${safePath}">
                <i class="ri-folder-open-line"></i>
                打开目录
            </button>
            <button class="task-btn danger btn-remove" data-id="${safeTaskId}">
                <i class="ri-delete-bin-line"></i>
                删除记录
            </button>
        `;
    } else if (task.status === 'error') {
        statusInfo = `<span>${escapeHtml(task.error_message || '下载失败')}</span>`;
        
        const downloadedStr = formatFileSize(task.downloaded);
        progressSection = `
            <div class="progress-section">
                <div class="progress-header">
                    <span class="progress-text">已下载: ${downloadedStr}</span>
                    <span class="progress-percentage">${percentage}%</span>
                </div>
                <div class="progress-container">
                    <div class="progress-bar error" data-progress="${percentage}"></div>
                </div>
            </div>
        `;
        
        controlButtons = `
            <button class="task-btn primary btn-retry" data-task-id="${safeTaskId}" data-url="${safeUrl}" data-path="${safePath}" data-filename="${safeFilename}">
                <i class="ri-refresh-line"></i>
                重试
            </button>
            <button class="task-btn btn-copy-link" data-url="${safeUrl}">
                <i class="ri-file-copy-line"></i>
                复制链接
            </button>
            <button class="task-btn danger btn-remove" data-id="${safeTaskId}">
                <i class="ri-delete-bin-line"></i>
                删除
            </button>
        `;
    }
    
    return `
        <div class="task-card ${statusClass}" data-task-id="${safeTaskId}">
            <div class="task-header">
                <div class="task-info">
                    <div class="file-icon">
                        <i class="${fileIcon}"></i>
                    </div>
                    <div class="file-details">
                        <span class="file-name">${escapeHtml(task.filename)}</span>
                        <div class="file-status">
                            ${statusInfo}
                        </div>
                    </div>
                </div>
                <span class="badge ${statusClass}">${badgeText}</span>
            </div>
            
            ${progressSection}

            <div class="task-controls">
                ${controlButtons}
            </div>
        </div>
    `;
}

/**
 * 绑定任务按钮事件
 */
function bindTaskButtonEvents() {
    // 取消下载
    document.querySelectorAll('.btn-cancel').forEach(btn => {
        btn.addEventListener('click', async () => {
            const taskId = btn.dataset.id;
            if (tauriInvoke) {
                try {
                    await tauriInvoke('cancel_download', { taskId });
                    downloadTasks = downloadTasks.filter(t => t.id !== taskId);
                    renderTaskList();
                    updateStats();
                    updateEmptyState();
                    showToast('下载已取消', 'info');
                } catch (error) {
                    showToast('取消失败: ' + error, 'error');
                }
            }
        });
    });
    
    // 删除记录
    document.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
            const taskId = btn.dataset.id;
            if (tauriInvoke) {
                try {
                    await tauriInvoke('remove_download_record', { taskId });
                    downloadTasks = downloadTasks.filter(t => t.id !== taskId);
                    renderTaskList();
                    updateStats();
                    updateEmptyState();
                } catch (error) {
                    showToast('删除失败: ' + error, 'error');
                }
            }
        });
    });
    
    // 打开文件
    document.querySelectorAll('.btn-open-file').forEach(btn => {
        btn.addEventListener('click', async () => {
            const path = btn.dataset.path;
            if (tauriInvoke) {
                try {
                    await tauriInvoke('open_file', { path });
                } catch (error) {
                    showToast('打开文件失败: ' + error, 'error');
                }
            }
        });
    });
    
    // 打开目录
    document.querySelectorAll('.btn-open-folder').forEach(btn => {
        btn.addEventListener('click', async () => {
            const path = btn.dataset.path;
            if (tauriInvoke) {
                try {
                    await tauriInvoke('open_file_location', { path });
                } catch (error) {
                    showToast('打开目录失败: ' + error, 'error');
                }
            }
        });
    });
    
    // 重试下载
    document.querySelectorAll('.btn-retry').forEach(btn => {
        btn.addEventListener('click', async () => {
            const taskId = btn.dataset.taskId;
            const url = btn.dataset.url;
            const savePath = btn.dataset.path;
            const filename = btn.dataset.filename;
            
            if (tauriInvoke) {
                try {
                    // 删除失败的任务卡片
                    const taskCard = btn.closest('.download-card');
                    if (taskCard) {
                        taskCard.remove();
                    }
                    
                    // 从任务列表中移除
                    const taskIndex = downloadTasks.findIndex(t => t.id === taskId);
                    if (taskIndex !== -1) {
                        downloadTasks.splice(taskIndex, 1);
                    }
                    
                    // 删除后端记录
                    if (taskId) {
                        try {
                            await tauriInvoke('remove_download_record', { taskId: taskId });
                        } catch (e) {
                            console.log('删除记录失败:', e);
                        }
                    }
                    
                    // 获取目录路径
                    const dirPath = savePath.substring(0, savePath.lastIndexOf('\\')) || savePath.substring(0, savePath.lastIndexOf('/'));
                    await tauriInvoke('start_download', {
                        url: url,
                        savePath: dirPath,
                        customFilename: filename
                    });
                    
                    showToast('重新开始下载', 'success');
                    updateStats();
                } catch (error) {
                    showToast('重试失败: ' + error, 'error');
                }
            }
        });
    });
    
    // 复制链接
    document.querySelectorAll('.btn-copy-link').forEach(btn => {
        btn.addEventListener('click', async () => {
            const url = btn.dataset.url;
            try {
                await navigator.clipboard.writeText(url);
                showToast('链接已复制', 'success');
            } catch (error) {
                showToast('复制失败', 'error');
            }
        });
    });
}

/**
 * 更新空状态显示
 */
function updateEmptyState() {
    const emptyState = document.getElementById('emptyState');
    const tasksList = document.getElementById('downloadsList');
    
    if (downloadTasks.length === 0) {
        if (emptyState) emptyState.style.display = 'flex';
        if (tasksList) tasksList.style.display = 'none';
    } else {
        if (emptyState) emptyState.style.display = 'none';
        if (tasksList) tasksList.style.display = '';
    }
}

/**
 * 获取文件图标
 */
function getFileIcon(filename) {
    if (!filename) return 'ri-file-line';
    
    const ext = filename.split('.').pop()?.toLowerCase();
    const iconMap = {
        // 压缩文件
        'zip': 'ri-file-zip-line',
        'rar': 'ri-file-zip-line',
        '7z': 'ri-file-zip-line',
        'tar': 'ri-file-zip-line',
        'gz': 'ri-file-zip-line',
        // 图片
        'jpg': 'ri-image-line',
        'jpeg': 'ri-image-line',
        'png': 'ri-image-line',
        'gif': 'ri-image-line',
        'webp': 'ri-image-line',
        'svg': 'ri-image-line',
        'psd': 'ri-image-line',
        // 视频
        'mp4': 'ri-video-line',
        'mkv': 'ri-video-line',
        'avi': 'ri-video-line',
        'mov': 'ri-video-line',
        'wmv': 'ri-video-line',
        // 音频
        'mp3': 'ri-music-line',
        'wav': 'ri-music-line',
        'flac': 'ri-music-line',
        'aac': 'ri-music-line',
        // 文档
        'pdf': 'ri-file-pdf-line',
        'doc': 'ri-file-word-line',
        'docx': 'ri-file-word-line',
        'xls': 'ri-file-excel-line',
        'xlsx': 'ri-file-excel-line',
        'ppt': 'ri-file-ppt-line',
        'pptx': 'ri-file-ppt-line',
        'txt': 'ri-file-text-line',
        // 代码
        'js': 'ri-file-code-line',
        'ts': 'ri-file-code-line',
        'html': 'ri-file-code-line',
        'css': 'ri-file-code-line',
        'json': 'ri-file-code-line',
        // 可执行
        'exe': 'ri-install-line',
        'msi': 'ri-install-line',
        'dmg': 'ri-install-line',
        'deb': 'ri-install-line',
        'rpm': 'ri-install-line',
    };
    
    return iconMap[ext] || 'ri-file-line';
}

/**
 * 获取状态徽章文本
 */
function getBadgeText(status, percentage) {
    switch (status) {
        case 'downloading': return `${percentage}%`;
        case 'completed': return '已完成';
        case 'error': return '失败';
        case 'paused': return '已暂停';
        default: return status;
    }
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

/**
 * 格式化速度
 */
function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond === 0) return '0 B';
    
    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    
    return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + ' ' + units[i];
}

/**
 * 格式化时间
 */
function formatTime(seconds) {
    if (!seconds || seconds <= 0) return '计算中...';
    
    if (seconds < 60) {
        return `约 ${Math.round(seconds)} 秒`;
    } else if (seconds < 3600) {
        return `约 ${Math.round(seconds / 60)} 分钟`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.round((seconds % 3600) / 60);
        return `约 ${hours} 小时 ${minutes} 分钟`;
    }
}
