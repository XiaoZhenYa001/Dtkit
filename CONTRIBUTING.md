# 贡献指南

感谢你对 DtKit 项目的关注！我们欢迎所有形式的贡献。以下是参与本项目的指南。

## 📋 目录

- [行为准则](#行为准则)
- [如何贡献](#如何贡献)
- [开发设置](#开发设置)
- [分支策略](#分支策略)
- [提交规范](#提交规范)
- [Pull Request 流程](#pull-request-流程)
- [编码规范](#编码规范)

---

## 🤝 行为准则

### 我们的承诺
我们致力于提供一个开放、欢迎、专业的社区。所有参与者应该：

- 尊重不同的观点和经验
- 接受建设性批评
- 关注项目和社区的最佳利益
- 对其他社区成员表示同情

### 不可接受的行为
以下行为是不可接受的：

- 使用性语言或性表达
- 人身攻击、侮辱或贬损评论
- 骚扰或歧视
- 其他不专业的行为

---

## 💡 如何贡献

### 报告 Bug
1. 查看 [Issues](https://github.com/XiaoZhenYa001/Dtkit/issues) 确保问题未被报告
2. 提供清晰的标题和描述
3. 包含重现步骤和预期行为
4. 附加错误日志或截图

### 建议功能
1. 检查 Issues 中是否已提出类似建议
2. 清楚地描述建议的功能和用例
3. 说明这如何改进项目
4. 列出任何相关示例或参考

### 改进文档
1. 确保文档清晰准确
2. 遵循现有的文档格式和风格
3. 在 develop 分支上进行更改

---

## 🛠️ 开发设置

### 前置要求
- Node.js 16+
- Rust 1.70+
- Tauri CLI

### 本地开发环境设置

```bash
# 克隆仓库
git clone https://github.com/XiaoZhenYa001/Dtkit.git
cd Dtkit

# 安装依赖
npm install

# Rust 依赖（Tauri）
cargo build

# 启动开发服务器
npm run dev
```

---

## 🌳 分支策略

我们使用 Git Flow 工作流程：

- **main** - 生产发布分支，仅包含稳定版本
- **develop** - 开发集成分支，用于测试和审查
- **feature/*** - 功能分支，来自 develop
- **bugfix/*** - 修复分支，来自 develop
- **hotfix/*** - 紧急修复，来自 main

### 创建功能分支

```bash
# 更新 develop 分支
git checkout develop
git pull origin develop

# 创建功能分支
git checkout -b feature/your-feature-name

# 进行开发...

# 提交和推送
git add .
git commit -m "feat: Add your feature description"
git push origin feature/your-feature-name
```

---

## 📝 提交规范

我们遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type（必需）
- `feat` - 新功能
- `fix` - Bug 修复
- `docs` - 文档变更
- `style` - 代码格式（不影响功能）
- `refactor` - 代码重构
- `perf` - 性能优化
- `test` - 测试相关
- `chore` - 构建或依赖更新

### Scope（可选）
指明影响的模块，如：`feat(tools)`, `fix(core)`, `docs(readme)`

### Subject（必需）
- 使用命令式现在时（"add" 而不是 "added"）
- 首字母不要大写
- 末尾不加句点
- 控制在 50 字以内

### Body（可选）
- 说明做了什么以及为什么，而不是怎么做
- 每行 72 字左右

### Footer（可选）
- 引用相关 Issue：`Closes #123`
- Breaking changes: `BREAKING CHANGE: description`

### 提交示例

```bash
git commit -m "feat(tools): Add new unit converter tool"
git commit -m "fix(core): Fix memory leak in image compressor"
git commit -m "docs: Update installation guide"
git commit -m "refactor(tools): Simplify JSON formatter logic"
```

---

## 🔄 Pull Request 流程

1. **创建 PR**
   - 从你的功能分支创建到 develop
   - 使用 PR 模板填写信息

2. **填写 PR 信息**
   - 提供清晰的描述
   - 选择合适的变更类型
   - 列出测试步骤

3. **代码审查**
   - 至少需要 1 个批准
   - 回应审查者的评论
   - 进行必要的修改

4. **合并**
   - 所有讨论解决
   - CI/CD 检查通过
   - 使用 "Squash and merge" 保持历史清晰

---

## 📐 编码规范

### JavaScript/HTML/CSS

- 使用 2 空格缩进
- 使用分号结尾
- 使用单引号
- 避免 var，使用 const/let
- 添加必要的注释

```javascript
// ✅ 好的
const fetchData = async () => {
  const response = await fetch('/api/data');
  return response.json();
};

// ❌ 不好的
var fetchData = function(){
    fetch("/api/data").then(r => r.json())
}
```

### Rust

- 遵循 Rust 命名约定
- 使用 `cargo fmt` 格式化代码
- 使用 `cargo clippy` 检查
- 添加文档注释

```rust
// ✅ 好的
/// 计算两个数的和
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

// ❌ 不好的
pub fn add(a: i32,b:i32)->i32{a+b}
```

### 文档

- 使用 Markdown 格式
- 包含代码示例
- 保持清晰的结构
- 更新目录

---

## 🧪 测试

在提交之前，请确保：

- [ ] 新增功能已测试
- [ ] Bug 修复已验证
- [ ] 不存在回归问题
- [ ] 代码覆盖率不降低

```bash
# 运行测试
npm run test

# Rust 测试
cargo test
```

---

## 📚 资源

- [项目 README](https://github.com/XiaoZhenYa001/Dtkit#readme)
- [问题追踪](https://github.com/XiaoZhenYa001/Dtkit/issues)
- [讨论区](https://github.com/XiaoZhenYa001/Dtkit/discussions)

---

## ❓ 有问题？

- 查看 [常见问题](https://github.com/XiaoZhenYa001/Dtkit/wiki/FAQ)
- 在 [讨论区](https://github.com/XiaoZhenYa001/Dtkit/discussions) 提问
- 创建 [Issue](https://github.com/XiaoZhenYa001/Dtkit/issues)

---

感谢你的贡献！🎉
