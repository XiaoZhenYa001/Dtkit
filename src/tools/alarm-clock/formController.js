import { createAlarmTask } from './taskFactory.js';
import { renderAlarmActionConfig } from './actionConfigView.js';
import { mountSegmentedControl, revealContent, transitionLayout } from '../../core/toolMotion.js';

const FIELD_IDS = ['alarmTaskName', 'alarmTaskType', 'alarmTimeInput', 'countdownHours',
    'countdownMinutes', 'countdownSeconds', 'intervalValue', 'intervalUnit',
    'alarmActionType', 'repeatEnabled'];

// Form state belongs to this mounted view. Scheduling and persistence stay outside it.
export class AlarmFormController {
    constructor(root, handlers) {
        this.root = root;
        this.handlers = handlers;
        this.signal = handlers.signal;
        this.editingId = null;
        this.saving = false;
        this.actionReady = true;
        this.actionGeneration = 0;
        this.revision = 0;
        this.nodes = Object.fromEntries(FIELD_IDS.map(id => [id, root.querySelector('#' + id)]));
        mountSegmentedControl(root.querySelector('.alarm-type-switch'), { signal: this.signal });
        this.bind();
        this.updateSchedule();
        void this.updateAction();
    }

    node(id) { return this.root.querySelector('#' + id); }
    value(id) { return this.nodes[id]?.value || ''; }
    show(id, visible) { this.node(id)?.classList.toggle('is-initially-hidden', !visible); }

    bind() {
        const options = { signal: this.signal };
        this.node('alarmTaskForm').addEventListener('submit', event => {
            event.preventDefault();
            void this.submit();
        }, options);
        this.nodes.alarmTaskType.addEventListener('change', () => this.updateSchedule(), options);
        this.nodes.alarmActionType.addEventListener('change', () => { void this.updateAction(); }, options);
        this.nodes.repeatEnabled.addEventListener('change', () => this.updateRepeat(), options);
        this.node('cancelAlarmEditBtn').addEventListener('click', () => this.reset(), options);
        this.root.querySelectorAll('[data-alarm-type]').forEach(button => {
            button.addEventListener('click', () => {
                this.nodes.alarmTaskType.value = button.dataset.alarmType;
                this.updateSchedule();
            }, options);
        });
        this.root.querySelectorAll('[data-duration]').forEach(button => {
            button.addEventListener('click', () => {
                this.setDuration(Number(button.dataset.duration));
                this.updatePresets();
            }, options);
        });
        this.node('alarmTaskForm').addEventListener('input', () => {
            this.revision++;
            this.setStatus('');
            this.nodes.alarmTaskName.removeAttribute('aria-invalid');
            this.updatePresets();
        }, options);
    }

    setDuration(seconds) {
        this.revision++;
        this.nodes.countdownHours.value = String(Math.floor(seconds / 3600));
        this.nodes.countdownMinutes.value = String(Math.floor(seconds % 3600 / 60));
        this.nodes.countdownSeconds.value = String(seconds % 60);
    }

    updatePresets() {
        const seconds = Number(this.value('countdownHours')) * 3600
            + Number(this.value('countdownMinutes')) * 60 + Number(this.value('countdownSeconds'));
        this.root.querySelectorAll('[data-duration]').forEach(button => {
            button.setAttribute('aria-pressed', String(Number(button.dataset.duration) === seconds));
        });
    }

    updateRepeat() {
        transitionLayout(this.node('alarmTaskForm'), () => {
            this.show('repeatDaysGroup', this.nodes.repeatEnabled.checked);
        }, { signal: this.signal });
    }

    updateSchedule() {
        this.revision++;
        const type = this.value('alarmTaskType');
        const changed = this.previousType && this.previousType !== type;
        const update = () => {
            this.show('countdownInputs', type === 'countdown');
            this.show('alarmQuickPresets', type === 'countdown');
            this.show('alarmTimeInput', type === 'fixed');
            this.show('intervalInputs', type === 'interval');
            this.show('alarmHourlyHint', type === 'hourly');
            this.show('repeatSettingsGroup', type === 'fixed' || type === 'hourly');
            this.node('timeInputLabel').textContent = {
                countdown: '倒计时时长', fixed: '执行时间', hourly: '每逢整点', interval: '提醒间隔'
            }[type] || '设定时间';
            this.root.querySelectorAll('[data-alarm-type]').forEach(button => {
                button.setAttribute('aria-pressed', String(button.dataset.alarmType === type));
            });
            this.show('repeatDaysGroup', this.nodes.repeatEnabled.checked);
            this.updatePresets();
            this.setStatus('');
        };
        if (changed) {
            transitionLayout(this.node('alarmTaskForm'), update, { signal: this.signal });
            const content = { countdown: 'countdownInputs', fixed: 'alarmTimeInput',
                hourly: 'alarmHourlyHint', interval: 'intervalInputs' }[type];
            revealContent(this.node(content), { signal: this.signal });
        } else update();
        this.previousType = type;
    }

    updateButton() {
        const button = this.node('addTaskBtn');
        button.disabled = this.saving || !this.actionReady;
        button.textContent = this.saving ? '正在保存…' : this.editingId ? '保存更改' : '创建提醒';
        button.title = this.actionReady ? '' : '请先添加可用提示音';
    }

    async updateAction({ audioPath = '', programPath = '' } = {}) {
        this.revision++;
        const generation = ++this.actionGeneration;
        const action = this.value('alarmActionType');
        this.handlers.onStopPreview();
        this.setStatus('');
        this.actionReady = false;
        this.updateButton();
        const area = this.node('actionConfigArea');
        const previousHeight = area.getBoundingClientRect().height;
        area.setAttribute('aria-busy', 'true');
        area.inert = true;
        try {
            const files = action === 'sound' ? await this.handlers.loadAudioFiles() : [];
            if (this.signal.aborted || generation !== this.actionGeneration) return;
            transitionLayout(this.node('alarmTaskForm'), () => {
                this.actionReady = renderAlarmActionConfig(area, action, files, {
                    signal: this.signal,
                    onPreview: this.handlers.onPreview,
                    onOpenFolder: this.handlers.onOpenFolder,
                    onReload: () => this.updateAction({
                        audioPath: this.root.querySelector('.alarm-audio-item.selected')?.dataset.audioPath || ''
                    }),
                    onSelectProgram: async () => {
                        const path = await this.handlers.onSelectProgram();
                        if (this.signal.aborted || generation !== this.actionGeneration || !path) return;
                        this.revision++;
                        const node = this.node('selectedFilePath');
                        node.textContent = path;
                        node.title = path;
                    }
                });
            }, { signal: this.signal });
            if (previousHeight || area.children.length) revealContent(area, { signal: this.signal });
            const items = [...area.querySelectorAll('.alarm-audio-item')];
            if (audioPath) {
                const selected = items.find(item => item.dataset.audioPath === audioPath);
                if (selected) items.forEach(item => {
                    const active = item === selected;
                    item.classList.toggle('selected', active);
                    item.setAttribute('aria-checked', String(active));
                    item.tabIndex = active ? 0 : -1;
                });
                else this.setStatus('原提示音已不可用，请重新选择提示音。', 'warning');
            }
            const program = this.node('selectedFilePath');
            if (program && programPath) {
                program.textContent = programPath;
                program.title = programPath;
            }
        } catch (error) {
            if (this.signal.aborted || generation !== this.actionGeneration) return;
            transitionLayout(this.node('alarmTaskForm'), () => area.replaceChildren(), { signal: this.signal });
            this.setStatus(String(error?.message || '加载提醒方式失败，请重试'), 'error');
        }
        if (!this.signal.aborted && generation === this.actionGeneration) {
            area.removeAttribute('aria-busy');
            area.inert = false;
            this.updateButton();
        }
    }

    setStatus(message, state = '') {
        const status = this.node('alarmFormStatus');
        status.textContent = message;
        status.dataset.state = state;
    }

    async submit() {
        if (this.saving || !this.actionReady) return;
        const audio = this.root.querySelector('.alarm-audio-item.selected');
        const { task, error } = createAlarmTask({
            name: this.value('alarmTaskName'), type: this.value('alarmTaskType'),
            action: this.value('alarmActionType'), time: this.value('alarmTimeInput'),
            hours: this.value('countdownHours'), minutes: this.value('countdownMinutes'),
            seconds: this.value('countdownSeconds'), intervalValue: this.value('intervalValue'),
            intervalUnit: this.value('intervalUnit'), repeatEnabled: this.nodes.repeatEnabled.checked,
            repeatDays: [...this.root.querySelectorAll('[name="repeatDay"]:checked')].map(node => Number(node.value)),
            audio: audio ? { path: audio.dataset.audioPath, name: audio.dataset.audioName } : null,
            filePath: this.node('selectedFilePath')?.textContent
        });
        if (error) {
            this.setStatus(error, 'error');
            if (!this.value('alarmTaskName').trim()) {
                this.nodes.alarmTaskName.setAttribute('aria-invalid', 'true');
                this.nodes.alarmTaskName.focus();
            }
            return;
        }
        this.saving = true;
        const revision = this.revision;
        this.updateButton();
        try {
            if (await this.handlers.onSave(task, this.editingId) && !this.signal.aborted
                && revision === this.revision) this.reset();
        } finally {
            this.saving = false;
            if (!this.signal.aborted) this.updateButton();
        }
    }

    setEditing(id) {
        this.revision++;
        this.editingId = id || null;
        this.node('alarmFormTitle').textContent = id ? '编辑提醒' : '新建提醒';
        this.node('alarmFormSubtitle').textContent = id ? '保存后，将按新的时间重新计时。' : '为下一件事，设一个时间。';
        this.show('cancelAlarmEditBtn', Boolean(id));
        this.updateButton();
    }

    async edit(task) {
        this.node('alarmTaskForm').reset();
        this.setEditing(task.id);
        this.nodes.alarmTaskName.value = task.name;
        this.nodes.alarmTaskType.value = task.type;
        this.nodes.alarmActionType.value = task.action;
        const config = task.config;
        this.setDuration(Number(config.totalSeconds) || 300);
        this.nodes.alarmTimeInput.value = config.time || '09:00';
        this.nodes.intervalValue.value = String(config.intervalValue || 30);
        this.nodes.intervalUnit.value = config.intervalUnit || 'minutes';
        this.nodes.repeatEnabled.checked = config.repeatEnabled !== false;
        const days = new Set(config.repeatDays || [1, 2, 3, 4, 5]);
        this.root.querySelectorAll('[name="repeatDay"]').forEach(node => { node.checked = days.has(Number(node.value)); });
        this.updateSchedule();
        this.node('alarmFormTitle').scrollIntoView({ block: 'nearest', behavior: 'instant' });
        this.nodes.alarmTaskName.focus({ preventScroll: true });
        await this.updateAction({ audioPath: config.audioPath, programPath: config.filePath });
    }

    reset() {
        this.node('alarmTaskForm').reset();
        this.nodes.alarmTaskName.removeAttribute('aria-invalid');
        this.setEditing(null);
        this.updateSchedule();
        void this.updateAction();
    }

    serialize() {
        const fields = {};
        for (const [id, node] of Object.entries(this.nodes)) {
            fields[id] = { value: node.value, checked: node.checked,
                selectionStart: node.selectionStart, selectionEnd: node.selectionEnd,
                selectionDirection: node.selectionDirection };
        }
        return { fields, editingId: this.editingId,
            repeatDays: [...this.root.querySelectorAll('[name="repeatDay"]:checked')].map(node => node.value),
            audioPath: this.root.querySelector('.alarm-audio-item.selected')?.dataset.audioPath || '',
            programPath: this.node('selectedFilePath')?.textContent || '',
            focusedField: document.hasFocus() ? document.activeElement?.id : null };
    }

    async restore(snapshot) {
        if (!snapshot?.fields) return;
        for (const [id, node] of Object.entries(this.nodes)) {
            const saved = snapshot.fields[id];
            if (typeof saved?.value !== 'string') continue;
            node.value = node.maxLength > 0 ? saved.value.slice(0, node.maxLength) : saved.value;
            if (typeof saved.checked === 'boolean') node.checked = saved.checked;
            if (Number.isInteger(saved.selectionStart) && Number.isInteger(saved.selectionEnd)) {
                try { node.setSelectionRange(saved.selectionStart, saved.selectionEnd, saved.selectionDirection || 'none'); }
                catch { /* Numeric and time controls do not expose text selections. */ }
            }
        }
        const days = new Set((snapshot.repeatDays || []).map(String));
        this.root.querySelectorAll('[name="repeatDay"]').forEach(node => { node.checked = days.has(node.value); });
        this.setEditing(snapshot.editingId);
        this.updateSchedule();
        await this.updateAction(snapshot);
        if (!this.signal.aborted && !document.documentElement.classList.contains('app-is-suspended')
            && FIELD_IDS.includes(snapshot.focusedField)) {
            this.nodes[snapshot.focusedField]?.focus({ preventScroll: true });
        }
    }
}
