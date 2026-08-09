import {
    clearAlarmNotifications,
    removeAlarmNotification,
    showSoundAlarmNotification
} from './notifications.js';

const DEFAULT_MAX_QUEUE_SIZE = 5;
const AUDIO_LOAD_TIMEOUT_MS = 5_000;
const MAX_PLAYBACK_MS = 7 * 60 * 1_000;
const PREVIEW_DURATION_MS = 3_000;

export function enqueueUniqueAudioTask(queue, currentTaskId, task, maxSize = DEFAULT_MAX_QUEUE_SIZE) {
    if (currentTaskId === task.id || queue.some(item => item.id === task.id)) {
        return { queue: [...queue], added: false };
    }
    const nextQueue = [...queue, task];
    if (nextQueue.length > maxSize) nextQueue.shift();
    return { queue: nextQueue, added: true };
}

export class AlarmAudioManager {
    constructor({ maxQueueSize = DEFAULT_MAX_QUEUE_SIZE } = {}) {
        this.maxQueueSize = maxQueueSize;
        this.availableFiles = [];
        this.queue = [];
        this.processing = false;
        this.currentController = null;
        this.controllers = new Map();
        this.blobUrls = new Set();
        this.previewAudio = null;
        this.previewBlobUrl = null;
        this.previewTimeout = null;
        this.previewGeneration = 0;
    }

    get isPlaying() {
        return Boolean(this.currentController && !this.currentController.stop);
    }

    get hasActiveAudio() {
        return this.isPlaying || this.queue.length > 0;
    }

    async loadAvailableFiles() {
        if (!window.__TAURI__) {
            this.availableFiles = [{ name: '默认提示音', path: '', size: 0 }];
            return this.availableFiles;
        }
        this.availableFiles = await window.__TAURI__.core.invoke('scan_audio_files');
        return this.availableFiles;
    }

    async openAudioFolder() {
        if (!window.__TAURI__) throw new Error('此功能需要在 Tauri 环境中使用');
        await window.__TAURI__.core.invoke('open_audio_folder');
    }

    async preview(filePath) {
        this.stopPreview();
        if (!filePath) return;

        const generation = ++this.previewGeneration;
        const audio = new Audio();
        const convertedPath = await this.convertPath(filePath);
        if (generation !== this.previewGeneration) {
            this.revokeBlobUrl(convertedPath);
            return;
        }

        this.previewAudio = audio;
        this.previewBlobUrl = convertedPath.startsWith('blob:') ? convertedPath : null;
        audio.src = convertedPath;
        audio.volume = 0.5;
        try {
            await audio.play();
        } catch (error) {
            if (generation === this.previewGeneration) this.stopPreview();
            throw error;
        }
        this.previewTimeout = setTimeout(() => {
            if (generation === this.previewGeneration) this.stopPreview();
        }, PREVIEW_DURATION_MS);
    }

    stopPreview() {
        this.previewGeneration++;
        if (this.previewTimeout) clearTimeout(this.previewTimeout);
        this.previewTimeout = null;
        if (this.previewAudio) {
            this.previewAudio.pause();
            this.previewAudio.src = '';
            this.previewAudio = null;
        }
        if (this.previewBlobUrl) this.revokeBlobUrl(this.previewBlobUrl);
        this.previewBlobUrl = null;
    }

    async play(task) {
        const result = enqueueUniqueAudioTask(
            this.queue,
            this.currentController?.taskId,
            task,
            this.maxQueueSize
        );
        this.queue = result.queue;
        if (!result.added) return false;
        await this.processQueue();
        return true;
    }

    async processQueue() {
        if (this.processing || this.currentController) return;
        this.processing = true;
        try {
            while (this.queue.length > 0 && !this.currentController) {
                const task = this.queue.shift();
                if (await this.startTaskAudio(task)) break;
            }
        } finally {
            this.processing = false;
        }
    }

    async startTaskAudio(task) {
        const audioPath = task.config?.audioPath;
        if (!audioPath) return false;

        const controller = {
            taskId: task.id,
            taskName: task.name,
            audio: null,
            blobUrl: null,
            timeoutId: null,
            onError: null,
            stop: false,
            cleaned: false
        };
        this.currentController = controller;
        this.controllers.set(task.id, controller);

        try {
            const audio = new Audio();
            controller.audio = audio;
            const convertedPath = await this.convertPath(audioPath);
            if (controller.stop) {
                this.revokeBlobUrl(convertedPath);
                return false;
            }
            controller.blobUrl = convertedPath.startsWith('blob:') ? convertedPath : null;
            audio.src = convertedPath;
            audio.volume = 0.7;
            audio.loop = true;

            controller.onError = error => {
                console.error(`[AlarmClock] 音频加载失败: ${task.config.audioName || '默认提示音'}`, error);
                this.cleanupController(controller);
            };
            audio.addEventListener('error', controller.onError);
            controller.timeoutId = setTimeout(
                () => this.cleanupController(controller),
                MAX_PLAYBACK_MS
            );

            void showSoundAlarmNotification(
                task,
                () => this.cleanupController(controller),
                () => !controller.stop
            ).catch(error => console.error('[AlarmClock] 显示闹钟通知失败', error));

            await this.waitUntilPlayable(audio);
            if (!controller.stop) await audio.play();
            return !controller.stop;
        } catch (error) {
            if (error?.name !== 'AbortError') console.error('[AlarmClock] 播放音频失败', error);
            this.cleanupController(controller);
            return false;
        }
    }

    waitUntilPlayable(audio) {
        if (audio.readyState >= 2) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let timeoutId;
            const cleanup = () => {
                clearTimeout(timeoutId);
                audio.removeEventListener('canplay', onCanPlay);
                audio.removeEventListener('error', onError);
            };
            const onCanPlay = () => {
                cleanup();
                resolve();
            };
            const onError = error => {
                cleanup();
                reject(error);
            };
            audio.addEventListener('canplay', onCanPlay);
            audio.addEventListener('error', onError);
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('音频加载超时'));
            }, AUDIO_LOAD_TIMEOUT_MS);
        });
    }

    stop(taskId) {
        this.queue = this.queue.filter(task => task.id !== taskId);
        const controller = this.controllers.get(taskId);
        if (controller) this.cleanupController(controller);
        else removeAlarmNotification(taskId, { animate: false });
    }

    stopAll() {
        this.queue = [];
        [...this.controllers.values()].forEach(controller => {
            this.cleanupController(controller, { processNext: false });
        });
        this.controllers.clear();
        this.currentController = null;
        clearAlarmNotifications();
    }

    cleanupController(controller, { processNext = true } = {}) {
        if (!controller || controller.cleaned) return;
        controller.cleaned = true;
        controller.stop = true;
        if (controller.timeoutId) clearTimeout(controller.timeoutId);
        controller.timeoutId = null;
        if (controller.audio) {
            if (controller.onError) controller.audio.removeEventListener('error', controller.onError);
            controller.audio.pause();
            controller.audio.loop = false;
            controller.audio.src = '';
            controller.audio.load();
            controller.audio = null;
        }
        if (controller.blobUrl) this.revokeBlobUrl(controller.blobUrl);
        controller.blobUrl = null;
        this.controllers.delete(controller.taskId);
        if (this.currentController === controller) this.currentController = null;
        removeAlarmNotification(controller.taskId);
        if (processNext) void this.processQueue();
    }

    async convertPath(filePath) {
        if (!window.__TAURI__) return filePath;
        if (window.__TAURI__.core?.convertFileSrc) {
            try {
                return window.__TAURI__.core.convertFileSrc(filePath);
            } catch (error) {
                console.warn('[AlarmClock] convertFileSrc 失败，尝试 Blob 读取', error);
            }
        }

        const readFile = window.__TAURI__.fs?.readFile;
        if (!readFile) return filePath;
        const audioData = await readFile(filePath);
        const extension = filePath.toLowerCase().split('.').pop();
        const mimeType = {
            wav: 'audio/wav',
            mp3: 'audio/mpeg',
            ogg: 'audio/ogg',
            m4a: 'audio/mp4'
        }[extension] || 'audio/wav';
        const url = URL.createObjectURL(new Blob([audioData], { type: mimeType }));
        this.blobUrls.add(url);
        return url;
    }

    revokeBlobUrl(url) {
        if (!url?.startsWith('blob:')) return;
        URL.revokeObjectURL(url);
        this.blobUrls.delete(url);
    }

    suspend() {
        this.stopPreview();
    }
}
