export const QR_DIRECTORY_KEY = 'dtkit_qr_save_directory';

function validDirectory(value) {
    return typeof value === 'string' && value.length <= 4096 && !value.includes('\0');
}

// An explicit empty directory is a saved choice to use the default. Keeping it
// distinct from a missing preference prevents an old page draft restoring it.
export function readQrDirectoryPreference(storage) {
    try {
        const value = JSON.parse((storage || globalThis.localStorage)?.getItem(QR_DIRECTORY_KEY) || 'null');
        return value?.version === 1 && validDirectory(value.directory) ? value.directory : null;
    } catch { return null; }
}

export function writeQrDirectoryPreference(directory, storage) {
    if (!validDirectory(directory)) return false;
    try {
        const target = storage || globalThis.localStorage;
        if (!target) return false;
        target.setItem(QR_DIRECTORY_KEY, JSON.stringify({ version: 1, directory }));
        return true;
    } catch { return false; }
}
