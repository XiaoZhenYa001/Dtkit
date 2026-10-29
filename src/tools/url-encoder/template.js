export function getTemplate() {
    return `
        <div class="view-container dev-workbench url-tool">
            <header class="dw-header">
                <div><p class="dw-eyebrow">TEXT & ENCODING</p><h1 class="dw-title">URL 编解码</h1>
                    <p class="dw-subtitle">从一段参数到一组网址，准确转换每一个字符。</p></div>
                <span class="dw-chip">UTF-8 · 本地处理</span>
            </header>
            <section class="dw-card url-options" aria-label="转换设置">
                <div class="url-options-row">
                    <label class="dw-field url-mode-control" for="urlMode"><span class="dw-label">处理模式</span>
                        <select id="urlMode" class="dw-control">
                            <option value="component">URL 组件 / 参数值</option>
                            <option value="full">完整 URL（encodeURI）</option>
                            <option value="form">表单参数值（空格为 +）</option>
                        </select>
                    </label>
                    <label class="url-toggle"><input id="urlBatchMode" type="checkbox"><span>逐行处理<span>每行独立转换，保留空行</span></span></label>
                    <div class="dw-actions url-run-actions">
                        <button id="urlEncodeBtn" class="dw-button dw-button--primary" type="button">编码</button>
                        <button id="urlDecodeBtn" class="dw-button" type="button">解码</button>
                    </div>
                </div>
                <p id="urlModeHint" class="dw-status"></p>
            </section>
            <div class="dw-grid url-editors">
                <section class="dw-card url-editor-panel" aria-labelledby="urlInputLabel">
                    <header class="dw-card-header"><h2 id="urlInputLabel" class="dw-card-title">输入内容</h2>
                        <div class="dw-actions"><span id="urlInputCount" class="url-counter">0 字符</span>
                            <button id="urlClearBtn" class="dw-button" type="button">清空</button></div></header>
                    <label class="url-sr-only" for="urlInput">输入内容</label>
                    <textarea id="urlInput" class="dw-mono url-textarea" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="urlModeHint urlStatus" placeholder="输入中文、参数值或完整 URL…"></textarea>
                    <footer class="url-editor-footer"><button id="urlInspectBtn" class="dw-button" type="button">查看查询参数</button><span class="dw-status">支持 URL 或 ?key=value 查询串</span></footer>
                </section>
                <section class="dw-card url-editor-panel url-output-panel" aria-labelledby="urlOutputLabel" data-stale="false">
                    <header class="dw-card-header"><h2 id="urlOutputLabel" class="dw-card-title">转换结果</h2>
                        <div class="dw-actions"><button id="urlSwapBtn" class="dw-button" type="button" disabled>移到输入</button>
                            <button id="urlCopyBtn" class="dw-button" type="button" disabled>复制</button></div></header>
                    <label class="url-sr-only" for="urlOutput">转换结果</label>
                    <textarea id="urlOutput" class="dw-mono url-textarea" spellcheck="false" readonly placeholder="转换结果显示在这里…"></textarea>
                    <footer class="url-editor-footer"><p id="urlOutputCount" class="dw-status">等待转换</p><span id="urlResultState" class="dw-chip">未转换</span></footer>
                </section>
            </div>
            <div class="url-feedback"><p id="urlStatus" class="dw-status" role="status" aria-live="polite">输入内容，选择模式后编码或解码。</p>
                <ul id="urlErrors" class="url-errors" hidden></ul></div>
            <details id="urlQueryPanel" class="dw-card url-query-panel" hidden>
                <summary>查询参数 <span id="urlQueryCount" class="dw-chip"></span></summary>
                <div class="url-query-body"><div class="url-query-heading"><p id="urlQueryStatus" class="dw-status" role="status" aria-live="polite"></p>
                    <button id="urlQueryCopyBtn" class="dw-button" type="button" disabled>复制 JSON</button></div>
                    <p id="urlQueryMeta" class="dw-status"></p>
                    <div class="url-query-scroll"><table class="url-query-table"><thead><tr><th scope="col">序号</th><th scope="col">参数名</th><th scope="col">参数值</th><th scope="col">说明</th></tr></thead><tbody id="urlQueryRows"></tbody></table></div>
                </div>
            </details>
            <section class="url-examples" aria-labelledby="urlExamplesTitle"><div><h2 id="urlExamplesTitle" class="dw-card-title">试一试</h2><p class="dw-status">填入示例后，选择编码或解码。</p></div>
                <div class="dw-actions">
                    <button class="dw-button" type="button" data-url-example="https://example.com/搜索?q=桌面 工具&amp;lang=zh-CN" data-url-mode="full">中文网址</button>
                    <button class="dw-button" type="button" data-url-example="a+b &amp; 中文" data-url-mode="form">表单参数值</button>
                    <button class="dw-button" type="button" data-url-example="?tag=工具&amp;tag=效率&amp;q=a+b&amp;empty=&amp;flag#section" data-url-mode="component" data-url-inspect>重复查询参数</button>
                    <button class="dw-button" type="button" data-url-example="%E4%B8%AD%E6%96%87%20URL" data-url-mode="component">已编码文本</button>
                </div>
            </section>
            <footer class="dw-footer"><p class="dw-status">严格校验百分号编码与 UTF-8；再次编码会将原有 % 编码为 %25。</p>
                <span class="dw-status">Ctrl / ⌘ + Enter 编码 · 加 Shift 解码</span></footer>
        </div>`;
}
