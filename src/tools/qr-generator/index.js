/**
 * 二维码生成工具
 * 使用 qr-code-styling 库实现高度可定制的二维码生成
 * 支持自定义样式、Logo、下载等功能
 */
import { registerTool } from '../toolRegistry.js';
import { getDownloadPath } from '../../core/state.js';
import { showToast } from '../../core/utils.js';

// 工具状态
let qrState = {
    qrCode: null,
    currentOptions: {
        data: 'https://github.com',
        width: 300,
        height: 300,
        type: 'canvas',
        dotsType: 'rounded',
        dotsColor: '#000000',
        cornersSquareType: 'extra-rounded',
        cornersSquareColor: '#000000',
        cornersDotType: 'dot',
        cornersDotColor: '#000000',
        backgroundColor: '#ffffff',
        logoSize: 0.3,
        logoMargin: 5,
        logoImage: null
    }
};

/**
 * 获取工具的 HTML 模板
 */
function getTemplate() {
    return `
        <div class="view-container">
            <div class="qr-generator-container">
                <!-- 标题 -->
                <div class="qr-generator-header">
                    <h2 class="qr-generator-title">二维码生成器</h2>
                    <p class="qr-generator-desc">生成高度自定义的二维码，支持自定义样式和 Logo</p>
                </div>

                <div class="qr-generator-content">
                    <!-- 左侧：设置面板 -->
                    <div class="qr-settings-panel">
                        <!-- 内容输入 -->
                        <div class="qr-section">
                            <h4 class="qr-section-title">
                                <i class="ri-text"></i> 二维码内容
                            </h4>
                            <textarea id="qrDataInput" class="input qr-data-input" 
                                placeholder="输入网址、文本或其他内容..." 
                                rows="3">https://github.com</textarea>
                        </div>

                        <!-- 样式设置 -->
                        <div class="qr-section">
                            <h4 class="qr-section-title">
                                <i class="ri-palette-line"></i> 码点样式
                            </h4>
                            <div class="qr-option-group">
                                <label class="qr-label">码点形状</label>
                                <select id="dotsTypeSelect" class="input qr-select">
                                    <option value="rounded">圆角</option>
                                    <option value="dots">圆点</option>
                                    <option value="classy">经典</option>
                                    <option value="classy-rounded">经典圆角</option>
                                    <option value="square">方形</option>
                                    <option value="extra-rounded">超圆角</option>
                                </select>
                            </div>
                            <div class="qr-option-group">
                                <label class="qr-label">码点颜色</label>
                                <div class="qr-color-picker">
                                    <input type="color" id="dotsColorInput" class="qr-color-input" value="#000000">
                                    <input type="text" id="dotsColorText" class="input qr-color-text" value="#000000">
                                </div>
                            </div>
                        </div>

                        <!-- 定位角设置 -->
                        <div class="qr-section">
                            <h4 class="qr-section-title">
                                <i class="ri-focus-3-line"></i> 定位角样式
                            </h4>
                            <div class="qr-option-group">
                                <label class="qr-label">外框形状</label>
                                <select id="cornersSquareTypeSelect" class="input qr-select">
                                    <option value="extra-rounded">超圆角</option>
                                    <option value="dot">圆点</option>
                                    <option value="square">方形</option>
                                </select>
                            </div>
                            <div class="qr-option-group">
                                <label class="qr-label">外框颜色</label>
                                <div class="qr-color-picker">
                                    <input type="color" id="cornersSquareColorInput" class="qr-color-input" value="#000000">
                                    <input type="text" id="cornersSquareColorText" class="input qr-color-text" value="#000000">
                                </div>
                            </div>
                            <div class="qr-option-group">
                                <label class="qr-label">内点形状</label>
                                <select id="cornersDotTypeSelect" class="input qr-select">
                                    <option value="dot">圆点</option>
                                    <option value="square">方形</option>
                                </select>
                            </div>
                            <div class="qr-option-group">
                                <label class="qr-label">内点颜色</label>
                                <div class="qr-color-picker">
                                    <input type="color" id="cornersDotColorInput" class="qr-color-input" value="#000000">
                                    <input type="text" id="cornersDotColorText" class="input qr-color-text" value="#000000">
                                </div>
                            </div>
                        </div>

                        <!-- 背景设置 -->
                        <div class="qr-section">
                            <h4 class="qr-section-title">
                                <i class="ri-paint-fill"></i> 背景
                            </h4>
                            <div class="qr-option-group">
                                <label class="qr-label">背景颜色</label>
                                <div class="qr-color-picker">
                                    <input type="color" id="bgColorInput" class="qr-color-input" value="#ffffff">
                                    <input type="text" id="bgColorText" class="input qr-color-text" value="#ffffff">
                                </div>
                            </div>
                        </div>

                        <!-- Logo 设置 -->
                        <div class="qr-section">
                            <h4 class="qr-section-title">
                                <i class="ri-image-add-line"></i> Logo（可选）
                            </h4>
                            <div class="qr-option-group">
                                <div class="qr-logo-upload">
                                    <input type="file" id="logoFileInput" accept="image/*" class="qr-file-input">
                                    <button id="uploadLogoBtn" class="btn btn--secondary qr-upload-btn">
                                        <i class="ri-upload-2-line"></i> 上传 Logo
                                    </button>
                                    <button id="clearLogoBtn" class="btn btn--ghost qr-clear-logo-btn" style="display: none;">
                                        <i class="ri-close-line"></i>
                                    </button>
                                </div>
                                <div id="logoPreview" class="qr-logo-preview" style="display: none;"></div>
                            </div>
                            <div class="qr-option-group">
                                <label class="qr-label">Logo 大小</label>
                                <div class="qr-range-group">
                                    <input type="range" id="logoSizeSlider" class="qr-range" min="0.1" max="0.5" step="0.05" value="0.3">
                                    <span id="logoSizeValue" class="qr-range-value">30%</span>
                                </div>
                            </div>
                        </div>

                        <!-- 尺寸设置 -->
                        <div class="qr-section">
                            <h4 class="qr-section-title">
                                <i class="ri-ruler-line"></i> 尺寸
                            </h4>
                            <div class="qr-option-group">
                                <label class="qr-label">二维码大小</label>
                                <div class="qr-size-inputs">
                                    <input type="number" id="qrWidthInput" class="input qr-size-input" value="300" min="100" max="1000">
                                    <span class="qr-size-separator">×</span>
                                    <input type="number" id="qrHeightInput" class="input qr-size-input" value="300" min="100" max="1000">
                                    <span class="qr-size-unit">px</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 右侧：预览和下载 -->
                    <div class="qr-preview-panel">
                        <div class="qr-preview-box">
                            <div id="qrCodePreview" class="qr-preview-canvas"></div>
                        </div>
                        
                        <div class="qr-actions">
                            <button id="generateQrBtn" class="btn btn--primary qr-action-btn">
                                <i class="ri-refresh-line"></i> 生成二维码
                            </button>
                            <div class="qr-download-group">
                                <button id="downloadPngBtn" class="btn btn--secondary qr-action-btn">
                                    <i class="ri-download-line"></i> PNG
                                </button>
                                <button id="downloadSvgBtn" class="btn btn--secondary qr-action-btn">
                                    <i class="ri-download-line"></i> SVG
                                </button>
                                <button id="downloadJpegBtn" class="btn btn--secondary qr-action-btn">
                                    <i class="ri-download-line"></i> JPEG
                                </button>
                            </div>
                        </div>

                        <div class="qr-download-path">
                            <i class="ri-folder-line"></i>
                            <span id="downloadPathDisplay">下载路径: 加载中...</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 获取工具的 CSS 样式
 */
function getStyles() {
    return `
        .qr-generator-container {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-lg);
            padding: var(--spacing-lg);
            max-width: 1200px;
            margin: 0 auto;
        }

        .qr-generator-header {
            text-align: center;
        }

        .qr-generator-title {
            font-size: var(--font-size-xl);
            font-weight: 600;
            color: var(--color-text-primary);
            margin: 0 0 var(--spacing-xs) 0;
        }

        .qr-generator-desc {
            font-size: var(--font-size-sm);
            color: var(--color-text-secondary);
            margin: 0;
        }

        .qr-generator-content {
            display: grid;
            grid-template-columns: 1fr 380px;
            gap: var(--spacing-xl);
        }

        /* 设置面板 */
        .qr-settings-panel {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
            max-height: calc(100vh - 200px);
            overflow-y: auto;
            padding-right: var(--spacing-sm);
        }

        .qr-settings-panel::-webkit-scrollbar {
            width: 6px;
        }

        .qr-settings-panel::-webkit-scrollbar-track {
            background: transparent;
        }

        .qr-settings-panel::-webkit-scrollbar-thumb {
            background: var(--color-border);
            border-radius: 3px;
        }

        .qr-section {
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            padding: var(--spacing-md);
        }

        .qr-section-title {
            font-size: var(--font-size-sm);
            font-weight: 600;
            color: var(--color-text-primary);
            margin: 0 0 var(--spacing-md) 0;
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
        }

        .qr-section-title i {
            color: var(--color-primary);
        }

        .qr-option-group {
            margin-bottom: var(--spacing-sm);
        }

        .qr-option-group:last-child {
            margin-bottom: 0;
        }

        .qr-label {
            display: block;
            font-size: var(--font-size-xs);
            color: var(--color-text-secondary);
            margin-bottom: var(--spacing-xs);
        }

        .qr-data-input {
            width: 100%;
            resize: vertical;
            font-family: var(--font-mono);
        }

        .qr-select {
            width: 100%;
        }

        /* 颜色选择器 */
        .qr-color-picker {
            display: flex;
            gap: var(--spacing-sm);
            align-items: center;
        }

        .qr-color-input {
            width: 48px;
            height: 36px;
            padding: 2px;
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            cursor: pointer;
            background: var(--color-bg-primary);
        }

        .qr-color-input::-webkit-color-swatch-wrapper {
            padding: 2px;
        }

        .qr-color-input::-webkit-color-swatch {
            border-radius: var(--radius-sm);
            border: none;
        }

        .qr-color-text {
            flex: 1;
            font-family: var(--font-mono);
            text-transform: uppercase;
        }

        /* Logo 上传 */
        .qr-logo-upload {
            display: flex;
            gap: var(--spacing-sm);
            align-items: center;
        }

        .qr-file-input {
            display: none;
        }

        .qr-upload-btn {
            flex: 1;
        }

        .qr-clear-logo-btn {
            padding: var(--spacing-sm);
        }

        .qr-logo-preview {
            margin-top: var(--spacing-sm);
            padding: var(--spacing-sm);
            background: var(--color-bg-tertiary);
            border-radius: var(--radius-md);
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .qr-logo-preview img {
            max-width: 80px;
            max-height: 80px;
            border-radius: var(--radius-sm);
        }

        /* 范围滑块 */
        .qr-range-group {
            display: flex;
            align-items: center;
            gap: var(--spacing-md);
        }

        .qr-range {
            flex: 1;
            height: 6px;
            -webkit-appearance: none;
            background: var(--color-border);
            border-radius: 3px;
            outline: none;
        }

        .qr-range::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 18px;
            height: 18px;
            background: var(--color-primary);
            border-radius: 50%;
            cursor: pointer;
            transition: transform 0.2s ease;
        }

        .qr-range::-webkit-slider-thumb:hover {
            transform: scale(1.2);
        }

        .qr-range-value {
            font-size: var(--font-size-sm);
            color: var(--color-text-secondary);
            min-width: 40px;
            text-align: right;
        }

        /* 尺寸输入 */
        .qr-size-inputs {
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
        }

        .qr-size-input {
            width: 80px;
            text-align: center;
        }

        .qr-size-separator {
            color: var(--color-text-secondary);
        }

        .qr-size-unit {
            font-size: var(--font-size-sm);
            color: var(--color-text-secondary);
        }

        /* 预览面板 */
        .qr-preview-panel {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
            position: sticky;
            top: var(--spacing-lg);
        }

        .qr-preview-box {
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 350px;
        }

        .qr-preview-canvas {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .qr-preview-canvas canvas,
        .qr-preview-canvas svg {
            max-width: 100%;
            height: auto;
            border-radius: var(--radius-md);
            box-shadow: var(--shadow-lg);
        }

        /* 操作按钮 */
        .qr-actions {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-sm);
        }

        .qr-action-btn {
            width: 100%;
        }

        .qr-download-group {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: var(--spacing-sm);
        }

        /* 下载路径显示 */
        .qr-download-path {
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            padding: var(--spacing-sm) var(--spacing-md);
            background: var(--color-bg-tertiary);
            border-radius: var(--radius-md);
            font-size: var(--font-size-xs);
            color: var(--color-text-secondary);
        }

        .qr-download-path i {
            color: var(--color-primary);
        }

        /* 响应式 */
        @media (max-width: 900px) {
            .qr-generator-content {
                grid-template-columns: 1fr;
            }

            .qr-settings-panel {
                max-height: none;
                overflow-y: visible;
            }

            .qr-preview-panel {
                position: static;
            }
        }
    `;
}

/**
 * 动态加载 QRCodeStyling 库
 */
async function loadQRCodeStyling() {
    if (window.QRCodeStyling) {
        return window.QRCodeStyling;
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = './tools/qr-generator/qr-code-styling.js';
        script.onload = () => {
            if (window.QRCodeStyling) {
                resolve(window.QRCodeStyling);
            } else {
                reject(new Error('QRCodeStyling 未能正确加载'));
            }
        };
        script.onerror = () => reject(new Error('加载 qr-code-styling.js 失败'));
        document.head.appendChild(script);
    });
}

/**
 * 创建或更新二维码
 */
async function generateQRCode() {
    const container = document.getElementById('qrCodePreview');
    if (!container) return;

    try {
        const QRCodeStyling = await loadQRCodeStyling();
        
        const options = {
            width: qrState.currentOptions.width,
            height: qrState.currentOptions.height,
            type: 'canvas',
            data: qrState.currentOptions.data,
            dotsOptions: {
                type: qrState.currentOptions.dotsType,
                color: qrState.currentOptions.dotsColor
            },
            cornersSquareOptions: {
                type: qrState.currentOptions.cornersSquareType,
                color: qrState.currentOptions.cornersSquareColor
            },
            cornersDotOptions: {
                type: qrState.currentOptions.cornersDotType,
                color: qrState.currentOptions.cornersDotColor
            },
            backgroundOptions: {
                color: qrState.currentOptions.backgroundColor
            },
            imageOptions: {
                crossOrigin: 'anonymous',
                margin: qrState.currentOptions.logoMargin,
                imageSize: qrState.currentOptions.logoSize
            }
        };

        // 如果有 Logo，添加到选项中
        if (qrState.currentOptions.logoImage) {
            options.image = qrState.currentOptions.logoImage;
        }

        // 清空容器
        container.innerHTML = '';

        // 创建新的二维码
        qrState.qrCode = new QRCodeStyling(options);
        qrState.qrCode.append(container);

        showToast('二维码已生成', 'success');
    } catch (error) {
        console.error('[QRGenerator] 生成二维码失败:', error);
        container.innerHTML = `<div style="color: var(--color-text-secondary); text-align: center;">
            <i class="ri-error-warning-line" style="font-size: 48px; display: block; margin-bottom: 8px;"></i>
            生成失败: ${error.message}
        </div>`;
        showToast('生成二维码失败: ' + error.message, 'error');
    }
}

/**
 * 下载二维码
 */
async function downloadQRCode(format) {
    if (!qrState.qrCode) {
        showToast('请先生成二维码', 'error');
        return;
    }

    try {
        const downloadPath = getDownloadPath();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `qrcode-${timestamp}`;

        // 检查是否在 Tauri 环境
        if (window.__TAURI__) {
            // 使用 Tauri 的文件写入功能
            const { writeBinaryFile, BaseDirectory } = window.__TAURI__.fs;
            const { join } = window.__TAURI__.path;
            
            let extension = format;
            let mimeType = `image/${format}`;
            
            if (format === 'svg') {
                // SVG 格式处理
                const svgData = await qrState.qrCode.getRawData('svg');
                if (svgData) {
                    const filePath = await join(downloadPath, `${filename}.svg`);
                    const blob = svgData;
                    const arrayBuffer = await blob.arrayBuffer();
                    await writeBinaryFile(filePath, new Uint8Array(arrayBuffer));
                    showToast(`已保存到: ${filePath}`, 'success');
                }
            } else {
                // PNG/JPEG 格式处理
                const blob = await qrState.qrCode.getRawData(format);
                if (blob) {
                    const filePath = await join(downloadPath, `${filename}.${extension}`);
                    const arrayBuffer = await blob.arrayBuffer();
                    await writeBinaryFile(filePath, new Uint8Array(arrayBuffer));
                    showToast(`已保存到: ${filePath}`, 'success');
                }
            }
        } else {
            // 浏览器环境下载
            qrState.qrCode.download({
                name: filename,
                extension: format
            });
            showToast(`下载文件: ${filename}.${format}`, 'success');
        }
    } catch (error) {
        console.error('[QRGenerator] 下载失败:', error);
        showToast('下载失败: ' + error.message, 'error');
    }
}

/**
 * 同步颜色输入
 */
function syncColorInput(colorInputId, textInputId) {
    const colorInput = document.getElementById(colorInputId);
    const textInput = document.getElementById(textInputId);
    
    if (!colorInput || !textInput) return;

    colorInput.addEventListener('input', () => {
        textInput.value = colorInput.value.toUpperCase();
    });

    textInput.addEventListener('input', () => {
        const value = textInput.value;
        if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
            colorInput.value = value;
        }
    });
}

/**
 * 初始化二维码生成器工具
 */
async function initQRGeneratorTool() {
    console.log('[QRGenerator] 初始化中...');

    // 获取 DOM 元素
    const dataInput = document.getElementById('qrDataInput');
    const dotsTypeSelect = document.getElementById('dotsTypeSelect');
    const dotsColorInput = document.getElementById('dotsColorInput');
    const dotsColorText = document.getElementById('dotsColorText');
    const cornersSquareTypeSelect = document.getElementById('cornersSquareTypeSelect');
    const cornersSquareColorInput = document.getElementById('cornersSquareColorInput');
    const cornersSquareColorText = document.getElementById('cornersSquareColorText');
    const cornersDotTypeSelect = document.getElementById('cornersDotTypeSelect');
    const cornersDotColorInput = document.getElementById('cornersDotColorInput');
    const cornersDotColorText = document.getElementById('cornersDotColorText');
    const bgColorInput = document.getElementById('bgColorInput');
    const bgColorText = document.getElementById('bgColorText');
    const logoFileInput = document.getElementById('logoFileInput');
    const uploadLogoBtn = document.getElementById('uploadLogoBtn');
    const clearLogoBtn = document.getElementById('clearLogoBtn');
    const logoPreview = document.getElementById('logoPreview');
    const logoSizeSlider = document.getElementById('logoSizeSlider');
    const logoSizeValue = document.getElementById('logoSizeValue');
    const qrWidthInput = document.getElementById('qrWidthInput');
    const qrHeightInput = document.getElementById('qrHeightInput');
    const generateQrBtn = document.getElementById('generateQrBtn');
    const downloadPngBtn = document.getElementById('downloadPngBtn');
    const downloadSvgBtn = document.getElementById('downloadSvgBtn');
    const downloadJpegBtn = document.getElementById('downloadJpegBtn');
    const downloadPathDisplay = document.getElementById('downloadPathDisplay');

    if (!generateQrBtn) {
        console.warn('[QRGenerator] 必要的 DOM 元素未找到');
        return;
    }

    // 显示下载路径
    if (downloadPathDisplay) {
        downloadPathDisplay.textContent = `下载路径: ${getDownloadPath()}`;
    }

    // 同步颜色输入框
    syncColorInput('dotsColorInput', 'dotsColorText');
    syncColorInput('cornersSquareColorInput', 'cornersSquareColorText');
    syncColorInput('cornersDotColorInput', 'cornersDotColorText');
    syncColorInput('bgColorInput', 'bgColorText');

    // 数据输入变化
    dataInput?.addEventListener('input', () => {
        qrState.currentOptions.data = dataInput.value || 'https://github.com';
    });

    // 码点样式变化
    dotsTypeSelect?.addEventListener('change', () => {
        qrState.currentOptions.dotsType = dotsTypeSelect.value;
    });

    dotsColorInput?.addEventListener('input', () => {
        qrState.currentOptions.dotsColor = dotsColorInput.value;
    });

    dotsColorText?.addEventListener('change', () => {
        if (/^#[0-9A-Fa-f]{6}$/.test(dotsColorText.value)) {
            qrState.currentOptions.dotsColor = dotsColorText.value;
        }
    });

    // 定位角外框样式变化
    cornersSquareTypeSelect?.addEventListener('change', () => {
        qrState.currentOptions.cornersSquareType = cornersSquareTypeSelect.value;
    });

    cornersSquareColorInput?.addEventListener('input', () => {
        qrState.currentOptions.cornersSquareColor = cornersSquareColorInput.value;
    });

    cornersSquareColorText?.addEventListener('change', () => {
        if (/^#[0-9A-Fa-f]{6}$/.test(cornersSquareColorText.value)) {
            qrState.currentOptions.cornersSquareColor = cornersSquareColorText.value;
        }
    });

    // 定位角内点样式变化
    cornersDotTypeSelect?.addEventListener('change', () => {
        qrState.currentOptions.cornersDotType = cornersDotTypeSelect.value;
    });

    cornersDotColorInput?.addEventListener('input', () => {
        qrState.currentOptions.cornersDotColor = cornersDotColorInput.value;
    });

    cornersDotColorText?.addEventListener('change', () => {
        if (/^#[0-9A-Fa-f]{6}$/.test(cornersDotColorText.value)) {
            qrState.currentOptions.cornersDotColor = cornersDotColorText.value;
        }
    });

    // 背景颜色变化
    bgColorInput?.addEventListener('input', () => {
        qrState.currentOptions.backgroundColor = bgColorInput.value;
    });

    bgColorText?.addEventListener('change', () => {
        if (/^#[0-9A-Fa-f]{6}$/.test(bgColorText.value)) {
            qrState.currentOptions.backgroundColor = bgColorText.value;
        }
    });

    // Logo 上传
    uploadLogoBtn?.addEventListener('click', () => {
        logoFileInput?.click();
    });

    logoFileInput?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                qrState.currentOptions.logoImage = event.target.result;
                
                // 显示预览
                if (logoPreview) {
                    logoPreview.innerHTML = `<img src="${event.target.result}" alt="Logo">`;
                    logoPreview.style.display = 'flex';
                }
                
                // 显示清除按钮
                if (clearLogoBtn) {
                    clearLogoBtn.style.display = 'block';
                }
                
                showToast('Logo 已上传', 'success');
            };
            reader.readAsDataURL(file);
        }
    });

    // 清除 Logo
    clearLogoBtn?.addEventListener('click', () => {
        qrState.currentOptions.logoImage = null;
        if (logoPreview) {
            logoPreview.innerHTML = '';
            logoPreview.style.display = 'none';
        }
        if (logoFileInput) {
            logoFileInput.value = '';
        }
        clearLogoBtn.style.display = 'none';
        showToast('Logo 已清除', 'info');
    });

    // Logo 大小滑块
    logoSizeSlider?.addEventListener('input', () => {
        const value = parseFloat(logoSizeSlider.value);
        qrState.currentOptions.logoSize = value;
        if (logoSizeValue) {
            logoSizeValue.textContent = `${Math.round(value * 100)}%`;
        }
    });

    // 尺寸输入
    qrWidthInput?.addEventListener('change', () => {
        const value = parseInt(qrWidthInput.value) || 300;
        qrState.currentOptions.width = Math.min(Math.max(value, 100), 1000);
        qrWidthInput.value = qrState.currentOptions.width;
    });

    qrHeightInput?.addEventListener('change', () => {
        const value = parseInt(qrHeightInput.value) || 300;
        qrState.currentOptions.height = Math.min(Math.max(value, 100), 1000);
        qrHeightInput.value = qrState.currentOptions.height;
    });

    // 生成按钮
    generateQrBtn.addEventListener('click', generateQRCode);

    // 下载按钮
    downloadPngBtn?.addEventListener('click', () => downloadQRCode('png'));
    downloadSvgBtn?.addEventListener('click', () => downloadQRCode('svg'));
    downloadJpegBtn?.addEventListener('click', () => downloadQRCode('jpeg'));

    // 初始生成一个二维码
    await generateQRCode();

    console.log('[QRGenerator] 初始化完成 ✓');
}

/**
 * 销毁二维码生成器工具
 */
function destroyQRGeneratorTool() {
    console.log('[QRGenerator] 销毁中...');
    
    // 清理二维码实例
    if (qrState.qrCode) {
        qrState.qrCode = null;
    }
    
    // 重置状态
    qrState.currentOptions.logoImage = null;
    
    console.log('[QRGenerator] 已销毁');
}

// 注册工具
registerTool({
    id: 'qr-generator',
    name: '二维码生成',
    icon: 'ri-qr-code-line',
    colorClass: 'tool-card__icon--cyan',
    category: 'dev',
    description: '生成自定义样式二维码，支持 Logo、多种格式下载',
    template: getTemplate,
    styles: getStyles,
    init: initQRGeneratorTool,
    destroy: destroyQRGeneratorTool
});

export { initQRGeneratorTool, destroyQRGeneratorTool };
