/**
 * 工具模块索引。
 *
 * 启动阶段只注册轻量元数据；工具实现会在首次打开时通过显式
 * dynamic import 加载。显式路径也便于 Vite 为每个工具生成独立 chunk。
 */

export * from './toolRegistry.js';

import { registerToolManifest } from './toolRegistry.js';

export const toolManifests = Object.freeze([
    {
        id: 'timestamp-converter',
        name: '时间戳转换',
        icon: 'ri-time-line',
        colorClass: 'tool-card__icon--blue',
        category: 'dev',
        status: 'ready',
        description: '在 Unix 时间戳和日期时间之间相互转换。',
        loader: () => import('./timestamp-converter/index.js')
    },
    {
        id: 'json-formatter',
        name: 'JSON 格式化',
        icon: 'ri-braces-line',
        colorClass: 'tool-card__icon--orange',
        category: 'dev',
        status: 'ready',
        description: '格式化、美化和验证 JSON 数据',
        loader: () => import('./json-formatter/index.js')
    },
    {
        id: 'base64-codec',
        name: 'Base64 编解码',
        icon: 'ri-lock-2-line',
        colorClass: 'tool-card__icon--green',
        category: 'dev',
        status: 'ready',
        description: 'Base64 编码和解码，支持文本和二进制数据',
        loader: () => import('./base64-codec/index.js')
    },
    {
        id: 'hash-tool',
        name: 'MD5 / Hash',
        icon: 'ri-hashtag',
        colorClass: 'tool-card__icon--blue',
        category: 'dev',
        status: 'ready',
        description: '计算文本或文件的哈希值 (MD5, SHA-1, SHA-256, SHA-512)',
        loader: () => import('./hash-tool/index.js')
    },
    {
        id: 'qr-generator',
        name: '二维码生成',
        icon: 'ri-qr-code-line',
        colorClass: 'tool-card__icon--cyan',
        category: 'dev',
        status: 'ready',
        description: '生成自定义样式二维码，支持 Logo、多种格式下载',
        loader: () => import('./qr-generator/index.js')
    },
    {
        id: 'color-picker',
        name: '颜色提取器',
        icon: 'ri-palette-line',
        colorClass: 'tool-card__icon--pink',
        category: 'design',
        status: 'ready',
        description: 'HEX, RGB, HSL 格式互转与调色。',
        loader: () => import('./color-picker/index.js')
    },
    {
        id: 'whiteboard',
        name: '白板',
        icon: 'ri-brush-2-line',
        colorClass: 'tool-card__icon--orange',
        category: 'design',
        status: 'ready',
        description: '鼠标、触控和压感笔书写，支持撤销、橡皮擦、本地保存与 PNG 导出。',
        loader: () => import('./whiteboard/index.js')
    },
    {
        id: 'html-preview',
        name: 'HTML 预览',
        icon: 'ri-code-box-line',
        colorClass: 'tool-card--orange',
        category: 'design',
        status: 'ready',
        description: '实时预览 HTML/CSS/JS 代码效果',
        loader: () => import('./html-preview/index.js')
    },
    {
        id: 'image-compressor',
        name: '图片压缩',
        icon: 'ri-image-line',
        colorClass: 'tool-card__icon--indigo',
        category: 'design',
        status: 'planned',
        description: '无损压缩 PNG/JPG，支持批量。'
    },
    {
        id: 'favicon-generator',
        name: 'Favicon 生成',
        icon: 'ri-file-image-line',
        colorClass: 'tool-card__icon--yellow',
        category: 'design',
        status: 'planned',
        description: '一键生成多尺寸网站图标。'
    },
    {
        id: 'url-encoder',
        name: 'URL 编码',
        icon: 'ri-global-line',
        colorClass: 'tool-card__icon--blue',
        category: 'other',
        status: 'ready',
        description: 'URL Encode / Decode 处理。',
        loader: () => import('./url-encoder/index.js')
    },
    {
        id: 'crontab-explainer',
        name: 'Crontab 解释',
        icon: 'ri-terminal-box-line',
        colorClass: 'tool-card__icon--rose',
        category: 'other',
        status: 'ready',
        description: '翻译复杂的 Cron 表达式。',
        loader: () => import('./crontab-explainer/index.js')
    },
    {
        id: 'unit-converter',
        name: '单位换算',
        icon: 'ri-calculator-line',
        colorClass: 'tool-card__icon--slate',
        category: 'other',
        status: 'ready',
        description: '字节、长度、温度等转换。',
        loader: () => import('./unit-converter/index.js')
    },
    {
        id: 'alarm-clock',
        name: '定时闹钟',
        icon: 'ri-alarm-line',
        colorClass: 'tool-card__icon--rose',
        category: 'utility',
        status: 'ready',
        description: '创建倒计时、固定时间、整点报时、间隔提醒等定时任务',
        loader: () => import('./alarm-clock/index.js')
    },
    {
        id: 'file-batch',
        name: '文件批处理',
        icon: 'ri-file-list-3-line',
        colorClass: 'tool-card__icon--cyan',
        category: 'utility',
        status: 'ready',
        description: '安全预检后批量重命名、复制、移动或删除文件。',
        loader: () => import('./file-batch/index.js')
    },
    {
        id: 'transfer-station',
        name: '临时文件中转站',
        icon: 'ri-box-3-line',
        colorClass: 'tool-card__icon--orange',
        category: 'utility',
        status: 'ready',
        description: '本地临时保存文件，并按需通过局域网安全分享。',
        loader: () => import('./transfer-station/index.js')
    },
    {
        id: 'resource-center',
        name: '资源控制中心',
        icon: 'ri-dashboard-line',
        colorClass: 'tool-card__icon--green',
        category: 'utility',
        status: 'ready',
        description: '按需查看资源快照并配置低能耗策略。',
        loader: () => import('./resource-center/index.js')
    }
]);

toolManifests.forEach(registerToolManifest);
