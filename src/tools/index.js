/**
 * 工具模块索引
 * 导入此文件将自动注册所有工具
 * 
 * 添加新工具步骤：
 * 1. 在 tools/ 目录下创建新工具文件 (如 my-tool.js)
 * 2. 在工具文件中调用 registerTool() 注册
 * 3. 在下方添加 import 语句
 * 4. 如需要，在 index.html 中添加工具视图 HTML
 */

// 导出注册中心 API
export * from './toolRegistry.js';

// ============================================
// 工具模块导入（导入即注册）
// ============================================

// 开发常用
import './timestamp-converter.js';
import './json-formatter.js';
import './base64-codec.js';

// 设计与图像
import './color-picker.js';
import './image-compressor.js';
import './favicon-generator.js';

// 其他实用
import './hash-calculator.js';
import './url-encoder.js';
import './crontab-explainer.js';
import './unit-converter.js';
