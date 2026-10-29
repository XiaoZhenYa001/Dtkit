const paths = {
    capture: '<path d="M7 3H4a1 1 0 0 0-1 1v3m10-4h3a1 1 0 0 1 1 1v3M3 13v3a1 1 0 0 0 1 1h3m10-4v3a1 1 0 0 1-1 1h-3"/><rect x="6" y="6" width="8" height="8" rx="1.5"/>',
    select: '<path d="m5 3 11 7-5 1-2 5-4-13Z"/>',
    pen: '<path d="m13 4 3 3M4 16l3-1L17 5a1.4 1.4 0 0 0-2-2L5 13l-1 3Z"/>',
    highlight: '<path d="m12 3 5 5-7 7H5v-5l7-7Zm-7 12-2 2h5m2-11 5 5"/>',
    rect: '<rect x="3.5" y="4.5" width="13" height="11" rx="1.5"/>',
    ellipse: '<ellipse cx="10" cy="10" rx="7" ry="5.5"/>',
    line: '<path d="m4 16 12-12"/>',
    arrow: '<path d="m4 16 12-12M8 4h8v8"/>',
    text: '<path d="M4 5V3h12v2M10 3v14m-3 0h6"/>',
    step: '<circle cx="10" cy="10" r="7"/><path d="m8 8 2-2v8m-2 0h4"/>',
    mosaic: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M8 3v14m4-14v14M3 8h14M3 12h14"/>',
    redact: '<rect x="3" y="5" width="14" height="10" rx="1.5" fill="currentColor" stroke="none"/><path d="M6 3h8M6 17h8"/>',
    crop: '<path d="M5 2v12a1 1 0 0 0 1 1h12M2 5h12a1 1 0 0 1 1 1v12"/>',
    import: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="m3 13 4-4 4 4 2-2 4 4"/><circle cx="12.5" cy="6.5" r=".7" fill="currentColor"/>',
    copy: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 4V3H5a2 2 0 0 0-2 2v7h1"/>',
    save: '<path d="M10 3v10m-4-4 4 4 4-4M3 13v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3"/>',
    down: '<path d="m6 8 4 4 4-4"/>',
    undo: '<path d="M7 5 3 9l4 4m-4-4h8a5 5 0 0 1 5 5v1"/>',
    redo: '<path d="m13 5 4 4-4 4m4-4H9a5 5 0 0 0-5 5v1"/>',
    minus: '<path d="M5 10h10"/>',
    plus: '<path d="M5 10h10M10 5v10"/>',
    fit: '<path d="M7 3H3v4m10-4h4v4M3 13v4h4m6 0h4v-4"/><path d="M7 7h6v6H7Z"/>',
    round: '<path d="M4 16V9a5 5 0 0 1 5-5h7M10 16h6V10"/>',
    ocr: '<path d="M6 3H3v3m11-3h3v3M3 14v3h3m8 0h3v-3M6 7h8M6 10h8M6 13h5"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
    long: '<rect x="5" y="2.5" width="10" height="15" rx="1.5"/><path d="M8 8h4m-2-3v6m-2 2 2 2 2-2"/>',
    delete: '<path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8 8v6m4-6v6"/>',
    clear: '<path d="M4 8a6 6 0 1 1 1 7M4 3v5h5"/>',
    front: '<rect x="8" y="3" width="9" height="9" rx="1.5"/><path d="M5 8H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-1"/>',
    back: '<rect x="3" y="8" width="9" height="9" rx="1.5"/><path d="M8 5V4a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1"/>',
    close: '<path d="m5 5 10 10M15 5 5 15"/>',
    check: '<path d="m4 10 4 4 8-8"/>',
    help: '<circle cx="10" cy="10" r="7"/><path d="M8 7a2 2 0 1 1 3 1.7c-.9.5-1 1-1 1.8M10 13.5h.01"/>',
    shield: '<path d="m10 2 6 3v5c0 4-6 7-6 7s-6-3-6-7V5l6-3Z"/><path d="m7 9 2 2 4-4"/>',
};

const icon = name => `<svg class="capture-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.capture}</svg>`;

const modes = [
    ['select', '选择', 'V'], ['pen', '画笔', 'P'], ['highlight', '荧光', 'H'],
    ['rect', '矩形', 'R'], ['ellipse', '椭圆', 'E'], ['line', '直线', 'L'], ['arrow', '箭头', 'A'],
    ['text', '文字', 'T'], ['step', '编号', 'N'],
    ['mosaic', '马赛克', 'M'], ['redact', '遮挡', 'B'], ['crop', '裁剪', 'C'],
];

function modeButton([mode, label, key]) {
    return `<button ${mode === 'rect' ? 'id="captureShapeTrigger" ' : ''}class="capture-mode${mode === 'pen' ? ' is-active' : ''}" type="button" data-capture-mode="${mode}" aria-pressed="${mode === 'pen'}" aria-label="${label} (${key})" title="${label} (${key})">${icon(mode)}<span>${label}</span><kbd>${key}</kbd></button>`;
}

/** Screenshot workspace markup; editing and lifecycle are managed by index.js. */
export function template() {
    return `<section class="capture-shell" aria-label="截图与标注工作台">
      <header class="capture-toolbar">
        <div class="capture-identity"><span class="capture-identity-mark">${icon('capture')}</span><div><h2>截图与标注</h2><small id="captureDimensions">等待一张图像</small></div></div>
        <div class="capture-source-actions">
          <button id="captureImport" class="capture-button" type="button" title="导入图片，也可拖放或粘贴">${icon('import')}<span>导入图片</span></button>
          <input id="captureFile" class="capture-sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" aria-label="选择要标注的图片" tabindex="-1">
          <div class="capture-split-button capture-tool-group">
            <button id="captureAgain" class="capture-button capture-button--capture" type="button" title="在屏幕上选择区域截图">${icon('capture')}<span id="captureAgainLabel">开始截图</span></button>
            <button id="captureOptionsTrigger" class="capture-button capture-split-button__more" type="button" aria-label="更多截图选项" title="延时截图与长截图" aria-haspopup="dialog" aria-expanded="false" aria-controls="captureOptionsMenu">${icon('down')}</button>
            <div id="captureOptionsMenu" class="capture-tool-menu capture-options-menu" role="dialog" aria-label="截图选项" hidden>
              <div class="capture-tool-menu__title"><strong>截图选项</strong><small>给菜单和弹窗留一点时间</small></div>
              <label class="capture-option-row" for="captureDelay"><span>${icon('clock')}延时截图</span><select id="captureDelay"><option value="0">立即</option><option value="3">3 秒后</option><option value="5">5 秒后</option><option value="10">10 秒后</option></select></label>
              <button id="captureLong" class="capture-menu-action" type="button" title="手动滚轮或自动滚动拼接所选区域">${icon('long')}<span><strong>长截图</strong><small>手动滚轮或自动滚动拼接</small></span>${icon('arrow')}</button>
            </div>
          </div>
        </div>
        <div class="capture-actions">
          <button id="captureCopy" class="capture-button capture-button--copy" type="button" title="复制图片 (Ctrl+C)" disabled>${icon('copy')}<span>复制图片</span></button>
          <button id="captureSave" class="capture-button capture-button--primary capture-save" type="button" title="保存 PNG (Ctrl+S)" disabled>${icon('save')}<span>保存 PNG</span></button>
        </div>
      </header>

      <div class="capture-editbar">
        <div class="capture-tools" role="toolbar" aria-label="标注工具">
          <div class="capture-mode-group" role="group" aria-label="选择与笔刷">${modes.slice(0, 3).map(modeButton).join('')}</div>
          <span class="capture-divider" aria-hidden="true"></span>
          <div class="capture-mode-group" role="group" aria-label="形状">${modes.slice(3, 7).map(modeButton).join('')}</div>
          <span class="capture-divider" aria-hidden="true"></span>
          <div class="capture-mode-group" role="group" aria-label="文字与步骤">${modes.slice(7, 9).map(modeButton).join('')}</div>
          <span class="capture-divider" aria-hidden="true"></span>
          <div class="capture-mode-group" role="group" aria-label="隐私与裁剪">${modes.slice(9).map(modeButton).join('')}</div>
        </div>
        <div class="capture-utilities">
          <div class="capture-history" role="group" aria-label="编辑历史">
            <button id="captureUndo" class="capture-icon-button" type="button" title="撤销 (Ctrl+Z)" aria-label="撤销" disabled>${icon('undo')}</button>
            <button id="captureRedo" class="capture-icon-button" type="button" title="重做 (Ctrl+Shift+Z)" aria-label="重做" disabled>${icon('redo')}</button>
          </div>
          <span class="capture-divider" aria-hidden="true"></span>
          <button id="captureOcr" class="capture-icon-button" type="button" title="识别图中文字" aria-label="识别图中文字" disabled>${icon('ocr')}</button>
          <div class="capture-tool-group">
            <button id="captureCanvasTrigger" class="capture-icon-button" type="button" title="圆角与导出设置" aria-label="截图外观与导出设置" aria-haspopup="dialog" aria-expanded="false" aria-controls="captureCanvasMenu" disabled>${icon('round')}</button>
            <div id="captureCanvasMenu" class="capture-tool-menu capture-canvas-menu" role="dialog" aria-label="截图外观与导出设置" hidden>
              <div class="capture-tool-menu__title"><strong>外观与导出</strong><small>让截图恰到好处</small></div>
              <label class="capture-range-label" for="captureCornerRadius"><span>画面圆角</span><output id="captureCornerRadiusValue" for="captureCornerRadius">0 px</output></label>
              <input id="captureCornerRadius" type="range" min="0" max="64" value="0" aria-label="画面圆角">
              <label class="capture-option-row" for="captureExportScale"><span>导出倍率</span><select id="captureExportScale"><option value="1">1× 原始尺寸</option><option value="2">2× 双倍尺寸</option></select></label>
              <button id="captureClear" class="capture-menu-action capture-danger" type="button" title="移除图像和全部标注">${icon('clear')}<span>移除当前图像</span></button>
            </div>
          </div>
          <button id="captureHelp" class="capture-icon-button" type="button" title="快捷键与使用提示" aria-label="快捷键与使用提示">${icon('help')}</button>
        </div>
      </div>

      <div class="capture-properties">
        <div class="capture-brush-properties" role="group" aria-label="标注样式">
          <label class="capture-color-control" title="自定义标注颜色"><input id="captureColor" type="color" value="#007aff" aria-label="自定义标注颜色"><span>颜色</span></label>
          <div class="capture-color-presets" role="group" aria-label="常用颜色">${[['#007aff','蓝色'],['#ff453a','红色'],['#ffcc00','黄色'],['#30b86a','绿色'],['#a855f7','紫色'],['#ffffff','白色'],['#1d1d1f','黑色']].map(([color,name])=>`<button type="button" class="capture-color-swatch${color === '#007aff' ? ' is-active' : ''}" data-capture-color="${color}" aria-label="${name}" aria-pressed="${color === '#007aff'}" title="${name}"></button>`).join('')}</div>
          <span class="capture-divider" aria-hidden="true"></span>
          <label class="capture-size-label" for="captureSize">粗细</label><input id="captureSize" type="range" min="2" max="40" value="5" aria-label="标注粗细"><output id="captureSizeValue" for="captureSize">5 px</output>
          <div class="capture-tool-group">
            <button id="captureShapeOptionsTrigger" class="capture-style-trigger" type="button" title="形状描边与填充" aria-label="形状样式" aria-haspopup="dialog" aria-expanded="false" aria-controls="captureShapeMenu">${icon('rect')}${icon('down')}</button>
            <div id="captureShapeMenu" class="capture-tool-menu capture-shape-menu" role="dialog" aria-label="形状样式" hidden>
              <div class="capture-tool-menu__title"><strong>形状样式</strong><small>用于矩形和椭圆</small></div>
              <div class="capture-style-toggle" role="group" aria-label="形状样式"><button class="is-active" type="button" data-shape-style="outline" aria-pressed="true">${icon('rect')}描边</button><button type="button" data-shape-style="fill" aria-pressed="false">${icon('redact')}填充</button></div>
            </div>
          </div>
        </div>
        <div id="captureSelectionActions" class="capture-selection-actions" role="group" aria-label="选中标注操作" hidden>
          <span class="capture-selection-label">已选中</span><button id="captureDuplicate" class="capture-icon-button" type="button" title="复制选中标注 (Ctrl+D)" aria-label="复制选中标注">${icon('copy')}</button><button id="captureBringFront" class="capture-icon-button" type="button" title="移至顶层" aria-label="移至顶层">${icon('front')}</button><button id="captureSendBack" class="capture-icon-button" type="button" title="移至底层" aria-label="移至底层">${icon('back')}</button><button id="captureDelete" class="capture-icon-button capture-danger" type="button" title="删除选中标注 (Delete)" aria-label="删除选中标注" disabled>${icon('delete')}</button>
        </div>
        <div id="captureCropActions" class="capture-crop-actions" role="group" aria-label="裁剪操作" hidden><output id="captureCropSize">拖动选取裁剪范围</output><button id="captureCropReset" class="capture-text-button" type="button">还原全图</button><button id="captureCropCancel" class="capture-text-button" type="button" title="取消裁剪 (Esc)">取消</button><button id="captureCropApply" class="capture-text-button capture-text-button--primary" type="button" title="应用裁剪 (Enter)">${icon('check')}应用裁剪</button></div>
      </div>

      <div class="capture-workspace">
        <div id="captureStage" class="capture-stage" tabindex="0" aria-label="图像编辑区域，空格拖动画布，Ctrl 加滚轮缩放">
          <div id="captureStageContent" class="capture-stage-content"><div id="captureViewport" class="capture-viewport" hidden><canvas id="captureCanvas" aria-label="截图画布"></canvas><canvas id="captureOverlay" aria-label="标注编辑画布"></canvas><div id="captureBrushCursor" class="capture-brush-cursor" hidden aria-hidden="true"></div><textarea id="captureInlineText" class="capture-inline-text" maxlength="2000" rows="1" wrap="off" hidden aria-label="输入文字标注，Enter 确认，Shift 加 Enter 换行" spellcheck="false"></textarea></div></div>
          <div id="captureLoading" class="capture-loading" data-state="ready"><div class="capture-empty-mark"><i class="ri-screenshot-2-line" aria-hidden="true"></i></div><strong>清晰表达，从一张截图开始</strong><span>截取屏幕，或拖入一张图片。<br>标记重点，整理思路，随时分享。</span><div class="capture-empty-actions"><button class="capture-button capture-button--primary" type="button" data-action="capture">${icon('capture')}开始截图</button><button class="capture-button capture-button--glass" type="button" data-action="import">${icon('import')}导入图片</button></div><small>支持拖放与粘贴 · 图像在本地处理</small></div>
          <div class="capture-drop-hint" aria-hidden="true">${icon('import')}松开以导入图片</div>
        </div>
        <aside id="captureOcrPanel" class="capture-ocr-panel" aria-label="文字识别结果" hidden><header><div><span class="capture-panel-mark">${icon('ocr')}</span><strong>图中文字</strong></div><button id="captureOcrClose" class="capture-icon-button" type="button" aria-label="关闭文字识别结果" title="关闭">${icon('close')}</button></header><p>识别结果可以直接编辑与复制。</p><textarea id="captureOcrText" aria-label="可编辑的文字识别结果" placeholder="识别结果将在这里显示…" spellcheck="false"></textarea><footer><span>${icon('shield')}本地识别</span><button id="captureOcrCopy" class="capture-text-button capture-text-button--primary" type="button">${icon('copy')}复制文字</button></footer></aside>
      </div>

      <footer class="capture-footer"><span id="captureStatus" role="status" aria-live="polite">准备就绪，可截图、导入或粘贴图片。</span><div class="capture-footer-end"><span class="capture-shortcuts"><kbd>空格</kbd> 拖动画布 <span>·</span> <kbd>Ctrl</kbd> + 滚轮缩放</span><div class="capture-zoom" role="group" aria-label="截图缩放"><button id="captureZoomOut" class="capture-icon-button" type="button" title="缩小" aria-label="缩小" disabled>${icon('minus')}</button><output id="captureZoomValue" aria-live="off">100%</output><button id="captureZoomIn" class="capture-icon-button" type="button" title="放大" aria-label="放大" disabled>${icon('plus')}</button><button id="captureZoomFit" class="capture-icon-button" type="button" title="适合窗口" aria-label="适合窗口" disabled>${icon('fit')}</button></div></div></footer>

      <dialog id="captureLongDialog" class="capture-dialog capture-long-dialog" aria-labelledby="captureLongTitle"><form method="dialog"><header><span class="capture-dialog-mark">${icon('long')}</span><div><h3 id="captureLongTitle">把整页，收进一张图。</h3><p>选择固定范围，再按需要滚动拼接。</p></div></header><div class="capture-long-directions" role="group" aria-label="拼接方向"><button class="is-active" data-long-direction="vertical" type="button" aria-pressed="true">${icon('long')}<strong>纵向拼接</strong><span>网页、聊天记录</span></button><button data-long-direction="horizontal" type="button" aria-pressed="false">${icon('long')}<strong>横向拼接</strong><span>表格、横向画布</span></button></div><label class="capture-option-row" for="captureLongMode"><span>滚动方式</span><select id="captureLongMode"><option value="manual">手动滚轮</option><option value="automatic">自动滚动</option></select></label><label class="capture-option-row" for="captureLongSegments"><span>最多采集</span><span><input id="captureLongSegments" type="number" min="2" max="20" value="12"> 段</span></label><p id="captureLongNote" class="capture-dialog-note">将鼠标放在选区内，自行缓慢向下（横向时向右）滚动，每次保留至少半屏重叠并稍停。Enter 完成，Esc 取消；10 分钟或达到段数上限时结束。</p><p class="capture-dialog-note">开始截图会最小化 DtKit 主界面和独立窗口，完成或取消后可从任务栏恢复并查看结果。</p><footer><button id="captureLongCancel" class="capture-button" type="button">取消</button><button id="captureLongStart" class="capture-button capture-button--primary capture-long-primary" type="button">选择范围并开始${icon('arrow')}</button></footer></form></dialog>

      <dialog id="captureHelpDialog" class="capture-dialog capture-help-dialog" aria-labelledby="captureHelpTitle"><form method="dialog"><header><span class="capture-dialog-mark">${icon('help')}</span><div><h3 id="captureHelpTitle">让操作，跟上想法。</h3><p>常用快捷键与一点小提示</p></div><button class="capture-icon-button capture-dialog-close" value="close" aria-label="关闭使用提示" title="关闭">${icon('close')}</button></header><div class="capture-help-tools">${modes.map(([mode,label,key])=>`<span>${icon(mode)}${label}<kbd>${key}</kbd></span>`).join('')}</div><div class="capture-help-shortcuts"><div><span>撤销 / 重做</span><span><kbd>Ctrl Z</kbd><kbd>Ctrl Shift Z</kbd></span></div><div><span>复制图片 / 保存</span><span><kbd>Ctrl C</kbd><kbd>Ctrl S</kbd></span></div><div><span>复制 / 删除选中标注</span><span><kbd>Ctrl D</kbd><kbd>Delete</kbd></span></div><div><span>平移 / 缩放画布</span><span><kbd>空格 + 拖动</kbd><kbd>Ctrl + 滚轮</kbd></span></div><div><span>确认 / 取消编辑</span><span><kbd>Enter</kbd><kbd>Esc</kbd></span></div></div><p class="capture-dialog-note">双击文字可重新编辑。按住 Shift 绘制正方形、圆形或约束线条角度；文字中使用 Shift + Enter 换行。</p><footer><button class="capture-button capture-button--primary" value="close">开始创作</button></footer></form></dialog>
    </section>`;
}
