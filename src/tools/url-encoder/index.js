import { registerTool } from '../toolRegistry.js';
import { URL_ACTIONS, URL_MODES, transformUrl } from './core.js';
import '../../css/tools/utility-suite.css';

let abortController = null;

function getTemplate() {
    return `
        <div class="utility-tool-shell url-tool">
            <header class="utility-tool-hero">
                <div>
                    <span class="utility-tool-kicker">URL TOOLKIT</span>
                    <h2>URL 编解码</h2>
                    <p>处理查询参数、路径片段或完整网址，完整 URL 模式会保留 <code>:/?&amp;=#</code> 等结构字符。</p>
                </div>
                <label class="utility-mode-control" for="urlMode">
                    <span>处理模式</span>
                    <select id="urlMode" class="utility-select">
                        <option value="component">URL 组件 / 参数值</option>
                        <option value="full">完整 URL</option>
                    </select>
                </label>
            </header>

            <div class="utility-split-editor">
                <section class="utility-editor-panel">
                    <div class="utility-panel-heading">
                        <label for="urlInput">输入内容</label>
                        <span id="urlInputCount" class="utility-counter">0 字符</span>
                    </div>
                    <textarea id="urlInput" class="utility-textarea" spellcheck="false" placeholder="例如：https://example.com/search?q=桌面工具箱"></textarea>
                </section>

                <section class="utility-editor-panel">
                    <div class="utility-panel-heading">
                        <label for="urlOutput">转换结果</label>
                        <button id="urlCopyBtn" class="utility-icon-button" type="button" title="复制结果" aria-label="复制转换结果">
                            <i class="ri-file-copy-line"></i>
                        </button>
                    </div>
                    <textarea id="urlOutput" class="utility-textarea" readonly placeholder="结果会显示在这里"></textarea>
                </section>
            </div>

            <div class="utility-action-row">
                <button id="urlEncodeBtn" class="btn btn--primary" type="button">
                    <i class="ri-global-line"></i> 编码
                </button>
                <button id="urlDecodeBtn" class="btn btn--secondary" type="button">
                    <i class="ri-code-line"></i> 解码
                </button>
                <button id="urlSwapBtn" class="btn btn--secondary" type="button">
                    <i class="ri-arrow-left-right-line"></i> 结果移到输入
                </button>
                <button id="urlClearBtn" class="btn btn--secondary" type="button">
                    <i class="ri-delete-bin-line"></i> 清空
                </button>
                <span id="urlStatus" class="utility-inline-status" role="status" aria-live="polite">等待输入</span>
            </div>

            <section class="utility-examples" aria-labelledby="urlExamplesTitle">
                <div>
                    <span class="utility-section-label" id="urlExamplesTitle">快速示例</span>
                    <p>点击示例即可填入，随后选择编码或解码。</p>
                </div>
                <div class="utility-chip-row">
                    <button class="utility-example-chip" type="button" data-url-example="https://example.com/search?q=桌面工具箱&amp;lang=zh-CN">含中文的完整 URL</button>
                    <button class="utility-example-chip" type="button" data-url-example="name=张三&amp;tags=效率 工具">查询参数片段</button>
                    <button class="utility-example-chip" type="button" data-url-example="%E4%B8%AD%E6%96%87%20URL">已编码文本</button>
                </div>
            </section>
        </div>
    `;
}

function setStatus(element, message, type = '') {
    element.textContent = message;
    element.className = `utility-inline-status${type ? ` utility-inline-status--${type}` : ''}`;
}

async function copyResult(output, button, status) {
    if (!output.value) {
        setStatus(status, '没有可复制的结果', 'error');
        return;
    }

    try {
        await navigator.clipboard.writeText(output.value);
        const original = button.innerHTML;
        button.innerHTML = '<i class="ri-check-line"></i>';
        setStatus(status, '结果已复制', 'success');
        setTimeout(() => {
            if (button.isConnected) button.innerHTML = original;
        }, 1200);
    } catch {
        setStatus(status, '复制失败，请手动选择结果', 'error');
    }
}

function initUrlEncoder() {
    abortController?.abort();
    abortController = new AbortController();
    const { signal } = abortController;

    const input = document.getElementById('urlInput');
    const output = document.getElementById('urlOutput');
    const mode = document.getElementById('urlMode');
    const status = document.getElementById('urlStatus');
    const counter = document.getElementById('urlInputCount');
    const copyButton = document.getElementById('urlCopyBtn');
    if (!input || !output || !mode || !status || !counter || !copyButton) return;

    const run = action => {
        if (!input.value) {
            output.value = '';
            setStatus(status, '请先输入需要处理的内容', 'error');
            return;
        }

        try {
            output.value = transformUrl(input.value, action, mode.value);
            const actionName = action === URL_ACTIONS.ENCODE ? '编码' : '解码';
            setStatus(status, `${actionName}完成 · ${output.value.length} 字符`, 'success');
        } catch (error) {
            output.value = '';
            setStatus(status, error.message || '转换失败', 'error');
        }
    };

    input.addEventListener('input', () => {
        counter.textContent = `${input.value.length} 字符`;
        if (!input.value) setStatus(status, '等待输入');
    }, { signal });

    document.getElementById('urlEncodeBtn')?.addEventListener('click', () => run(URL_ACTIONS.ENCODE), { signal });
    document.getElementById('urlDecodeBtn')?.addEventListener('click', () => run(URL_ACTIONS.DECODE), { signal });
    copyButton.addEventListener('click', () => copyResult(output, copyButton, status), { signal });

    document.getElementById('urlSwapBtn')?.addEventListener('click', () => {
        if (!output.value) {
            setStatus(status, '当前没有可移入的结果', 'error');
            return;
        }
        input.value = output.value;
        output.value = '';
        input.dispatchEvent(new Event('input'));
        input.focus();
        setStatus(status, '结果已移到输入框');
    }, { signal });

    document.getElementById('urlClearBtn')?.addEventListener('click', () => {
        input.value = '';
        output.value = '';
        input.dispatchEvent(new Event('input'));
        input.focus();
    }, { signal });

    document.querySelectorAll('[data-url-example]').forEach(button => {
        button.addEventListener('click', () => {
            input.value = button.dataset.urlExample || '';
            input.dispatchEvent(new Event('input'));
            input.focus();
        }, { signal });
    });

    input.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            run(URL_ACTIONS.ENCODE);
        }
    }, { signal });

    input.focus();
}

function destroyUrlEncoder() {
    abortController?.abort();
    abortController = null;
}

registerTool({
    id: 'url-encoder',
    name: 'URL 编码',
    icon: 'ri-global-line',
    colorClass: 'tool-card__icon--blue',
    category: 'other',
    status: 'ready',
    description: '编码或解码 URL、查询参数和路径片段。',
    template: getTemplate,
    init: initUrlEncoder,
    destroy: destroyUrlEncoder
});

export { destroyUrlEncoder, initUrlEncoder };
