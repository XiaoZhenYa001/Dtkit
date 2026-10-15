export function quickTemplate() {
    return `<div class="password-quick">
        <div class="password-quick__security"><i class="ri-shield-check-line"></i><span>本机密码库</span><small>↑ ↓ 选择 · Enter 复制</small></div>
        <label class="password-search password-search--quick"><i class="ri-search-line"></i><input id="passwordSearch" type="search" autocomplete="off" spellcheck="false" placeholder="搜索名称、备注，或 #分类 开发" aria-label="搜索密码"></label>
        <div id="passwordList" class="password-results password-results--quick" role="listbox" aria-label="密码搜索结果" tabindex="0"></div>
        <div class="password-pagination" id="passwordPagination" hidden><button id="passwordPagePrev" type="button" aria-label="上一页"><i class="ri-arrow-left-s-line"></i></button><span id="passwordPageLabel"></span><button id="passwordPageNext" type="button" aria-label="下一页"><i class="ri-arrow-right-s-line"></i></button></div>
        <p id="passwordStatus" class="password-status" role="status" aria-live="polite"></p>
    </div>`;
}

const button = (id, icon, label, kind = 'secondary') => `<button id="${id}" class="password-button password-button--${kind}" type="button"><i class="${icon}" aria-hidden="true"></i><span>${label}</span></button>`;
const close = (target, label = '关闭') => `<button type="button" class="password-dialog__close" data-close-dialog="${target}" aria-label="${label}"><i class="ri-close-line"></i></button>`;
const field = (id, label, maximum, type = 'text', extra = '') => `<label><span>${label}</span><input id="${id}" type="${type}" maxlength="${maximum}" autocomplete="off" ${extra}></label>`;

export function mainTemplate() {
    return `<div class="password-shell">
        <header class="password-hero">
            <div class="password-hero__identity"><span class="password-hero__icon"><i class="ri-lock-2-line"></i></span><div><span class="password-kicker">YOUR PASSWORDS</span><h2>密码库</h2><p>常用账号随手找到，密码仅在复制或编辑时读取。</p></div></div>
            <div class="password-hero__actions">${button('passwordAudit','ri-shield-check-line','安全检查')}${button('passwordImport','ri-upload-2-line','导入')}${button('passwordExport','ri-download-2-line','导出')}${button('passwordAdd','ri-add-line','新建密码','primary')}</div>
        </header>
        <section class="password-commandbar">
            <label class="password-search"><i class="ri-search-line"></i><input id="passwordSearch" type="search" autocomplete="off" spellcheck="false" placeholder="搜索名称、账号、网址或备注…" aria-label="搜索密码"><button id="passwordSearchHelpToggle" type="button" aria-label="字段搜索帮助" aria-expanded="false"><i class="ri-question-line"></i></button></label>
            <label class="password-clipboard-setting"><i class="ri-time-line"></i><span>复制后</span><select id="passwordClipboardTime" aria-label="剪贴板自动清理时间"><option value="15">15 秒清除</option><option value="30">30 秒清除</option><option value="60">1 分钟清除</option><option value="0">永不清除</option></select></label>
            <button id="passwordRefresh" type="button" class="password-icon-button" title="刷新密码库" aria-label="刷新密码库"><i class="ri-refresh-line"></i></button>
        </section>
        <div id="passwordSearchHelp" class="password-search-help" hidden><span>限定字段搜索：</span>${['名称','用户名','邮箱','手机号','备注','分类','网址'].map(label=>`<button type="button" data-search-field="${label}">#${label}</button>`).join('')}<small>例如 #分类 开发</small></div>
        <div class="password-workspace">
            <nav id="passwordNav" class="password-nav" aria-label="密码库分类"></nav>
            <section class="password-list-card" aria-label="密码列表">
                <div class="password-list-heading"><div><strong id="passwordListTitle">全部密码</strong><span id="passwordSummary">正在读取…</span></div><select id="passwordSort" aria-label="密码排序"><option value="recent">最近使用优先</option><option value="name">按名称排列</option><option value="updated">最近更新优先</option></select><button id="passwordEmptyTrash" class="password-link-danger" type="button" hidden>清空回收站</button></div>
                <div id="passwordList" class="password-results" role="listbox" aria-label="密码条目" tabindex="0"></div>
                <div class="password-pagination" id="passwordPagination" hidden><button id="passwordPagePrev" type="button" aria-label="上一页"><i class="ri-arrow-left-s-line"></i></button><span id="passwordPageLabel"></span><button id="passwordPageNext" type="button" aria-label="下一页"><i class="ri-arrow-right-s-line"></i></button></div>
                <footer class="password-list-footer"><span>单击选择 · 再次点击或 Enter 复制</span><span id="passwordTrashHint" hidden>回收站保留 30 天</span></footer>
            </section>
            <button id="passwordDetailBackdrop" class="password-detail-backdrop" type="button" aria-label="收起详情" hidden></button>
            <aside id="passwordDetail" class="password-detail" aria-label="密码详情" aria-live="polite"></aside>
        </div>
        <p id="passwordStatus" class="password-status" role="status" aria-live="polite"></p>

        <dialog id="passwordEditor" class="password-dialog password-dialog--editor"><form id="passwordEditorForm">
            <div class="password-dialog__header"><div><span class="password-kicker">PASSWORD ENTRY</span><h3 id="passwordEditorTitle">新建密码</h3></div>${close('passwordEditor')}</div>
            <p id="passwordEditorStatus" class="password-inline-status" role="status" hidden></p><input id="passwordEntryId" type="hidden">
            <section class="password-editor-section is-primary"><div class="password-editor-section__title"><i class="ri-key-line"></i><div><strong>基础信息</strong><span>名称、分类与密码</span></div><label class="password-favorite-check"><input id="passwordFavorite" type="checkbox"><i class="ri-star-line"></i>收藏</label></div>
                <div class="password-form-grid">${field('passwordService','名称 *',200,'text','required')}${field('passwordCategory','分类',200,'text','list="passwordCategorySuggestions"')}
                    <label class="password-form-password"><span>密码 *</span><div><input id="passwordValue" maxlength="10000" type="password" required autocomplete="new-password"><button id="passwordReveal" type="button" title="按住显示密码" aria-label="按住显示密码"><i class="ri-eye-line"></i></button><button id="passwordGenerateToggle" type="button" aria-expanded="false">生成器</button></div><small id="passwordStrength">尚未输入密码</small></label>
                </div>
                <div id="passwordGenerator" class="password-generator" hidden><div class="password-generator__tabs"><button type="button" data-generator-mode="characters" class="is-active">随机字符</button><button type="button" data-generator-mode="phrase">易读短语</button></div><div class="password-generator__row"><label data-character-option>长度<input id="passwordLength" type="range" min="12" max="64" value="20"><output id="passwordLengthValue">20</output></label><label data-character-option><input id="passwordUppercase" type="checkbox" checked>大写</label><label data-character-option><input id="passwordNumbers" type="checkbox" checked>数字</label><label data-character-option><input id="passwordSymbols" type="checkbox" checked>符号</label><label data-character-option><input id="passwordAvoidAmbiguous" type="checkbox" checked>排除易混淆字符</label><p id="passwordPhraseHint" hidden>随机生成 12 个单词，用短横线连接。</p>${button('passwordGenerate','ri-refresh-line','生成并填入','primary')}</div></div>
            </section>
            <details class="password-editor-section" open><summary><i class="ri-user-line"></i><span><strong>身份与链接</strong><small>填写需要的账号信息</small></span><i class="ri-arrow-down-s-line"></i></summary><div class="password-form-grid">${field('passwordUsername','用户名',500)}${field('passwordEmail','邮箱',500,'text','inputmode="email"')}${field('passwordPhone','手机号',100,'tel')}${field('passwordUrl','网站 URL',2000,'url','placeholder="https://"')}</div></details>
            <details class="password-editor-section"><summary><i class="ri-file-list-3-line"></i><span><strong>备注与自定义字段</strong><small>恢复代码、额外账号等信息</small></span><i class="ri-arrow-down-s-line"></i></summary><label class="password-form-note"><span>备注</span><textarea id="passwordNote" maxlength="10000" rows="3"></textarea></label><div class="password-custom-heading"><strong>自定义字段 <small id="passwordFieldCount">0 / 20</small></strong><button id="passwordAddField" type="button"><i class="ri-add-line"></i>添加字段</button></div><div id="passwordCustomFields" class="password-custom-fields"></div></details>
            <datalist id="passwordCategorySuggestions"></datalist><div class="password-dialog__footer"><span>仅保存在本机加密密码库中</span>${button('passwordEditorCancel','ri-close-line','取消')}${button('passwordEditorSave','ri-check-line','保存','primary')}</div>
        </form></dialog>

        <dialog id="passwordImportDialog" class="password-dialog password-dialog--import"><div class="password-dialog__body">
            <div class="password-dialog__header"><div><span class="password-kicker">IMPORT REVIEW</span><h3>检查并导入</h3><p id="passwordImportFile"></p></div>${close('passwordImportDialog')}</div>
            <p id="passwordImportStatus" class="password-inline-status" role="status" hidden></p>
            <div id="passwordImportSummary" class="password-import-summary"></div><div id="passwordImportWarnings" class="password-import-warnings"></div><div id="passwordImportIssues" class="password-import-issues" hidden></div>
            <label class="password-import-strategy"><span><strong>重复条目</strong><small>名称与用户名相同的条目视为重复</small></span><select id="passwordDuplicateStrategy"><option value="skip">跳过重复项</option><option value="keep">保留两者</option><option value="overwrite">用导入条目覆盖</option></select></label>
            <details id="passwordImportConflicts" class="password-import-valid" hidden><summary><span><i class="ri-file-copy-line"></i>逐项处理重复条目</span><em id="passwordConflictCount"></em></summary><div id="passwordConflictItems" class="password-import-items"></div></details>
            <details class="password-import-valid"><summary><span><i class="ri-checkbox-circle-line"></i>可导入条目</span><em id="passwordImportReadyCount">0 条</em></summary><div id="passwordImportItems" class="password-import-items"></div></details>
            <p class="password-import-note"><i class="ri-shield-check-line"></i><span>预览仅显示辨认条目所需的信息。错误条目可就地修正，其余条目可以先导入。</span></p>
            <div class="password-dialog__footer"><span id="passwordImportOutcome"></span><button class="password-button password-button--secondary" type="button" data-close-dialog="passwordImportDialog">取消</button>${button('passwordImportCommit','ri-check-line','确认导入','primary')}</div>
        </div></dialog>

        <dialog id="passwordExportDialog" class="password-dialog password-dialog--export"><div class="password-dialog__body"><div class="password-dialog__header"><div><span class="password-kicker">EXPORT PASSWORDS</span><h3>导出密码</h3></div>${close('passwordExportDialog')}</div>
            <p id="passwordExportStatus" class="password-inline-status" role="status" hidden></p>
            <div class="password-export-formats"><label><input name="passwordExportFormat" type="radio" value="json" checked><span><i class="ri-code-box-line"></i><strong>JSON</strong><small>完整保留网址、自定义字段等信息</small></span></label><label><input name="passwordExportFormat" type="radio" value="csv"><span><i class="ri-file-list-3-line"></i><strong>CSV</strong><small>兼容七列格式，方便表格软件读取</small></span></label></div>
            <label class="password-export-scope"><span>导出范围</span><select id="passwordExportScope"><option value="all">全部有效密码</option><option value="current">当前搜索与分类结果</option></select></label>
            <p class="password-export-warning"><i class="ri-error-warning-line"></i><span>导出文件包含明文密码，任何能访问文件的人都可以读取。请保存在可信的位置，使用后及时删除；回收站条目不会导出。</span></p>
            <label class="password-export-confirm"><input id="passwordExportConfirmed" type="checkbox"><span>我了解导出文件包含明文密码</span></label>
            <div class="password-dialog__footer"><button class="password-button password-button--secondary" type="button" data-close-dialog="passwordExportDialog">取消</button>${button('passwordExportCommit','ri-download-2-line','选择位置并导出','primary')}</div>
        </div></dialog>

        <dialog id="passwordDeleteDialog" class="password-dialog password-dialog--danger"><div class="password-dialog__body"><div class="password-dialog__header"><span class="password-danger-icon"><i class="ri-delete-bin-6-line"></i></span>${close('passwordDeleteDialog')}</div><h3 id="passwordDeleteTitle">删除密码？</h3><p id="passwordDeleteDescription"></p><label class="password-permanent-check"><input id="passwordPermanentDelete" type="checkbox"><span><strong>彻底删除</strong><small>删除后无法恢复</small></span></label><p id="passwordDeleteStatus" class="password-inline-status" role="status" hidden></p><div class="password-dialog__footer"><button class="password-button password-button--secondary" type="button" data-close-dialog="passwordDeleteDialog">取消</button>${button('passwordDeleteConfirm','ri-delete-bin-line','移入回收站','danger')}</div></div></dialog>
        <dialog id="passwordAuditDialog" class="password-dialog password-dialog--audit"><div class="password-dialog__body"><div class="password-dialog__header"><div><span class="password-kicker">SECURITY REVIEW</span><h3>密码安全检查</h3></div>${close('passwordAuditDialog')}</div><div id="passwordAuditContent" class="password-audit-content"></div><p class="password-import-note"><i class="ri-shield-check-line"></i>仅在本机检查，不联网。结果用于提示常见问题，不能保证账号安全。</p><div class="password-dialog__footer"><button class="password-button password-button--primary" type="button" data-close-dialog="passwordAuditDialog">完成</button></div></div></dialog>
    </div>`;
}
