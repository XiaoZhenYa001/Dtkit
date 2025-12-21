/**
 * 下载视图
 * 管理文件下载列表、下载进度、下载历史等功能
 */

// DOM 元素引用
let downloadsContent = null;

/**
 * 初始化下载视图
 */
export function initDownloadsView() {
    downloadsContent = document.getElementById('downloadsContent');
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
                <!-- 示例：正在下载 -->
                <div class="task-card downloading">
                    <div class="task-header">
                        <div class="task-info">
                            <div class="file-icon">
                                <i class="ri-file-zip-line"></i>
                            </div>
                            <div class="file-details">
                                <span class="file-name">node-v20.10.0-win-x64.zip</span>
                                <div class="file-status">
                                    <span>156.2 MB / 240.5 MB</span>
                                    <span class="speed-badge">4.2 MB/s</span>
                                </div>
                            </div>
                        </div>
                        <span class="badge downloading">65%</span>
                    </div>
                    
                    <div class="progress-section">
                        <div class="progress-header">
                            <span class="progress-text">剩余时间: 约 20 秒</span>
                            <span class="progress-percentage">65%</span>
                        </div>
                        <div class="progress-container">
                            <div class="progress-bar" style="width: 65%"></div>
                        </div>
                    </div>

                    <div class="task-controls">
                        <button class="task-btn">
                            <i class="ri-pause-line"></i>
                            暂停
                        </button>
                        <button class="task-btn">
                            <i class="ri-folder-open-line"></i>
                            打开目录
                        </button>
                        <button class="task-btn danger">
                            <i class="ri-close-line"></i>
                            取消
                        </button>
                    </div>
                </div>

                <!-- 示例：下载失败 -->
                <div class="task-card error">
                    <div class="task-header">
                        <div class="task-info">
                            <div class="file-icon">
                                <i class="ri-image-line"></i>
                            </div>
                            <div class="file-details">
                                <span class="file-name">design-assets-v2.psd</span>
                                <div class="file-status">
                                    <span>网络连接失败</span>
                                </div>
                            </div>
                        </div>
                        <span class="badge error">失败</span>
                    </div>
                    
                    <div class="progress-section">
                        <div class="progress-header">
                            <span class="progress-text">已下载: 12.4 MB</span>
                            <span class="progress-percentage">23%</span>
                        </div>
                        <div class="progress-container">
                            <div class="progress-bar error" style="width: 23%"></div>
                        </div>
                    </div>

                    <div class="task-controls">
                        <button class="task-btn primary">
                            <i class="ri-refresh-line"></i>
                            重试
                        </button>
                        <button class="task-btn">
                            <i class="ri-file-copy-line"></i>
                            复制链接
                        </button>
                        <button class="task-btn danger">
                            <i class="ri-delete-bin-line"></i>
                            删除
                        </button>
                    </div>
                </div>

                <!-- 示例：已完成 -->
                <div class="task-card completed">
                    <div class="task-header">
                        <div class="task-info">
                            <div class="file-icon">
                                <i class="ri-video-line"></i>
                            </div>
                            <div class="file-details">
                                <span class="file-name">tutorial-react-basics.mp4</span>
                                <div class="file-status">
                                    <span>1.2 GB • 已于 10 分钟前完成</span>
                                </div>
                            </div>
                        </div>
                        <span class="badge completed">已完成</span>
                    </div>
                    
                    <div class="progress-section">
                        <div class="progress-container">
                            <div class="progress-bar completed" style="width: 100%"></div>
                        </div>
                    </div>

                    <div class="task-controls">
                        <button class="task-btn success">
                            <i class="ri-play-line"></i>
                            打开文件
                        </button>
                        <button class="task-btn">
                            <i class="ri-folder-open-line"></i>
                            打开目录
                        </button>
                        <button class="task-btn danger">
                            <i class="ri-delete-bin-line"></i>
                            删除记录
                        </button>
                    </div>
                </div>

                <!-- 示例：正在下载 2 -->
                <div class="task-card downloading">
                    <div class="task-header">
                        <div class="task-info">
                            <div class="file-icon">
                                <i class="ri-file-text-line"></i>
                            </div>
                            <div class="file-details">
                                <span class="file-name">project-documentation.pdf</span>
                                <div class="file-status">
                                    <span>8.4 MB / 40 MB</span>
                                    <span class="speed-badge">1.8 MB/s</span>
                                </div>
                            </div>
                        </div>
                        <span class="badge downloading">21%</span>
                    </div>
                    
                    <div class="progress-section">
                        <div class="progress-header">
                            <span class="progress-text">剩余时间: 约 18 秒</span>
                            <span class="progress-percentage">21%</span>
                        </div>
                        <div class="progress-container">
                            <div class="progress-bar" style="width: 21%"></div>
                        </div>
                    </div>

                    <div class="task-controls">
                        <button class="task-btn">
                            <i class="ri-pause-line"></i>
                            暂停
                        </button>
                        <button class="task-btn">
                            <i class="ri-folder-open-line"></i>
                            打开目录
                        </button>
                        <button class="task-btn danger">
                            <i class="ri-close-line"></i>
                            取消
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // 绑定事件
    bindDownloadsEvents();
    
    // 更新统计数据
    updateStats();
}

/**
 * 绑定下载页面事件
 */
function bindDownloadsEvents() {
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
            
            ripple.style.cssText = `
                position: absolute;
                width: ${size}px;
                height: ${size}px;
                left: ${x}px;
                top: ${y}px;
                background: rgba(255, 255, 255, 0.3);
                border-radius: 50%;
                transform: scale(0);
                animation: ripple 0.6s ease-out;
                pointer-events: none;
            `;
            
            this.style.position = 'relative';
            this.style.overflow = 'hidden';
            this.appendChild(ripple);
            
            setTimeout(() => ripple.remove(), 600);
        });
    });
    
    // 添加波纹动画样式
    if (!document.getElementById('ripple-style')) {
        const style = document.createElement('style');
        style.id = 'ripple-style';
        style.textContent = `
            @keyframes ripple {
                to {
                    transform: scale(2);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(style);
    }
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
    const tasks = document.querySelectorAll('.task-card');
    let downloading = 0;
    let completed = 0;
    let failed = 0;
    
    tasks.forEach(task => {
        if (task.classList.contains('downloading')) downloading++;
        else if (task.classList.contains('completed')) completed++;
        else if (task.classList.contains('error')) failed++;
    });
    
    const statDownloading = document.getElementById('statDownloading');
    const statCompleted = document.getElementById('statCompleted');
    const statFailed = document.getElementById('statFailed');
    const statSpeed = document.getElementById('statSpeed');
    
    if (statDownloading) statDownloading.textContent = downloading;
    if (statCompleted) statCompleted.textContent = completed;
    if (statFailed) statFailed.textContent = failed;
    if (statSpeed) statSpeed.textContent = downloading > 0 ? '4.2' : '0';
}

/**
 * 添加下载项
 * @param {Object} downloadItem - 下载项信息
 */
export function addDownloadItem(downloadItem) {
    // TODO: 实现添加下载项逻辑
    console.log('添加下载项:', downloadItem);
}

/**
 * 更新下载进度
 * @param {string} id - 下载项ID
 * @param {number} progress - 进度百分比 (0-100)
 */
export function updateDownloadProgress(id, progress) {
    // TODO: 实现更新下载进度逻辑
    console.log('更新下载进度:', id, progress);
}