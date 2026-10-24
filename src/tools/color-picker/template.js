/**
 * Color workbench markup. Behavior and mutable state live in index.js.
 */
export function getTemplate() {
    return `
        <div class="view-container color-picker-view">
            <div class="color-picker-container">
                <header class="color-picker-hero">
                    <div class="color-picker-heading">
                        <p class="color-eyebrow">COLOR STUDIO</p>
                        <h2>颜色提取器</h2>
                        <p>发现颜色，细调灵感。</p>
                    </div>
                    <div class="color-picker-actions">
                        <button id="colorUploadTrigger" class="color-button" type="button">
                            <i class="ri-image-line" aria-hidden="true"></i><span>导入图片</span>
                        </button>
                        <button id="screenColorPicker" class="color-button color-button--primary" type="button">
                            <i class="ri-pencil-line" aria-hidden="true"></i>
                            <span>屏幕取色</span><small>选择屏幕上的任意颜色</small>
                        </button>
                    </div>
                </header>

                <div class="color-picker-main">
                    <section class="color-source-card color-card" aria-label="调色与图片取色">
                        <header class="color-card-header">
                            <div id="colorSourceTabs" class="color-segmented" role="tablist" aria-label="取色方式">
                                <button id="colorStudioTab" type="button" role="tab" data-color-tab="studio" aria-selected="true" aria-controls="colorStudioPanel" tabindex="0"><i class="ri-palette-line" aria-hidden="true"></i>调色板</button>
                                <button id="colorImageTab" type="button" role="tab" data-color-tab="image" aria-selected="false" aria-controls="colorImagePanel" tabindex="-1"><i class="ri-image-line" aria-hidden="true"></i>图片取色</button>
                            </div>
                            <span class="color-local-hint"><i class="ri-checkbox-circle-line" aria-hidden="true"></i>本地处理</span>
                        </header>
                        <div id="colorSourcePanels" class="color-source-panels">
                            <div id="colorStudioPanel" class="color-studio-panel" role="tabpanel" data-color-panel="studio" aria-labelledby="colorStudioTab">
                                <div class="color-preview-wrapper">
                                    <button id="colorPreview" class="color-preview" type="button" aria-label="打开系统调色板">
                                        <span class="color-preview__label">当前颜色</span>
                                        <strong id="colorPreviewValue">#3B82F6</strong>
                                        <span class="color-preview__footer"><span id="colorPreviewAlpha">100% 不透明</span><span>系统调色板 <i class="ri-arrow-right-up-line" aria-hidden="true"></i></span></span>
                                    </button>
                                    <input type="color" id="colorInput" class="color-input-native color-visually-hidden" value="#3b82f6" aria-label="系统颜色选择" tabindex="-1">
                                </div>
                                <div class="color-adjustments">
                                    <div class="color-adjustment-heading"><span>自由调色</span><small>拖动选取，微调每一处细节</small></div>
                                    <div id="colorSaturation" class="color-saturation" role="slider" tabindex="0" aria-label="饱和度和明度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="76" aria-valuetext="饱和度 76%，明度 96%" aria-describedby="colorSaturationHint">
                                        <span id="colorSaturationThumb" class="color-saturation-thumb"></span>
                                    </div>
                                    <p id="colorSaturationHint" class="color-visually-hidden">左右方向键调整饱和度，上下方向键调整明度；按住 Shift 每次调整 10%。</p>
                                    <div class="color-slider-row">
                                        <label for="colorHue">色相</label>
                                        <input id="colorHue" class="color-slider color-slider--hue" type="range" min="0" max="360" step="0.1" value="217.2">
                                        <output id="colorHueValue" for="colorHue">217°</output>
                                    </div>
                                    <div class="color-slider-row">
                                        <label for="colorAlpha">透明度</label>
                                        <div class="color-alpha-track"><input id="colorAlpha" class="color-slider color-slider--alpha" type="range" min="0" max="100" step="1" value="100"></div>
                                        <output id="colorAlphaValue" for="colorAlpha">100%</output>
                                    </div>
                                </div>
                            </div>
                            <div id="colorImagePanel" class="color-image-panel" role="tabpanel" data-color-panel="image" aria-labelledby="colorImageTab" hidden>
                                <input id="colorFileInput" class="color-visually-hidden" type="file" accept="image/*" tabindex="-1" aria-label="选择取色图片">
                                <div id="colorDropZone" class="color-drop-zone" role="button" tabindex="0" aria-label="导入取色图片，支持拖放和粘贴">
                                    <div id="colorImageEmpty" class="color-image-empty">
                                        <span class="color-image-empty__mark"><i class="ri-image-line" aria-hidden="true"></i></span>
                                        <strong>从一张图片开始</strong>
                                        <p>拖入图片、点击选择，或直接粘贴。</p>
                                        <span class="color-upload-label">选择图片<i class="ri-arrow-right-line" aria-hidden="true"></i></span>
                                        <small>图片留在你的设备上</small>
                                    </div>
                                </div>
                                <div id="colorImageStage" class="color-image-stage" hidden>
                                    <div class="color-image-viewport">
                                        <canvas id="colorImageCanvas" tabindex="0" aria-label="图片取色区域，点击选取颜色，方向键微调位置"></canvas>
                                        <span id="colorImageMarker" class="color-image-marker" hidden></span>
                                        <div id="colorImageLoupe" class="color-image-loupe" hidden>
                                            <div class="color-image-loupe__pixels"><canvas id="colorLoupeCanvas" width="108" height="108" aria-hidden="true"></canvas><span></span></div>
                                            <span id="colorLoupeValue">#FFFFFF</span>
                                        </div>
                                    </div>
                                    <div class="color-image-info">
                                        <div><strong id="colorImageName">图片</strong><small id="colorImageMeta"></small></div>
                                        <div>
                                            <button id="colorImageReplace" class="color-icon-button" type="button" title="更换图片" aria-label="更换图片"><i class="ri-refresh-line" aria-hidden="true"></i></button>
                                            <button id="colorImageClear" class="color-icon-button" type="button" title="移除图片" aria-label="移除图片"><i class="ri-close-line" aria-hidden="true"></i></button>
                                        </div>
                                    </div>
                                    <div class="color-image-palette-heading"><span>图片中的颜色</span><small>点击色块使用</small></div>
                                    <div id="colorImagePalette" class="color-image-palette" aria-label="图片提取的主要颜色"></div>
                                </div>
                                <p id="colorImageStatus" class="color-inline-status" role="status" aria-live="polite"></p>
                            </div>
                        </div>
                    </section>

                    <aside class="color-inspector color-card" aria-label="颜色数值与对比度">
                        <header class="color-inspector-header">
                            <div><span class="color-eyebrow">THE DETAILS</span><h3>每一种表达</h3></div>
                            <button id="colorSave" class="color-button color-save-button" type="button" aria-pressed="false"><i class="ri-add-line" aria-hidden="true"></i><span>收藏</span></button>
                        </header>
                        <div class="color-values-section">
                            <div class="color-value-item">
                                <label for="hexInput">HEX</label>
                                <div class="color-value-input-group">
                                    <input type="text" id="hexInput" class="color-value-input" value="#3B82F6" placeholder="#RRGGBB" spellcheck="false" autocomplete="off" aria-describedby="colorInputError">
                                    <button id="copyHex" class="color-icon-button color-copy-button" type="button" title="复制 HEX" aria-label="复制 HEX"><i class="ri-file-copy-line" aria-hidden="true"></i></button>
                                </div>
                            </div>
                            <div class="color-value-item">
                                <label for="rgbInput">RGB</label>
                                <div class="color-value-input-group">
                                    <input type="text" id="rgbInput" class="color-value-input" value="rgb(59, 130, 246)" placeholder="rgb(59, 130, 246)" spellcheck="false" autocomplete="off" aria-describedby="colorInputError">
                                    <button id="copyRgb" class="color-icon-button color-copy-button" type="button" title="复制 RGB" aria-label="复制 RGB"><i class="ri-file-copy-line" aria-hidden="true"></i></button>
                                </div>
                            </div>
                            <div class="color-value-item">
                                <label for="hslInput">HSL</label>
                                <div class="color-value-input-group">
                                    <input type="text" id="hslInput" class="color-value-input" value="hsl(217, 91%, 60%)" placeholder="hsl(217, 91%, 60%)" spellcheck="false" autocomplete="off" aria-describedby="colorInputError">
                                    <button id="copyHsl" class="color-icon-button color-copy-button" type="button" title="复制 HSL" aria-label="复制 HSL"><i class="ri-file-copy-line" aria-hidden="true"></i></button>
                                </div>
                            </div>
                            <div class="color-value-item">
                                <label for="rgbaInput">RGBA</label>
                                <div class="color-value-input-group">
                                    <input type="text" id="rgbaInput" class="color-value-input" value="rgba(59, 130, 246, 1)" placeholder="rgba(59, 130, 246, 1)" spellcheck="false" autocomplete="off" aria-describedby="colorInputError">
                                    <button id="copyRgba" class="color-icon-button color-copy-button" type="button" title="复制 RGBA" aria-label="复制 RGBA"><i class="ri-file-copy-line" aria-hidden="true"></i></button>
                                </div>
                            </div>
                            <p id="colorInputError" class="color-input-error" role="status" aria-live="polite"></p>
                        </div>
                        <section class="color-contrast" aria-label="文字对比度">
                            <header><span>文字对比度</span><label class="color-contrast-background" for="colorContrastInput"><span>背景</span><input id="colorContrastInput" type="color" value="#ffffff" aria-label="对比度背景颜色"></label></header>
                            <div class="color-contrast-summary"><strong id="colorContrastValue">3.68<span>:1</span></strong><span id="colorContrastText">较适合大号文字</span></div>
                            <div class="color-contrast-samples"><div id="colorContrastBlack" class="color-contrast-sample color-contrast-sample--dark"><span>Aa</span><small>深色文字</small></div><div id="colorContrastWhite" class="color-contrast-sample color-contrast-sample--light"><span>Aa</span><small>浅色文字</small></div></div>
                        </section>
                    </aside>
                </div>

                <section class="color-shades-section color-card" aria-label="明暗色阶">
                    <header class="color-section-heading"><div><h3>同色，更多可能</h3><p>从轻盈到浓郁，找到恰好的层次。</p></div><span>点击色块使用</span></header>
                    <div id="colorShades" class="color-shades-grid"></div>
                </section>

                <section class="color-library color-card" aria-label="颜色收藏与记录">
                    <header class="color-library-header">
                        <div id="colorLibraryTabs" class="color-segmented" role="tablist" aria-label="颜色库">
                            <button id="colorRecentTab" type="button" role="tab" data-color-library="recent" aria-selected="true" aria-controls="colorRecentPanel" tabindex="0">最近使用</button>
                            <button id="colorSavedTab" type="button" role="tab" data-color-library="saved" aria-selected="false" aria-controls="colorSavedPanel" tabindex="-1">我的收藏</button>
                            <button id="colorPresetsTab" type="button" role="tab" data-color-library="presets" aria-selected="false" aria-controls="colorPresetsPanel" tabindex="-1">精选色彩</button>
                        </div>
                        <div class="color-library-actions">
                            <button id="colorClearRecent" class="color-text-button" type="button">清空记录</button>
                            <span class="color-library-divider"></span>
                            <label class="color-visually-hidden" for="colorExportFormat">复制色板格式</label>
                            <select id="colorExportFormat" class="color-export-format" aria-label="复制色板格式"><option value="css">CSS</option><option value="json">JSON</option><option value="text">纯文本</option></select>
                            <button id="colorCopyPalette" class="color-icon-button" type="button" title="复制当前色板" aria-label="复制当前色板"><i class="ri-file-copy-line" aria-hidden="true"></i></button>
                        </div>
                    </header>
                    <div id="colorLibraryPanels" class="color-library-panels">
                        <div id="colorRecentPanel" role="tabpanel" data-color-library-panel="recent" aria-labelledby="colorRecentTab"><div id="recentColors" class="color-swatch-grid color-recent-grid"><p class="color-library-empty">选过的颜色会留在这里。</p></div></div>
                        <div id="colorSavedPanel" role="tabpanel" data-color-library-panel="saved" aria-labelledby="colorSavedTab" hidden><div id="savedColors" class="color-swatch-grid color-saved-grid"><p class="color-library-empty">收藏喜欢的颜色，下次继续灵感。</p></div></div>
                        <div id="colorPresetsPanel" role="tabpanel" data-color-library-panel="presets" aria-labelledby="colorPresetsTab" hidden><div id="colorPresets" class="color-swatch-grid color-presets-grid"></div></div>
                    </div>
                </section>

                <footer class="color-picker-footer"><p id="colorStatus" class="color-inline-status" role="status" aria-live="polite">所有颜色与图片仅在本地处理</p><span>一处颜色，无限灵感。</span></footer>
            </div>
        </div>
    `;
}
