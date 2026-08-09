export function formatAudioFileSize(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    const value = Math.round((size / (1024 ** unitIndex)) * 100) / 100;
    return `${value} ${units[unitIndex]}`;
}

function selectAudioItem(items, selectedItem) {
    items.forEach(item => {
        const selected = item === selectedItem;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-checked', String(selected));
        item.tabIndex = selected ? 0 : -1;
    });
}

function createAudioItem(audio, selected, getItems, { signal, onPreview }) {
    const item = document.createElement('div');
    item.className = `alarm-audio-item${selected ? ' selected' : ''}`;
    item.dataset.audioPath = String(audio.path || '');
    item.dataset.audioName = String(audio.name || '');
    item.setAttribute('role', 'radio');
    item.setAttribute('aria-checked', String(selected));
    item.tabIndex = selected ? 0 : -1;

    const icon = document.createElement('div');
    icon.className = 'alarm-audio-icon';
    icon.innerHTML = '<i class="ri-music-2-line"></i>';

    const info = document.createElement('div');
    info.className = 'alarm-audio-info';
    const name = document.createElement('div');
    name.className = 'alarm-audio-name';
    name.textContent = String(audio.name || '未命名音频');
    name.title = name.textContent;
    const size = document.createElement('div');
    size.className = 'alarm-audio-size';
    size.textContent = formatAudioFileSize(audio.size);
    info.append(name, size);

    const previewButton = document.createElement('button');
    previewButton.className = 'alarm-audio-preview-btn';
    previewButton.type = 'button';
    previewButton.dataset.audioPath = item.dataset.audioPath;
    previewButton.setAttribute('aria-label', `预览 ${name.textContent}`);
    previewButton.innerHTML = '<i class="ri-play-line"></i>';
    previewButton.addEventListener('click', event => {
        event.stopPropagation();
        void onPreview(item.dataset.audioPath);
    }, { signal });

    const select = () => selectAudioItem(getItems(), item);
    item.addEventListener('click', select, { signal });
    item.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select();
    }, { signal });
    item.append(icon, info, previewButton);
    return item;
}

function renderSoundConfig(container, audioFiles, handlers) {
    const group = document.createElement('div');
    group.className = 'alarm-input-group';

    const label = document.createElement('div');
    label.className = 'alarm-label';
    label.textContent = '选择提示音';
    const openFolderButton = document.createElement('button');
    openFolderButton.className = 'alarm-open-folder-btn';
    openFolderButton.type = 'button';
    openFolderButton.title = '打开音频文件夹';
    openFolderButton.setAttribute('aria-label', '打开音频文件夹');
    openFolderButton.innerHTML = '<i class="ri-folder-open-line"></i>';
    openFolderButton.addEventListener('click', () => void handlers.onOpenFolder(), {
        signal: handlers.signal
    });
    label.appendChild(openFolderButton);

    const list = document.createElement('div');
    list.className = 'alarm-audio-list';
    list.id = 'audioList';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', '提示音列表');
    const playableFiles = audioFiles.filter(audio => String(audio?.path || '').length > 0);
    if (playableFiles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'alarm-no-audio';
        empty.innerHTML = '<i class="ri-music-line alarm-audio-empty__icon"></i>';
        const title = document.createElement('p');
        title.textContent = '未找到音频文件';
        const hint = document.createElement('p');
        hint.className = 'alarm-audio-empty__hint';
        hint.textContent = '请将音频放入应用数据目录的 Kits/Alarm 文件夹';
        empty.append(title, hint);
        list.appendChild(empty);
    } else {
        const getItems = () => [...list.querySelectorAll('.alarm-audio-item')];
        playableFiles.forEach((audio, index) => {
            list.appendChild(createAudioItem(audio, index === 0, getItems, handlers));
        });
    }

    group.append(label, list);
    container.appendChild(group);
    return playableFiles.length > 0;
}

function renderProgramConfig(container, { signal, onSelectProgram }) {
    container.innerHTML = `
        <div class="alarm-input-group">
            <span class="alarm-label">选择程序或脚本</span>
            <div class="alarm-file-picker">
                <div class="alarm-file-path" id="selectedFilePath">未选择文件</div>
                <button class="alarm-file-btn" id="selectFileBtn" type="button">
                    <i class="ri-folder-open-line"></i> 浏览
                </button>
            </div>
        </div>`;
    container.querySelector('#selectFileBtn')?.addEventListener('click', () => {
        void onSelectProgram();
    }, { signal });
}

export function renderAlarmActionConfig(container, actionType, audioFiles, handlers) {
    container.replaceChildren();
    if (actionType === 'sound') return renderSoundConfig(container, audioFiles, handlers);
    if (actionType === 'run') renderProgramConfig(container, handlers);
    return true;
}
