# 🚀 新工具添加标准格式指南

**更新日期**: 2025-12-15  
**版本**: 1.0

---

## 📋 快速清单

添加新工具需要修改的文件（**按顺序**）：

```
□ 步骤 1: 实现工具逻辑         → src/tools/tool-name.js
□ 步骤 2: 创建工具样式         → src/css/tools/tool-name.css
□ 步骤 3: 添加 HTML 视图       → src/index.html
□ 步骤 4: 导入工具模块         → src/tools/index.js (1 行)
□ 步骤 5: 配置视图切换         → src/main.js (3-5 行)
□ 步骤 6: 更新文档记录         → README.md
```

---

## 📝 文件模板标准

### 1️⃣ 工具 JavaScript 文件模板

**位置**: `src/tools/tool-name.js`

**结构**:
```javascript
import { registerTool } from './toolRegistry.js';

// 1. 工具状态对象
let toolState = {
    // 你的状态数据
};

// 2. init 函数 (必须)
export function initToolName() {
    const elements = {
        input: document.getElementById('toolInput'),
        output: document.getElementById('toolOutput'),
        // 等等...
    };
    
    if (!elements.input) return;
    
    // 添加事件监听
    elements.input.addEventListener('input', () => {
        // 处理逻辑
    });
}

// 3. destroy 函数 (必须)
export function destroyToolName() {
    // 清理资源
    toolState = {};
}

// 4. 注册工具 (必须)
registerTool({
    id: 'tool-id',                    // 唯一标识
    name: 'Tool Name',               // 显示名称
    icon: 'ri-icon-line',            // Remixicon 图标
    colorClass: 'tool-card__icon--color',  // 颜色
    category: 'dev',                 // 分类 (dev/design/other)
    description: 'Tool description', // 工具描述
    init: initToolName,              // 初始化函数
    destroy: destroyToolName         // 销毁函数
});
```

**代码规范**:
- ✅ 使用 `export` 导出 init/destroy 函数
- ✅ 状态保存在工具内部，不污染全局
- ✅ 在 destroy 中清理所有资源
- ✅ init 中要检查 DOM 元素是否存在

---

### 2️⃣ 工具样式文件模板

**位置**: `src/css/tools/tool-name.css`

**结构**:
```css
/* ============================================
   工具名称样式
   ============================================ */

/* 容器和布局 */
.tool-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 0;
}

.tool-header {
    /* 头部样式 */
}

.tool-content {
    /* 内容区域 */
}

.tool-footer {
    /* 底部（如状态栏） */
}

/* 组件样式 */
.tool-element {
    /* 特定元素样式 */
}

/* 响应式设计 */
@media (max-width: 1024px) {
    /* 平板适配 */
}

@media (max-width: 768px) {
    /* 手机适配 */
}
```

**样式规范**:
- ✅ 使用 CSS 变量（`--color-*`, `--spacing-*` 等）
- ✅ 遵循 BEM 命名规范（`.tool-element__child--state`）
- ✅ 所有尺寸使用 `var()` 变量
- ✅ 包含响应式媒体查询

---

### 3️⃣ HTML 视图模板

**位置**: `src/index.html` 中 `<!-- 其他工具视图将在这里添加 -->` 之前

**结构**:
```html
<!-- 工具名称视图 -->
<div id="toolNameView" class="view">
    <div class="tool-container">
        <!-- 头部 -->
        <div class="tool-header">
            <h2>Tool Name</h2>
            <div class="tool-buttons">
                <button id="toolBtn1">按钮 1</button>
                <button id="toolBtn2">按钮 2</button>
            </div>
        </div>

        <!-- 内容 -->
        <div class="tool-content">
            <input id="toolInput" />
            <textarea id="toolOutput"></textarea>
        </div>

        <!-- 底部（可选） -->
        <div class="tool-footer">
            <!-- 状态信息等 -->
        </div>
    </div>
</div>
```

**HTML 规范**:
- ✅ ID 命名: `tool-name-view`, `toolInput`, `toolButton` 等
- ✅ 元素 ID 与 JS 代码中的选择器一致
- ✅ 结构清晰，注释明确

---

### 4️⃣ 工具导入 (1 行代码)

**位置**: `src/tools/index.js`

```javascript
// 在对应分类下添加
import './tool-name.js';
```

---

### 5️⃣ 视图切换配置

**位置**: `src/main.js`

**修改 1**: DOM 缓存中添加视图
```javascript
const DOM = {
    // ... 其他项
    toolNameView: document.getElementById('toolNameView'),
    // ...
};
```

**修改 2**: `updateContentView()` 函数中添加视图逻辑
```javascript
function updateContentView() {
    // ... 其他隐藏逻辑
    DOM.toolNameView.classList.remove('view--active');
    
    // ... 显示逻辑
    if (activeTab.toolId === 'tool-id') {
        DOM.toolNameView.classList.add('view--active');
        appState.currentToolId = activeTab.toolId;
        setTimeout(() => initTool(activeTab.toolId), 100);
    }
    // ...
}
```

---

### 6️⃣ 文档更新

**位置**: `README.md` 的工具列表

```markdown
### ✅ 已实现
- **Tool Name** - Tool description
```

---

## 🎯 完整示例: Base64 编解码工具

### 文件 1: src/tools/base64-codec.js
- ✅ 100 行代码
- ✅ 包含自动检测、编码、解码功能
- ✅ 实时更新统计信息

### 文件 2: src/css/tools/base64-codec.css
- ✅ 90 行样式
- ✅ 双面板布局
- ✅ 工具栏 + 编辑器 + 统计栏

### 文件 3: src/index.html 中的视图
- ✅ 完整的 UI 结构
- ✅ 所有 ID 与代码匹配

### 文件 4-6: 其他配置
- ✅ tools/index.js: 1 行导入
- ✅ main.js: 2 处修改 (~10 行)
- ✅ README.md: 1 行更新

**总计**: 5 个文件，~250 行代码 ✨

---

## ⚡ 快速检查清单

完成工具后，检查以下内容：

- [ ] init 函数检查 DOM 元素是否存在
- [ ] destroy 函数清理所有资源（事件监听、定时器等）
- [ ] toolRegistry.registerTool() 调用正确
- [ ] HTML 视图 ID 与 JS 代码匹配
- [ ] CSS 使用 CSS 变量，不用硬编码颜色/尺寸
- [ ] main.js 中 DOM 缓存、hideAll、showTool 三处都已修改
- [ ] tools/index.js 中已导入工具
- [ ] README.md 已更新工具列表

---

## 📚 参考资源

| 资源 | 位置 |
|------|------|
| 完整示例 | `src/tools/timestamp-converter.js` |
| 新格式示例 | `src/tools/base64-codec.js` |
| CSS 示例 | `src/css/tools/base64-codec.css` |
| HTML 示例 | `src/index.html` (Base64 部分) |
| Main 配置 | `src/main.js` (updateContentView) |

---

## 🆘 常见错误

### ❌ 错误 1: 工具不显示
**原因**: main.js 中忘记添加视图切换逻辑  
**解决**: 检查 updateContentView 中是否有 toolId 判断

### ❌ 错误 2: 工具显示空白
**原因**: HTML 中的元素 ID 与 JS 代码中的选择器不匹配  
**解决**: 检查 getElementById 中的 ID 是否正确

### ❌ 错误 3: 切换其他工具后回来，工具状态不对
**原因**: destroy 函数没有正确清理状态  
**解决**: 确保 destroy 中恢复初始状态

### ❌ 错误 4: 样式不生效
**原因**: src/index.html 中忘记添加 CSS link  
**解决**: 检查是否有 `<link rel="stylesheet" href="css/tools/tool-name.css">`

---

## ✅ 流程验证

```
新工具添加完成 ↓

1. 工具栏中出现工具卡片 ✓
   └─ 检查: tools/index.js 是否导入

2. 点击工具卡片，视图显示 ✓
   └─ 检查: main.js 中的视图切换配置

3. 工具功能正常运行 ✓
   └─ 检查: init 函数事件监听

4. 切换工具后再回来，功能仍正常 ✓
   └─ 检查: destroy 函数资源清理

✅ 所有检查通过 → 工具完成！
```

---

**记住**: 新的格式是标准化的，这样确保所有工具都能无缝集成到系统中！ 🚀
