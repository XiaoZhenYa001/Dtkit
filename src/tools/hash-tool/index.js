/**
 * Hash 计算工具 - 玻璃拟态风格
 * 计算文本或文件的哈希值 (MD5, SHA-1, SHA-256, SHA-512)
 */
import { registerTool } from '../toolRegistry.js';

// ============================================
// 工具状态
// ============================================
const hashState = {
    selectedFile: null,
    isCalculating: false,
    results: {},
    algorithms: {
        md5: true,
        sha1: true,
        sha256: true,
        sha512: false
    },
    uppercase: true,
    verifyHash: '',
    unlistenProgress: null
};

// ============================================
// HTML 模板
// ============================================
function getTemplate() {
    return `
        <div class="view-container hash-tool-view">
            <div class="hash-glass-container">
                <!-- 主操作区 -->
                <div class="hash-main-panel">
                    <div class="hash-header-title">
                        <h1>哈希校验工具</h1>
                        <p>输入文本或上传文件，即刻生成安全校验指纹</p>
                    </div>

                    <!-- 文本输入 -->
                    <div class="hash-content-card">
                        <textarea id="hashTextInput" class="hash-textarea" 
                            placeholder="输入需要计算哈希值的文本内容..."></textarea>
                    </div>

                    <!-- 文件上传 -->
                    <div id="hashFileUpload" class="hash-file-upload">
                        <i class="ri-upload-cloud-2-line"></i>
                        <span>将文件拖放到此处，或 <b>点击浏览</b></span>
                    </div>

                    <!-- 隐藏的文件输入 -->
                    <input type="file" id="hashFileInput" style="display: none;">

                    <!-- 进度条 -->
                    <div id="hashProgressContainer" class="hash-progress-container">
                        <div id="hashProgressBar" class="hash-progress-bar"></div>
                    </div>

                    <!-- 结果区域 -->
                    <div class="hash-results-container">
                        <span class="hash-section-label">计算结果</span>
                        <div id="hashResultsList">
                            <div class="hash-empty-results">
                                <i class="ri-shield-check-line"></i>
                                <p>输入文本或选择文件后点击计算</p>
                            </div>
                        </div>
                    </div>

                    <!-- 校验区域 -->
                    <div class="hash-verify-section">
                        <span class="hash-section-label">哈希校验</span>
                        <input type="text" id="hashVerifyInput" class="hash-verify-input"
                            placeholder="粘贴要校验的哈希值...">
                        <div id="hashVerifyResult" class="hash-verify-result"></div>
                    </div>
                </div>

                <!-- 右侧配置面板 -->
                <div class="hash-config-panel">
                    <span class="hash-section-label">算法配置</span>
                    
                    <div class="hash-switch-group">
                        <span>MD5</span>
                        <div class="hash-switch active" data-algo="md5"></div>
                    </div>
                    <div class="hash-switch-group">
                        <span>SHA-1</span>
                        <div class="hash-switch active" data-algo="sha1"></div>
                    </div>
                    <div class="hash-switch-group">
                        <span>SHA-256</span>
                        <div class="hash-switch active" data-algo="sha256"></div>
                    </div>
                    <div class="hash-switch-group">
                        <span>SHA-512</span>
                        <div class="hash-switch" data-algo="sha512"></div>
                    </div>
                    
                    <div class="hash-switch-group" style="margin-top: 20px; border-top: 1px solid rgba(203, 213, 225, 0.3); padding-top: 20px;">
                        <span>大写输出</span>
                        <div class="hash-switch active" data-option="uppercase"></div>
                    </div>

                    <button id="hashCalculateBtn" class="hash-btn-calculate">
                        <i class="ri-shield-flash-line"></i> 立即计算
                    </button>

                    <div class="hash-security-tip">
                        <b>🔒 安全提示</b>
                        所有计算均在本地完成，不会上传您的文件或文本到任何服务器。
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ============================================
// CSS 样式（引用外部文件）
// ============================================
function getStyles() {
    // 样式已在 hash-tool.css 中定义，这里返回空或补充样式
    return ``;
}

// ============================================
// 初始化函数
// ============================================
async function init() {
    console.log('[HashTool] 初始化哈希工具');
    
    // 绑定事件
    bindEvents();
    
    // 监听后端进度事件
    await setupProgressListener();
}

// ============================================
// 绑定事件
// ============================================
function bindEvents() {
    // 计算按钮
    const calculateBtn = document.getElementById('hashCalculateBtn');
    if (calculateBtn) {
        calculateBtn.addEventListener('click', handleCalculate);
    }
    
    // 文件上传区域
    const fileUpload = document.getElementById('hashFileUpload');
    const fileInput = document.getElementById('hashFileInput');
    
    if (fileUpload && fileInput) {
        fileUpload.addEventListener('click', () => fileInput.click());
        
        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                selectFile(e.target.files[0]);
            }
        });
        
        // 拖放支持
        fileUpload.addEventListener('dragover', (e) => {
            e.preventDefault();
            fileUpload.classList.add('dragover');
        });
        
        fileUpload.addEventListener('dragleave', () => {
            fileUpload.classList.remove('dragover');
        });
        
        fileUpload.addEventListener('drop', (e) => {
            e.preventDefault();
            fileUpload.classList.remove('dragover');
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                selectFile(e.dataTransfer.files[0]);
            }
        });
    }
    
    // 算法开关
    document.querySelectorAll('.hash-switch[data-algo]').forEach(sw => {
        sw.addEventListener('click', () => {
            const algo = sw.dataset.algo;
            hashState.algorithms[algo] = !hashState.algorithms[algo];
            sw.classList.toggle('active', hashState.algorithms[algo]);
        });
    });
    
    // 大写开关
    const uppercaseSwitch = document.querySelector('.hash-switch[data-option="uppercase"]');
    if (uppercaseSwitch) {
        uppercaseSwitch.addEventListener('click', () => {
            hashState.uppercase = !hashState.uppercase;
            uppercaseSwitch.classList.toggle('active', hashState.uppercase);
            // 如果已有结果，重新格式化
            if (Object.keys(hashState.results).length > 0) {
                renderResults();
            }
        });
    }
    
    // 校验输入
    const verifyInput = document.getElementById('hashVerifyInput');
    if (verifyInput) {
        verifyInput.addEventListener('input', (e) => {
            hashState.verifyHash = e.target.value.trim();
            verifyHash();
        });
    }
    
    // 文本输入变化时清除文件选择
    const textInput = document.getElementById('hashTextInput');
    if (textInput) {
        textInput.addEventListener('input', () => {
            if (textInput.value.trim() && hashState.selectedFile) {
                clearFile();
            }
        });
    }
}

// ============================================
// 设置进度监听
// ============================================
async function setupProgressListener() {
    try {
        if (window.__TAURI__?.event?.listen) {
            hashState.unlistenProgress = await window.__TAURI__.event.listen('hash-progress', (event) => {
                const { progress } = event.payload;
                updateProgress(progress);
            });
        }
    } catch (err) {
        console.warn('[HashTool] 无法设置进度监听:', err);
    }
}

// ============================================
// 选择文件
// ============================================
function selectFile(file) {
    hashState.selectedFile = file;
    
    // 清空文本输入
    const textInput = document.getElementById('hashTextInput');
    if (textInput) textInput.value = '';
    
    // 更新 UI
    const fileUpload = document.getElementById('hashFileUpload');
    if (fileUpload) {
        fileUpload.innerHTML = `
            <div class="hash-file-info">
                <i class="ri-file-3-line" style="font-size: 1.5rem; color: #6366f1;"></i>
                <span class="file-name">${escapeHtml(file.name)}</span>
                <span class="file-size">(${formatFileSize(file.size)})</span>
                <button class="hash-clear-file" onclick="window.__hashTool_clearFile()">
                    <i class="ri-close-line"></i>
                </button>
            </div>
        `;
    }
    
    // 暴露清除函数
    window.__hashTool_clearFile = clearFile;
}

// ============================================
// 清除文件
// ============================================
function clearFile() {
    hashState.selectedFile = null;
    
    const fileUpload = document.getElementById('hashFileUpload');
    if (fileUpload) {
        fileUpload.innerHTML = `
            <i class="ri-upload-cloud-2-line"></i>
            <span>将文件拖放到此处，或 <b>点击浏览</b></span>
        `;
    }
    
    const fileInput = document.getElementById('hashFileInput');
    if (fileInput) fileInput.value = '';
}

// ============================================
// 处理计算
// ============================================
async function handleCalculate() {
    if (hashState.isCalculating) return;
    
    const textInput = document.getElementById('hashTextInput');
    const text = textInput?.value || '';
    
    // 获取选中的算法
    const selectedAlgorithms = Object.entries(hashState.algorithms)
        .filter(([_, enabled]) => enabled)
        .map(([algo]) => algo);
    
    if (selectedAlgorithms.length === 0) {
        showToast('请至少选择一种算法', 'warning');
        return;
    }
    
    if (!text.trim() && !hashState.selectedFile) {
        showToast('请输入文本或选择文件', 'warning');
        return;
    }
    
    hashState.isCalculating = true;
    updateCalculateButton(true);
    
    try {
        if (hashState.selectedFile) {
            await calculateFileHash(selectedAlgorithms);
        } else {
            await calculateTextHash(text, selectedAlgorithms);
        }
    } catch (err) {
        console.error('[HashTool] 计算失败:', err);
        showToast('计算失败: ' + err.message, 'error');
    } finally {
        hashState.isCalculating = false;
        updateCalculateButton(false);
        hideProgress();
    }
}

// ============================================
// 计算文本哈希
// ============================================
async function calculateTextHash(text, algorithms) {
    showProgress();
    updateProgress(50);
    
    try {
        if (window.__TAURI__?.core?.invoke) {
            // 使用 Rust 后端
            const results = await window.__TAURI__.core.invoke('calculate_text_hash', {
                text,
                algorithms,
                uppercase: hashState.uppercase
            });
            hashState.results = results;
        } else {
            // 浏览器环境 fallback
            hashState.results = await calculateTextHashJS(text, algorithms);
        }
        
        updateProgress(100);
        renderResults();
        verifyHash();
        showToast('计算完成', 'success');
    } catch (err) {
        throw err;
    }
}

// ============================================
// 计算文件哈希
// ============================================
async function calculateFileHash(algorithms) {
    const file = hashState.selectedFile;
    if (!file) return;
    
    showProgress();
    
    try {
        if (window.__TAURI__?.core?.invoke) {
            // Tauri 环境 - 需要获取文件路径
            // 由于 Web File API 无法直接获取路径，需要使用对话框
            const { open } = window.__TAURI__.dialog;
            
            // 使用对话框选择文件获取路径
            const filePath = await open({
                multiple: false,
                title: '选择要计算哈希的文件',
                defaultPath: file.name
            });
            
            if (!filePath) {
                showToast('未选择文件', 'warning');
                return;
            }
            
            const taskId = Date.now().toString();
            const results = await window.__TAURI__.core.invoke('calculate_file_hash', {
                filePath,
                algorithms,
                uppercase: hashState.uppercase,
                taskId
            });
            
            hashState.results = results;
        } else {
            // 浏览器环境 fallback
            hashState.results = await calculateFileHashJS(file, algorithms);
        }
        
        updateProgress(100);
        renderResults();
        verifyHash();
        showToast('计算完成', 'success');
    } catch (err) {
        throw err;
    }
}

// ============================================
// JavaScript 文本哈希计算 (Fallback)
// ============================================
async function calculateTextHashJS(text, algorithms) {
    const results = {};
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    
    for (const algo of algorithms) {
        try {
            let hashBuffer;
            const algoMap = {
                'md5': 'MD5', // Web Crypto 不支持 MD5
                'sha1': 'SHA-1',
                'sha256': 'SHA-256',
                'sha512': 'SHA-512'
            };
            
            const cryptoAlgo = algoMap[algo];
            if (cryptoAlgo && cryptoAlgo !== 'MD5') {
                hashBuffer = await crypto.subtle.digest(cryptoAlgo, data);
                let hash = Array.from(new Uint8Array(hashBuffer))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
                results[algo] = hashState.uppercase ? hash.toUpperCase() : hash;
            } else if (algo === 'md5') {
                // MD5 需要额外实现或跳过
                results[algo] = '(浏览器不支持 MD5，请使用桌面版)';
            }
        } catch (err) {
            console.error(`[HashTool] ${algo} 计算失败:`, err);
        }
    }
    
    return results;
}

// ============================================
// JavaScript 文件哈希计算 (Fallback)
// ============================================
async function calculateFileHashJS(file, algorithms) {
    const results = {};
    const buffer = await file.arrayBuffer();
    
    for (const algo of algorithms) {
        try {
            const algoMap = {
                'sha1': 'SHA-1',
                'sha256': 'SHA-256',
                'sha512': 'SHA-512'
            };
            
            const cryptoAlgo = algoMap[algo];
            if (cryptoAlgo) {
                const hashBuffer = await crypto.subtle.digest(cryptoAlgo, buffer);
                let hash = Array.from(new Uint8Array(hashBuffer))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
                results[algo] = hashState.uppercase ? hash.toUpperCase() : hash;
            } else if (algo === 'md5') {
                results[algo] = '(浏览器不支持 MD5)';
            }
        } catch (err) {
            console.error(`[HashTool] ${algo} 计算失败:`, err);
        }
    }
    
    return results;
}

// ============================================
// 渲染结果
// ============================================
function renderResults() {
    const container = document.getElementById('hashResultsList');
    if (!container) return;
    
    const results = hashState.results;
    if (Object.keys(results).length === 0) {
        container.innerHTML = `
            <div class="hash-empty-results">
                <i class="ri-shield-check-line"></i>
                <p>输入文本或选择文件后点击计算</p>
            </div>
        `;
        return;
    }
    
    const algoOrder = ['md5', 'sha1', 'sha256', 'sha512'];
    const algoNames = {
        'md5': 'MD5',
        'sha1': 'SHA-1',
        'sha256': 'SHA-256',
        'sha512': 'SHA-512'
    };
    
    let html = '';
    for (const algo of algoOrder) {
        if (results[algo]) {
            const hash = hashState.uppercase ? results[algo].toUpperCase() : results[algo].toLowerCase();
            html += `
                <div class="hash-result-pill" data-algo="${algo}">
                    <span class="hash-algo-tag">${algoNames[algo]}</span>
                    <span class="hash-string" title="${hash}">${hash}</span>
                    <button class="hash-copy-btn" data-hash="${hash}">
                        <i class="ri-file-copy-line"></i> 复制
                    </button>
                </div>
            `;
        }
    }
    
    container.innerHTML = html;
    
    // 绑定复制事件
    container.querySelectorAll('.hash-copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const hash = btn.dataset.hash;
            try {
                await navigator.clipboard.writeText(hash);
                btn.innerHTML = '<i class="ri-check-line"></i> 已复制';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.innerHTML = '<i class="ri-file-copy-line"></i> 复制';
                    btn.classList.remove('copied');
                }, 1500);
            } catch (err) {
                showToast('复制失败', 'error');
            }
        });
    });
}

// ============================================
// 校验哈希
// ============================================
function verifyHash() {
    const verifyResult = document.getElementById('hashVerifyResult');
    if (!verifyResult) return;
    
    const inputHash = hashState.verifyHash.toLowerCase().replace(/\s/g, '');
    if (!inputHash) {
        verifyResult.className = 'hash-verify-result';
        verifyResult.textContent = '';
        return;
    }
    
    // 检查是否匹配任何结果
    let matched = false;
    let matchedAlgo = '';
    
    for (const [algo, hash] of Object.entries(hashState.results)) {
        if (hash.toLowerCase() === inputHash) {
            matched = true;
            matchedAlgo = algo.toUpperCase();
            break;
        }
    }
    
    if (matched) {
        verifyResult.className = 'hash-verify-result match';
        verifyResult.innerHTML = `<i class="ri-check-line"></i> 校验通过！匹配 ${matchedAlgo} 算法`;
    } else if (Object.keys(hashState.results).length > 0) {
        verifyResult.className = 'hash-verify-result mismatch';
        verifyResult.innerHTML = `<i class="ri-close-line"></i> 校验失败，哈希值不匹配`;
    }
}

// ============================================
// UI 辅助函数
// ============================================
function showProgress() {
    const container = document.getElementById('hashProgressContainer');
    if (container) container.classList.add('active');
}

function hideProgress() {
    const container = document.getElementById('hashProgressContainer');
    const bar = document.getElementById('hashProgressBar');
    if (container) container.classList.remove('active');
    if (bar) bar.style.width = '0%';
}

function updateProgress(percent) {
    const bar = document.getElementById('hashProgressBar');
    if (bar) bar.style.width = `${Math.min(100, percent)}%`;
}

function updateCalculateButton(calculating) {
    const btn = document.getElementById('hashCalculateBtn');
    if (btn) {
        btn.disabled = calculating;
        btn.innerHTML = calculating 
            ? '<i class="ri-loader-4-line"></i> 计算中...'
            : '<i class="ri-shield-flash-line"></i> 立即计算';
    }
}

function showToast(message, type = 'info') {
    // 使用全局 toast 或自定义实现
    if (window.showToast) {
        window.showToast(message, type);
    } else {
        console.log(`[${type}] ${message}`);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================
// 销毁函数
// ============================================
function destroy() {
    console.log('[HashTool] 销毁哈希工具');
    
    // 清理进度监听
    if (hashState.unlistenProgress) {
        hashState.unlistenProgress();
        hashState.unlistenProgress = null;
    }
    
    // 清理全局函数
    delete window.__hashTool_clearFile;
    
    // 重置状态
    hashState.selectedFile = null;
    hashState.results = {};
    hashState.verifyHash = '';
}

// ============================================
// 注册工具
// ============================================
registerTool({
    id: 'hash-tool',
    name: 'MD5 / Hash',
    icon: 'ri-hashtag',
    description: '计算文本或文件的哈希值 (MD5, SHA-1, SHA-256, SHA-512)',
    category: 'dev',
    template: getTemplate,
    styles: getStyles,
    init,
    destroy
});
