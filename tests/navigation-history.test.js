import assert from 'node:assert/strict';
import test from 'node:test';

const values = new Map();
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
};
globalThis.window = {};
globalThis.document = { getElementById: () => null };

const { default: appState } = await import('../src/core/state.js');
const {
    captureCurrentScrollPosition,
    getCurrentHistoryScrollTop,
    goBack,
    goForward,
    recordHistoryEntry,
    setNavigationCallbacks
} = await import('../src/components/navigation.js');
const { default: DOM } = await import('../src/core/dom.js');

const tools = new Map([
    ['alpha', { id: 'alpha', name: 'Alpha', icon: 'ri-a-b', category: 'dev', enabled: true }],
    ['beta', { id: 'beta', name: 'Beta', icon: 'ri-b', category: 'utility', enabled: true }],
    ['disabled', { id: 'disabled', name: 'Disabled', icon: 'ri-close-line', category: 'other', enabled: false }]
]);

setNavigationCallbacks({
    onRenderTabs: () => {},
    onUpdateContentView: () => {},
    onGetTool: id => tools.get(id)
});

function reset(history, historyIndex) {
    appState.tabs = [{
        id: 'test', title: 'Beta', icon: 'ri-b', badge: '工具', toolId: 'beta',
        viewType: 'favorites', history, historyIndex
    }];
    appState.activeTabId = 'test';
    appState.currentView = 'beta';
}

test('back and forward restore both the page and its source view', () => {
    reset([
        { toolId: null, viewType: 'toolLibrary' },
        { toolId: 'alpha', viewType: 'toolLibrary' },
        { toolId: null, viewType: 'favorites' },
        { toolId: 'beta', viewType: 'favorites' }
    ], 3);

    goBack();
    assert.equal(appState.currentView, 'favorites');
    goBack();
    assert.equal(appState.currentView, 'alpha');
    assert.equal(appState.tabs[0].viewType, 'toolLibrary');
    goForward();
    assert.equal(appState.currentView, 'favorites');
});

test('recording a page truncates the obsolete forward branch without duplicates', () => {
    reset([
        { toolId: null, viewType: 'toolLibrary' },
        { toolId: 'alpha', viewType: 'toolLibrary' },
        { toolId: 'beta', viewType: 'toolLibrary' }
    ], 1);

    assert.equal(recordHistoryEntry(appState.tabs[0], { toolId: null, viewType: 'favorites' }), true);
    assert.deepEqual(appState.tabs[0].history, [
        { toolId: null, viewType: 'toolLibrary' },
        { toolId: 'alpha', viewType: 'toolLibrary' },
        { toolId: null, viewType: 'favorites' }
    ]);
    assert.equal(recordHistoryEntry(appState.tabs[0], { toolId: null, viewType: 'favorites' }), false);
});

test('history skips tools that have since been disabled', () => {
    reset([
        { toolId: null, viewType: 'toolLibrary' },
        { toolId: 'disabled', viewType: 'toolLibrary' },
        { toolId: null, viewType: 'favorites' }
    ], 2);

    goBack();
    assert.equal(appState.currentView, 'toolLibrary');
    assert.equal(appState.tabs[0].historyIndex, 0);
});

test('history preserves the real content scroller position when returning to the tool library', () => {
    reset([
        { toolId: null, viewType: 'toolLibrary' }
    ], 0);
    appState.tabs[0].toolId = null;
    appState.tabs[0].viewType = 'toolLibrary';
    appState.currentView = 'toolLibrary';
    DOM.contentArea = { scrollTop: 684 };

    captureCurrentScrollPosition();
    assert.equal(appState.tabs[0].history[0].scrollTop, 684);

    recordHistoryEntry(appState.tabs[0], { toolId: 'alpha', viewType: 'toolLibrary' });
    DOM.contentArea.scrollTop = 0;
    goBack();

    assert.equal(getCurrentHistoryScrollTop(), 684);
});
