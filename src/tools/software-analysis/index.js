import { registerTool } from '../toolRegistry.js';
import { createSoftwareAnalysisView } from './view.js';
import '../../css/tools/software-analysis.css';

registerTool({
    id: 'software-analysis', name: '软件分析', icon: 'ri-apps-2-line',
    colorClass: 'tool-card__icon--orange', category: 'utility', status: 'ready',
    description: '查看软件安装位置与登记大小，按需扫描目录占用，定位大文件和关联自启动。',
    ...createSoftwareAnalysisView()
});
