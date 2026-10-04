const PREFS_KEY = 'desktopOrganizerPrefs';

export function createWindowController({ invoke, appWindow, state, dragHandle, storage, document, window }) {
    let isResizing = false;
    let resizeDirection = '';
    let startX;
    let startY;
    let startWidth;
    let startHeight;
    let startWindowX;
    let startWindowY;
    let resizeEndTimeout = null;
    let screenBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    let lastResizeUpdate = 0;
    let resizeUpdatePending = false;

    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartWindowX = 0;
    let dragStartWindowY = 0;
    let dragStartWindowWidth = 0;
    let dragStartWindowHeight = 0;
    let lastDragUpdate = 0;
    let dragUpdatePending = false;
    let dragMoved = false;

    async function notifyInteracting(interacting) {
        try {
            window.__userInteracting = interacting;
            await invoke('set_user_interacting', { interacting });
        } catch {
            // Older backends may not expose the interaction command.
        }
    }

    async function getWindowInfo() {
        const size = await appWindow.innerSize();
        const position = await appWindow.innerPosition();
        return { width: size.width, height: size.height, x: position.x, y: position.y };
    }

    async function updateScreenBounds() {
        try {
            const bounds = await invoke('get_screen_bounds');
            if (bounds) screenBounds = bounds;
        } catch {
            screenBounds = {
                x: (window.screen.availLeft || 0) * window.devicePixelRatio,
                y: (window.screen.availTop || 0) * window.devicePixelRatio,
                width: window.screen.width * window.devicePixelRatio,
                height: window.screen.height * window.devicePixelRatio
            };
        }
    }

    function clampPosition(x, y, width, height) {
        const margin = 10;
        const left = (screenBounds.x || 0) + margin;
        const top = (screenBounds.y || 0) + margin;
        const right = (screenBounds.x || 0) + screenBounds.width - width - margin;
        const bottom = (screenBounds.y || 0) + screenBounds.height - height - margin;
        return {
            x: Math.max(left, Math.min(Math.max(left, right), x)),
            y: Math.max(top, Math.min(Math.max(top, bottom), y))
        };
    }

    function clampSize(width, height) {
        return {
            width: Math.max(400, Math.min(screenBounds.width - 20, width)),
            height: Math.max(300, Math.min(screenBounds.height - 20, height))
        };
    }

    async function savePreferences() {
        try {
            const size = await appWindow.innerSize();
            const position = await appWindow.innerPosition();
            storage.setItem(PREFS_KEY, JSON.stringify({
                width: size.width,
                height: size.height,
                positionX: position.x,
                expandedCategories: Array.from(state.expandedCategories)
            }));
            try {
                await invoke('update_hotzone_position', {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height
                });
            } catch {
                // The hotzone integration is optional.
            }
        } catch (error) {
            console.error('保存偏好失败:', error);
        }
    }

    async function loadPreferences() {
        let prefs = null;
        try {
            const saved = storage.getItem(PREFS_KEY);
            prefs = saved ? JSON.parse(saved) : null;
        } catch {
            storage.removeItem(PREFS_KEY);
        }

        try {
            if (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) {
                const { width, height, positionX, expandedCategories } = prefs;
                if (Number.isFinite(width) && Number.isFinite(height) && width >= 400 && height >= 300) {
                    await appWindow.setSize({ type: 'Physical', width: Math.round(width), height: Math.round(height) });
                }
                if (Number.isFinite(positionX)) {
                    const position = await appWindow.innerPosition();
                    await appWindow.setPosition({ type: 'Physical', x: Math.round(positionX), y: position.y });
                }
                if (Array.isArray(expandedCategories)) {
                    state.expandedCategories = new Set(expandedCategories
                        .filter(value => typeof value === 'string')
                        .slice(0, 64));
                }
            }
        } catch (error) {
            console.error('加载偏好失败:', error);
        }

        try {
            await invoke('clamp_desktop_organizer_window');
            await savePreferences();
        } catch (error) {
            console.error('校正桌面整理窗口失败:', error);
        }
    }

    async function cancelInteractions() {
        if (!isDragging && !isResizing) return;
        isDragging = false;
        isResizing = false;
        document.body.style.cursor = '';
        document.body.classList.remove('is-dragging', 'is-resizing');
        if (dragHandle) dragHandle.style.cursor = '';
        if (resizeEndTimeout) {
            clearTimeout(resizeEndTimeout);
            resizeEndTimeout = null;
        }
        await notifyInteracting(false);
    }

    async function syncHotzonePosition() {
        try {
            const { x, y, width, height } = await getWindowInfo();
            await invoke('update_hotzone_position', { x, y, width, height });
        } catch {
            // The hotzone integration is optional.
        }
    }

    document.querySelectorAll('.resize-handle').forEach(handle => {
        handle.addEventListener('mousedown', async event => {
            if (isDragging) return;
            isResizing = true;
            resizeDirection = handle.dataset.direction;
            startX = event.screenX;
            startY = event.screenY;
            const info = await getWindowInfo();
            startWidth = info.width;
            startHeight = info.height;
            startWindowX = info.x;
            startWindowY = info.y;
            await updateScreenBounds();
            document.body.style.cursor = getComputedStyle(handle).cursor;
            document.body.classList.add('is-resizing');
            event.preventDefault();
            event.stopPropagation();
            if (resizeEndTimeout) clearTimeout(resizeEndTimeout);
            resizeEndTimeout = null;
            await notifyInteracting(true);
        });
    });

    document.addEventListener('mousemove', async event => {
        if (isResizing) {
            if (resizeUpdatePending || Date.now() - lastResizeUpdate < 32) return;
            lastResizeUpdate = Date.now();
            const deltaX = event.screenX - startX;
            const deltaY = event.screenY - startY;
            let newWidth = startWidth;
            let newHeight = startHeight;
            let newX = startWindowX;
            let newY = startWindowY;

            if (resizeDirection === 'r') newWidth += deltaX;
            else if (resizeDirection === 'l') {
                newWidth -= deltaX;
                newX += deltaX;
            } else if (resizeDirection === 'b') newHeight += deltaY;
            else if (resizeDirection === 'br') {
                newWidth += deltaX;
                newHeight += deltaY;
            } else if (resizeDirection === 'bl') {
                newWidth -= deltaX;
                newHeight += deltaY;
                newX += deltaX;
            }

            ({ width: newWidth, height: newHeight } = clampSize(newWidth, newHeight));
            if (resizeDirection === 'l' || resizeDirection === 'bl') newX = startWindowX - (newWidth - startWidth);
            ({ x: newX, y: newY } = clampPosition(newX, newY, newWidth, newHeight));

            try {
                resizeUpdatePending = true;
                await appWindow.setSize({ type: 'Physical', width: Math.round(newWidth), height: Math.round(newHeight) });
                if (resizeDirection === 'l' || resizeDirection === 'bl') {
                    await appWindow.setPosition({ type: 'Physical', x: Math.round(newX), y: Math.round(newY) });
                }
            } catch (error) {
                console.error('调整窗口失败:', error);
            } finally {
                resizeUpdatePending = false;
            }
            return;
        }

        if (!isDragging || dragUpdatePending) return;
        const moveX = Math.abs(event.screenX - dragStartX);
        const moveY = Math.abs(event.screenY - dragStartY);
        if (!dragMoved && (moveX > 3 || moveY > 3)) dragMoved = true;
        if (!dragMoved || Date.now() - lastDragUpdate < 32) return;
        lastDragUpdate = Date.now();

        let newX = dragStartWindowX + event.screenX - dragStartX;
        let newY = dragStartWindowY + event.screenY - dragStartY;
        ({ x: newX, y: newY } = clampPosition(newX, newY, dragStartWindowWidth, dragStartWindowHeight));

        const snapDistance = 15;
        const left = screenBounds.x || 0;
        const top = screenBounds.y || 0;
        const right = left + screenBounds.width;
        const bottom = top + screenBounds.height;
        if (Math.abs(newX - left) < snapDistance) newX = left;
        if (Math.abs(newY - top) < snapDistance) newY = top;
        if (Math.abs(newX + dragStartWindowWidth - right) < snapDistance) newX = right - dragStartWindowWidth;
        if (Math.abs(newY + dragStartWindowHeight - bottom) < snapDistance) newY = bottom - dragStartWindowHeight;

        try {
            dragUpdatePending = true;
            await appWindow.setPosition({ type: 'Physical', x: Math.round(newX), y: Math.round(newY) });
        } catch (error) {
            console.error('移动窗口失败:', error);
        } finally {
            dragUpdatePending = false;
        }
    });

    document.addEventListener('mouseup', async () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.classList.remove('is-resizing');
            await savePreferences();
            resizeEndTimeout = setTimeout(async () => {
                await notifyInteracting(false);
                resizeEndTimeout = null;
            }, 300);
        }

        if (isDragging) {
            isDragging = false;
            document.body.style.cursor = '';
            document.body.classList.remove('is-dragging');
            if (dragHandle) dragHandle.style.cursor = '';
            if (dragMoved) await savePreferences();
            setTimeout(() => void notifyInteracting(false), 300);
        }
    });

    document.addEventListener('selectstart', event => {
        if (isResizing || isDragging) event.preventDefault();
    });

    dragHandle?.addEventListener('mousedown', async event => {
        if (isResizing || event.button !== 0) return;
        isDragging = true;
        dragMoved = false;
        dragStartX = event.screenX;
        dragStartY = event.screenY;
        const position = await appWindow.innerPosition();
        const size = await appWindow.innerSize();
        dragStartWindowX = position.x;
        dragStartWindowY = position.y;
        dragStartWindowWidth = size.width;
        dragStartWindowHeight = size.height;
        await updateScreenBounds();
        document.body.style.cursor = 'grabbing';
        document.body.classList.add('is-dragging');
        dragHandle.style.cursor = 'grabbing';
        await notifyInteracting(true);
        event.preventDefault();
    });

    return { loadPreferences, savePreferences, cancelInteractions, syncHotzonePosition };
}
