# 🎯 工具模板快速参考卡

**用途**: 添加新工具时快速复制粘贴的代码框架

---

## 📄 File 1: JavaScript 工具逻辑模板

**文件**: `src/tools/[tool-name].js`

```javascript
import { registerTool } from './toolRegistry.js';

// 工具状态对象
let toolState = {
    // 你的状态数据
};

// init 函数（必须）
export function init[ToolName]() {
    // 获取 DOM 元素
    const elements = {
        input: document.getElementById('[tool-id]Input'),
        output: document.getElementById('[tool-id]Output'),
        btn1: document.getElementById('[tool-id]Btn1'),
        // ... 更多元素
    };
    
    // 安全检查
    if (!elements.input) return;
    
    // 添加事件监听
    elements.input.addEventListener('input', () => {
        // 处理逻辑
        updateOutput();
    });
    
    if (elements.btn1) {
        elements.btn1.addEventListener('click', () => {
            // 按钮逻辑
        });
    }
}

// destroy 函数（必须）
export function destroy[ToolName]() {
    // 重置状态
    toolState = {};
}

// 辅助函数
function updateOutput() {
    // 你的业务逻辑
}

// 注册工具（必须）
registerTool({
    id: 'tool-id',                      // 唯一标识符（kebab-case）
    name: 'Tool Name',                  // 显示名称
    icon: 'ri-icon-name-line',         // Remixicon 图标
    colorClass: 'tool-card__icon--color', // 颜色类名
    category: 'dev',                    // 分类 (dev/design/other)
    description: 'Tool description',    // 工具描述
    init: init[ToolName],               // 初始化函数
    destroy: destroy[ToolName]          // 销毁函数
});
```

**关键点**:
- ✅ init 函数名: `init` + PascalCase
- ✅ destroy 函数名: `destroy` + PascalCase
- ✅ 必须使用 `export` 导出
- ✅ 必须调用 `registerTool()`
- ✅ 在 destroy 中重置状态

---

## 🎨 File 2: 样式模板

**文件**: `src/css/tools/[tool-name].css`

```css
/* ============================================
   工具名称样式
   ============================================ */

/* 主容器 */
.[tool-id]-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 0;
    gap: var(--spacing-2);
}

/* 头部区域 */
.[tool-id]-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-2);
    border-bottom: 1px solid var(--color-border);
}

.[tool-id]-title {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-bold);
    color: var(--color-text);
}

/* 工具栏（按钮组） */
.[tool-id]-toolbar {
    display: flex;
    gap: var(--spacing-1);
    flex-wrap: wrap;
}

/* 内容区域 */
.[tool-id]-content {
    flex: 1;
    overflow: auto;
    padding: var(--spacing-2);
}

/* 输入输出面板 */
.[tool-id]-panel {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-1);
}

.[tool-id]-textarea {
    flex: 1;
    padding: var(--spacing-1);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    font-family: 'Courier New', monospace;
    font-size: var(--font-size-sm);
    resize: vertical;
}

/* 统计/底部信息 */
.[tool-id]-stats {
    padding: var(--spacing-1);
    background: var(--color-bg-alt);
    border-radius: var(--border-radius);
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
}

/* 响应式设计 */
@media (max-width: 1024px) {
    .[tool-id]-container {
        gap: var(--spacing-1);
    }
}

@media (max-width: 768px) {
    .[tool-id]-toolbar {
        flex-direction: column;
    }
    
    .[tool-id]-textarea {
        min-height: 120px;
    }
}
```

**关键点**:
- ✅ 所有尺寸使用 CSS 变量
- ✅ 使用 BEM 命名: `.tool-id__element--state`
- ✅ 包含响应式设计
- ✅ 与框架样式保持一致

---

## 📄 File 3: HTML 视图模板

**文件**: `src/index.html` (在 `<!-- 其他工具视图 -->` 之前)

```html
<!-- 工具名称视图 -->
<div id="[tool-id]View" class="view">
    <div class="[tool-id]-container">
        <!-- 头部 -->
        <div class="[tool-id]-header">
            <h2 class="[tool-id]-title">Tool Name</h2>
            <div class="[tool-id]-toolbar">
                <button id="[tool-id]Btn1" class="btn btn--primary">
                    <i class="ri-icon-line"></i> 按钮 1
                </button>
                <button id="[tool-id]Btn2" class="btn btn--secondary">
                    <i class="ri-icon-line"></i> 按钮 2
                </button>
            </div>
        </div>

        <!-- 内容区域 -->
        <div class="[tool-id]-content">
            <!-- 输入面板 -->
            <div class="[tool-id]-panel">
                <label for="[tool-id]Input">输入</label>
                <textarea 
                    id="[tool-id]Input" 
                    class="[tool-id]-textarea"
                    placeholder="输入内容...">
                </textarea>
            </div>

            <!-- 输出面板 -->
            <div class="[tool-id]-panel">
                <label for="[tool-id]Output">输出</label>
                <textarea 
                    id="[tool-id]Output" 
                    class="[tool-id]-textarea"
                    placeholder="结果将在这里显示..."
                    readonly>
                </textarea>
            </div>
        </div>

        <!-- 统计/底部信息 -->
        <div class="[tool-id]-stats" id="[tool-id]Stats">
            <!-- 统计信息将在这里显示 -->
        </div>
    </div>
</div>
```

**关键点**:
- ✅ 顶级 div 的 id: `[tool-id]View`
- ✅ 容器 class: `[tool-id]-container`
- ✅ 所有按钮和输入的 id 必须与 JS 中的选择器匹配
- ✅ 遵循相同的 HTML 结构模式

---

## 📦 File 4: 工具导入

**文件**: `src/tools/index.js`

**添加这一行**:
```javascript
import './[tool-name].js';
```

**完整示例**:
```javascript
// 开发工具
import './timestamp-converter.js';
import './json-formatter.js';
import './base64-codec.js';
import './[new-tool-name].js';  // 👈 添加这里

// 设计工具
// import './color-picker.js';

// 其他工具
// import './qr-generator.js';
```

**关键点**:
- ✅ 只需要 1 行
- ✅ 工具会自动注册（通过 registerTool()）

---

## ⚙️ File 5: 视图管理配置 (main.js)

### 修改 1: DOM 缓存

**位置**: `src/main.js` 中的 DOM 对象

```javascript
const DOM = {
    // ... 其他项
    [tool-id]View: document.getElementById('[tool-id]View'),
    // ... 其他项
};
```

### 修改 2: updateContentView() 函数

**位置**: `src/main.js` 中的 hideAll 部分

```javascript
function updateContentView() {
    // 隐藏所有视图
    DOM.timestampView.classList.remove('view--active');
    DOM.jsonFormatterView.classList.remove('view--active');
    DOM.base64CodecView.classList.remove('view--active');
    DOM.[tool-id]View.classList.remove('view--active');  // 👈 添加这里
    
    // ... 其他逻辑
}
```

### 修改 3: 视图切换条件

**位置**: `src/main.js` 中的 updateContentView() 函数末尾

```javascript
// ... 前面的 if-else 语句

else if (activeTab.toolId === '[tool-id]') {
    DOM.[tool-id]View.classList.add('view--active');
    appState.currentToolId = activeTab.toolId;
    setTimeout(() => initTool(activeTab.toolId), 100);
}
```

**完整 updateContentView() 示例**:
```javascript
function updateContentView() {
    // Step 1: 隐藏所有视图
    DOM.libView.classList.remove('view--active');
    DOM.timestampView.classList.remove('view--active');
    DOM.jsonFormatterView.classList.remove('view--active');
    DOM.base64CodecView.classList.remove('view--active');
    DOM.[tool-id]View.classList.remove('view--active');

    // Step 2: 根据选中的 tab 显示对应视图
    const activeTab = DOM.tabs[appState.activeTabIndex];
    if (!activeTab) return;

    if (activeTab.toolId === 'library') {
        DOM.libView.classList.add('view--active');
    } else if (activeTab.toolId === 'timestamp-converter') {
        DOM.timestampView.classList.add('view--active');
        appState.currentToolId = activeTab.toolId;
        setTimeout(() => initTool(activeTab.toolId), 100);
    } else if (activeTab.toolId === 'json-formatter') {
        DOM.jsonFormatterView.classList.add('view--active');
        appState.currentToolId = activeTab.toolId;
        setTimeout(() => initTool(activeTab.toolId), 100);
    } else if (activeTab.toolId === 'base64-codec') {
        DOM.base64CodecView.classList.add('view--active');
        appState.currentToolId = activeTab.toolId;
        setTimeout(() => initTool(activeTab.toolId), 100);
    } else if (activeTab.toolId === '[tool-id]') {
        DOM.[tool-id]View.classList.add('view--active');  // 👈 新工具
        appState.currentToolId = activeTab.toolId;
        setTimeout(() => initTool(activeTab.toolId), 100);
    }
}
```

**关键点**:
- ✅ 在 hideAll 部分添加隐藏语句
- ✅ 在 if-else 中添加显示和初始化逻辑
- ✅ 使用 setTimeout 延迟初始化（100ms）

---

## 📋 添加工具的 5 步检查清单

### Step 1: 创建 JS 文件
- [ ] `src/tools/[tool-name].js` 已创建
- [ ] 有 `export function init[ToolName]()` 函数
- [ ] 有 `export function destroy[ToolName]()` 函数
- [ ] 调用了 `registerTool()` 且 id 正确

### Step 2: 创建 CSS 文件
- [ ] `src/css/tools/[tool-name].css` 已创建
- [ ] 使用了 CSS 变量，没有硬编码颜色/尺寸
- [ ] 包含了响应式设计（@media queries）

### Step 3: 添加 HTML 视图
- [ ] `src/index.html` 中添加了 CSS link: `<link rel="stylesheet" href="css/tools/[tool-name].css">`
- [ ] 添加了 HTML 视图: `<div id="[tool-id]View" class="view">...</div>`
- [ ] 所有元素 ID 与 JS 代码中的选择器匹配

### Step 4: 导入工具
- [ ] `src/tools/index.js` 中添加了 `import './[tool-name].js';`
- [ ] 没有其他修改

### Step 5: 配置视图管理
- [ ] `src/main.js` 中 DOM 缓存添加了 `[tool-id]View` 项
- [ ] `updateContentView()` 中的 hideAll 部分添加了隐藏语句
- [ ] `updateContentView()` 的 if-else 中添加了条件和初始化逻辑

### 文档更新
- [ ] `README.md` 的工具列表中添加了新工具
- [ ] `PROJECT_SUMMARY.md` 中更新了工具状态

---

## 🔑 命名规范

**遵循这些规范确保代码一致性**:

| 项目 | 格式 | 示例 |
|------|------|------|
| 工具 ID | kebab-case | `url-encoder` |
| 工具名称 | Title Case | `URL 编码器` |
| 函数名 | camelCase | `initUrlEncoder()` |
| 函数名（destroy） | camelCase | `destroyUrlEncoder()` |
| CSS class | kebab-case | `.url-encoder-container` |
| HTML 元素 ID | camelCase | `urlEncoderInput` |
| CSS 变量 | kebab-case | `--color-primary` |

---

## 🧪 快速测试命令

```bash
# 启动开发服务器
npm run tauri dev

# 构建应用
npm run tauri build

# 清理缓存（如果有奇怪的问题）
rm -rf src-tauri/target
npm run tauri dev
```

---

## 💾 保存此文件位置

**推荐**:
1. 添加书签到浏览器
2. 保存为本地 Markdown 文件
3. 打印出来作为参考卡

**下次添加工具时**:
1. 打开此文件
2. 按照 5 步清单操作
3. 复制粘贴相应的模板代码

---

**预计时间**: 5-10 分钟 ⚡

*准备好了吗？开始添加下一个工具吧！🚀*
