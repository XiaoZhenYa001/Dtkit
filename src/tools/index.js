/**
 * 工具模块索引
 * 导入此文件将自动注册所有工具
 * 
 * ========================================
 * 🆕 添加新工具的步骤（新架构）：
 * ========================================
 * 
 * 1. 在 tools/ 目录下创建新文件夹，如 tools/my-tool/
 * 
 * 2. 在文件夹中创建 index.js，包含：
 *    - getTemplate() 函数：返回工具的 HTML 模板
 *    - getStyles() 函数：返回工具的 CSS 样式
 *    - init 函数：工具初始化逻辑
 *    - destroy 函数：工具销毁逻辑
 *    - registerTool() 调用注册工具
 * 
 * 3. 在下方添加 import 语句，如：
 *    import './my-tool/index.js';
 * 
 * 这就完成了！无需修改 index.html 或 main.js
 * 
 * ========================================
 */

// 导出注册中心 API
export * from './toolRegistry.js';

// ============================================
// 工具模块导入（导入即注册）
// ============================================

// === 开发常用工具 ===
import './timestamp-converter/index.js';    // 时间戳转换
import './json-formatter/index.js';         // JSON 格式化
import './base64-codec/index.js';           // Base64 编解码

// === 设计与图像工具 ===
import './color-picker/index.js';           // 颜色提取器
import './image-compressor.js';             // 图片压缩（待迁移）
import './favicon-generator.js';            // Favicon 生成器（待迁移）

// === 其他实用工具 ===
import './hash-calculator.js';              // Hash 计算（待迁移）
import './url-encoder.js';                  // URL 编解码（待迁移）
import './crontab-explainer.js';            // Crontab 解释器（待迁移）
import './unit-converter.js';               // 单位转换器（待迁移）
