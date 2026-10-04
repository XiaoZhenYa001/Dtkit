export function createDesktopOrganizerState() {
    return {
        files: null,
        expandedCategories: new Set(['recent']),
        selectedFile: null,
        searchQuery: '',
        searchResults: [],
        searchIndex: [],
        isSearching: false,
        customCategories: [],
        fileCategories: {},
        folderView: {
            active: false,
            stack: [],
            categoryScrollTop: 0
        }
    };
}
