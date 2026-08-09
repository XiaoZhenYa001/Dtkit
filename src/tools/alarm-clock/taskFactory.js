const TASK_TYPES = new Set(['countdown', 'fixed', 'hourly', 'interval']);
const ACTION_TYPES = new Set(['notify', 'sound', 'run', 'shutdown', 'lock']);

function createId() {
    return globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function validateRepeatConfig(draft, config) {
    config.repeatEnabled = draft.repeatEnabled !== false;
    config.repeatDays = [...new Set((draft.repeatDays || []).map(Number))]
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
    if (config.repeatEnabled && config.repeatDays.length === 0) {
        return '重复提醒至少选择一天';
    }
    return null;
}

function applyScheduleConfig(task, draft) {
    const config = task.config;
    if (task.type === 'countdown') {
        const hours = Number(draft.hours || 0);
        const minutes = Number(draft.minutes || 0);
        const seconds = Number(draft.seconds || 0);
        if (!Number.isInteger(hours) || hours < 0 || hours > 23
            || !Number.isInteger(minutes) || minutes < 0 || minutes > 59
            || !Number.isInteger(seconds) || seconds < 0 || seconds > 59) {
            return '倒计时时间超出有效范围';
        }
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        if (totalSeconds <= 0) return '请设置有效的倒计时时长';
        config.totalSeconds = totalSeconds;
        config.remainingSeconds = totalSeconds;
        return null;
    }

    if (task.type === 'fixed') {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time || '')) return '请设置执行时间';
        config.time = draft.time;
        return validateRepeatConfig(draft, config);
    }

    if (task.type === 'hourly') return validateRepeatConfig(draft, config);

    const intervalValue = Number(draft.intervalValue);
    if (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 999) {
        return '提醒间隔必须是 1 到 999 的整数';
    }
    if (!['minutes', 'hours'].includes(draft.intervalUnit)) return '提醒间隔单位无效';
    config.intervalValue = intervalValue;
    config.intervalUnit = draft.intervalUnit;
    config.intervalMs = intervalValue * (draft.intervalUnit === 'hours' ? 3_600_000 : 60_000);
    return null;
}

function applyActionConfig(task, draft) {
    if (task.action === 'sound') {
        if (!draft.audio?.path) return '请先添加并选择提示音';
        task.config.audioPath = draft.audio.path;
        task.config.audioName = draft.audio.name || '默认提示音';
    }
    if (task.action === 'run') {
        if (!draft.filePath || draft.filePath === '未选择文件') return '请选择要运行的程序';
        task.config.filePath = draft.filePath;
    }
    return null;
}

export function createAlarmTask(draft, { id = createId(), now = new Date() } = {}) {
    const name = String(draft?.name || '').trim();
    if (!name) return { error: '请输入任务名称' };
    if (name.length > 80) return { error: '任务名称最多 80 个字符' };
    if (!TASK_TYPES.has(draft.type)) return { error: '定时类型无效' };
    if (!ACTION_TYPES.has(draft.action)) return { error: '执行动作无效' };

    const task = {
        id,
        name,
        type: draft.type,
        action: draft.action,
        enabled: true,
        paused: false,
        createdAt: new Date(now).toISOString(),
        config: {}
    };
    const error = applyScheduleConfig(task, draft) || applyActionConfig(task, draft);
    return error ? { error } : { task };
}
