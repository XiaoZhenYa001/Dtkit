import { registerTool } from '../toolRegistry.js';
import { explainCron, getNextOccurrences } from './core.js';
import '../../css/tools/utility-suite.css';

let abortController = null;

function getTemplate() {
    return `
        <div class="utility-tool-shell cron-tool">
            <header class="utility-tool-hero">
                <div>
                    <span class="utility-tool-kicker">CRONTAB</span>
                    <h2>Cron 表达式解释</h2>
                    <p>解析标准 5 段 Crontab，并按本机时区预估后续执行时间。</p>
                </div>
                <div class="cron-format" aria-label="Cron 字段顺序">
                    <span>分</span><span>时</span><span>日</span><span>月</span><span>周</span>
                </div>
            </header>

            <section class="cron-input-card">
                <label for="cronInput">Cron 表达式</label>
                <div class="cron-input-row">
                    <input id="cronInput" class="cron-expression-input" type="text" value="*/15 9-18 * * MON-FRI" spellcheck="false" autocomplete="off">
                    <button id="cronExplainBtn" class="btn btn--primary" type="button">
                        <i class="ri-terminal-box-line"></i> 解释表达式
                    </button>
                </div>
                <p>支持 <code>*</code>、列表、范围、步长、JAN–DEC、SUN–SAT，以及 @hourly / @daily 等常用宏。</p>
            </section>

            <div id="cronError" class="utility-error-banner is-initially-hidden" role="alert"></div>

            <section id="cronResult" class="cron-result" aria-live="polite">
                <div class="cron-summary-card">
                    <span class="utility-section-label">自然语言说明</span>
                    <strong id="cronSummary">—</strong>
                    <code id="cronNormalized">—</code>
                </div>

                <div id="cronFieldGrid" class="cron-field-grid"></div>

                <div class="cron-upcoming-card">
                    <div>
                        <span class="utility-section-label">接下来 5 次</span>
                        <p>根据当前设备的本地时间计算，仅供核对调度规则。</p>
                    </div>
                    <ol id="cronUpcoming" class="cron-upcoming-list"></ol>
                </div>
            </section>

            <section class="utility-examples" aria-labelledby="cronExamplesTitle">
                <div>
                    <span class="utility-section-label" id="cronExamplesTitle">常用示例</span>
                    <p>标准 Crontab 不包含秒字段，也不支持 Quartz 的 L、W、#。</p>
                </div>
                <div class="utility-chip-row">
                    <button class="utility-example-chip" type="button" data-cron-example="*/5 * * * *">每 5 分钟</button>
                    <button class="utility-example-chip" type="button" data-cron-example="0 9 * * MON-FRI">工作日 09:00</button>
                    <button class="utility-example-chip" type="button" data-cron-example="30 2 1 * *">每月 1 日 02:30</button>
                    <button class="utility-example-chip" type="button" data-cron-example="@daily">每天午夜</button>
                </div>
            </section>
        </div>
    `;
}

function formatOccurrence(date) {
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(date);
}

function initCrontabExplainerTool() {
    abortController?.abort();
    abortController = new AbortController();
    const { signal } = abortController;

    const input = document.getElementById('cronInput');
    const summary = document.getElementById('cronSummary');
    const normalized = document.getElementById('cronNormalized');
    const fieldGrid = document.getElementById('cronFieldGrid');
    const upcoming = document.getElementById('cronUpcoming');
    const errorBanner = document.getElementById('cronError');
    if (!input || !summary || !normalized || !fieldGrid || !upcoming || !errorBanner) return;

    const render = () => {
        try {
            const explanation = explainCron(input.value);
            const occurrences = getNextOccurrences(input.value, 5);

            summary.textContent = explanation.summary;
            normalized.textContent = explanation.normalized;
            fieldGrid.replaceChildren(...explanation.details.map(detail => {
                const item = document.createElement('article');
                item.className = 'cron-field-card';
                const label = document.createElement('span');
                label.textContent = detail.label;
                const source = document.createElement('code');
                source.textContent = detail.source;
                const description = document.createElement('strong');
                description.textContent = detail.description;
                item.append(label, source, description);
                return item;
            }));

            upcoming.replaceChildren(...occurrences.map(date => {
                const item = document.createElement('li');
                item.textContent = formatOccurrence(date);
                return item;
            }));

            errorBanner.textContent = '';
            errorBanner.classList.add('is-initially-hidden');
            document.getElementById('cronResult')?.classList.remove('cron-result--invalid');
        } catch (error) {
            errorBanner.textContent = error.message || '无法解析该表达式';
            errorBanner.classList.remove('is-initially-hidden');
            document.getElementById('cronResult')?.classList.add('cron-result--invalid');
        }
    };

    document.getElementById('cronExplainBtn')?.addEventListener('click', render, { signal });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            render();
        }
    }, { signal });

    document.querySelectorAll('[data-cron-example]').forEach(button => {
        button.addEventListener('click', () => {
            input.value = button.dataset.cronExample || '';
            render();
            input.focus();
        }, { signal });
    });

    render();
    input.focus();
    input.select();
}

function destroyCrontabExplainerTool() {
    abortController?.abort();
    abortController = null;
}

registerTool({
    id: 'crontab-explainer',
    name: 'Crontab 解释',
    icon: 'ri-terminal-box-line',
    colorClass: 'tool-card__icon--rose',
    category: 'other',
    status: 'ready',
    description: '解释标准 5 段 Cron，并预估后续执行时间。',
    template: getTemplate,
    init: initCrontabExplainerTool,
    destroy: destroyCrontabExplainerTool
});

export { destroyCrontabExplainerTool, initCrontabExplainerTool };
