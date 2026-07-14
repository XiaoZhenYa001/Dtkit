/**
 * Hash 计算工具 - 玻璃拟态风格
 * 计算文本或文件的哈希值 (MD5, SHA-1, SHA-256, SHA-512)
 */
import { registerTool } from '../toolRegistry.js';
import '../../css/tools/hash-tool.css';

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
    unlistenProgress: null,
    abortController: null  // 用于清理事件监听器
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
                    <input type="file" id="hashFileInput" class="is-initially-hidden">

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

                    <div class="hash-switch-group hash-switch-group--separated">
                        <span>大写输出</span>
                        <div class="hash-switch active" data-option="uppercase"></div>
                    </div>

                    <button id="hashCalculateBtn" class="hash-btn-calculate">
                        <i class="ri-shield-flash-line"></i> 立即计算
                    </button>

                    <div class="hash-security-tip">
                        <b><i class="ri-shield-check-line"></i> 安全提示</b>
                        <span>所有计算均在本地完成，不会上传您的文件或文本到任何服务器。</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ============================================
// CSS 样式（引用外部文件）
// ============================================


// ============================================
// 初始化函数
// ============================================
async function init() {
    console.log('[HashTool] 初始化哈希工具');

    // 清理之前的事件监听器
    if (hashState.abortController) {
        hashState.abortController.abort();
    }
    hashState.abortController = new AbortController();

    // 绑定事件
    bindEvents();

    // 监听后端进度事件
    await setupProgressListener();
}

// ============================================
// 绑定事件
// ============================================
function bindEvents() {
    const signal = hashState.abortController?.signal;

    // 计算按钮
    const calculateBtn = document.getElementById('hashCalculateBtn');
    if (calculateBtn) {
        calculateBtn.addEventListener('click', handleCalculate, { signal });
    }

    // 文件上传区域
    const fileUpload = document.getElementById('hashFileUpload');
    const fileInput = document.getElementById('hashFileInput');

    if (fileUpload && fileInput) {
        // 点击上传区域
        fileUpload.addEventListener('click', async () => {
            // 如果已选择文件，则不响应点击
            if (hashState.selectedFile) return;

            // 在 Tauri 环境中使用原生对话框以获取文件路径
            if (window.__TAURI__?.dialog?.open) {
                try {
                    const filePath = await window.__TAURI__.dialog.open({
                        multiple: false,
                        title: '选择文件'
                    });
                    if (filePath) {
                        // 从路径中提取文件名
                        const fileName = filePath.split(/[/\\]/).pop() || '未知文件';
                        // 获取文件信息
                        let fileSize = 0;
                        try {
                            const stat = await window.__TAURI__.fs.stat(filePath);
                            fileSize = stat.size || 0;
                        } catch (e) {
                            console.warn('[HashTool] 无法获取文件大小');
                        }
                        // 创建伪 File 对象
                        const fakeFile = { name: fileName, size: fileSize, path: filePath };
                        selectFile(fakeFile);
                    }
                } catch (err) {
                    console.error('[HashTool] 选择文件失败:', err);
                    // fallback 到原生 input
                    fileInput.click();
                }
            } else {
                // 浏览器环境使用原生 input
                fileInput.click();
            }
        }, { signal });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                selectFile(e.target.files[0]);
            }
        }, { signal });

        // 拖放支持
        fileUpload.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!hashState.selectedFile) {
                fileUpload.classList.add('dragover');
            }
        }, { signal });

        fileUpload.addEventListener('dragleave', () => {
            fileUpload.classList.remove('dragover');
        }, { signal });

        fileUpload.addEventListener('drop', (e) => {
            e.preventDefault();
            fileUpload.classList.remove('dragover');
            // 如果已选择文件，则不响应拖放
            if (hashState.selectedFile) return;
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                selectFile(e.dataTransfer.files[0]);
            }
        }, { signal });
    }

    // 算法开关
    document.querySelectorAll('.hash-switch[data-algo]').forEach(sw => {
        sw.addEventListener('click', () => {
            const algo = sw.dataset.algo;
            hashState.algorithms[algo] = !hashState.algorithms[algo];
            sw.classList.toggle('active', hashState.algorithms[algo]);
        }, { signal });
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
        }, { signal });
    }

    // 校验输入
    const verifyInput = document.getElementById('hashVerifyInput');
    if (verifyInput) {
        verifyInput.addEventListener('input', (e) => {
            hashState.verifyHash = e.target.value.trim();
            verifyHash();
        }, { signal });
    }

    // 文本输入变化时清除文件选择
    const textInput = document.getElementById('hashTextInput');
    if (textInput) {
        textInput.addEventListener('input', () => {
            if (textInput.value.trim() && hashState.selectedFile) {
                clearFile();
            }
        }, { signal });
    }

    // 使用事件委托处理复制按钮点击（避免每次 renderResults 时重复绑定）
    const resultsList = document.getElementById('hashResultsList');
    if (resultsList) {
        resultsList.addEventListener('click', async (e) => {
            const copyBtn = e.target.closest('.hash-copy-btn');
            if (copyBtn) {
                const hash = copyBtn.dataset.hash;
                try {
                    await navigator.clipboard.writeText(hash);
                    copyBtn.innerHTML = '<i class="ri-check-line"></i> 已复制';
                    copyBtn.classList.add('copied');
                    setTimeout(() => {
                        copyBtn.innerHTML = '<i class="ri-file-copy-line"></i> 复制';
                        copyBtn.classList.remove('copied');
                    }, 1500);
                } catch (err) {
                    showToast('复制失败', 'error');
                }
            }
        }, { signal });
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
    // 保存文件路径（如果有的话）
    hashState.selectedFilePath = file.path || null;

    // 清空文本输入
    const textInput = document.getElementById('hashTextInput');
    if (textInput) textInput.value = '';

    // 更新 UI - 选择后禁止点击
    const fileUpload = document.getElementById('hashFileUpload');
    if (fileUpload) {
        fileUpload.style.cursor = 'default';
        fileUpload.style.pointerEvents = 'none';
        fileUpload.innerHTML = `
            <div class="hash-file-info">
                <i class="ri-file-3-line hash-file-info__icon"></i>
                <span class="file-name">${escapeHtml(file.name)}</span>
                <span class="file-size">(${formatFileSize(file.size)})</span>
                <button class="hash-clear-file">
                    <i class="ri-close-line"></i> 取消
                </button>
            </div>
        `;

        fileUpload.querySelector('.hash-clear-file')?.addEventListener('click', (event) => {
            event.stopPropagation();
            clearFile();
        }, { signal: hashState.abortController?.signal });
    }
}

// ============================================
// 清除文件
// ============================================
function clearFile() {
    hashState.selectedFile = null;
    hashState.selectedFilePath = null;

    const fileUpload = document.getElementById('hashFileUpload');
    if (fileUpload) {
        // 恢复可点击状态
        fileUpload.style.cursor = 'pointer';
        fileUpload.style.pointerEvents = 'auto';
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
            // Tauri 环境
            let filePath = hashState.selectedFilePath;

            // 如果没有保存的路径，需要用对话框选择
            if (!filePath) {
                const { open } = window.__TAURI__.dialog;
                filePath = await open({
                    multiple: false,
                    title: '选择要计算哈希的文件',
                    defaultPath: file.name
                });

                if (!filePath) {
                    showToast('未选择文件', 'warning');
                    return;
                }
                // 保存路径供后续使用
                hashState.selectedFilePath = filePath;
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

    // 注意：复制事件已通过事件委托在 bindEvents 中处理，无需在此重复绑定
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

    // 取消所有事件监听器
    if (hashState.abortController) {
        hashState.abortController.abort();
        hashState.abortController = null;
    }

    // 清理进度监听
    if (hashState.unlistenProgress) {
        hashState.unlistenProgress();
        hashState.unlistenProgress = null;
    }

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
    init,
    destroy
});
