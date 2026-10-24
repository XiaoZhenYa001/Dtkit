const DATABASE = 'dtkit-color-picker-images';
const STORE = 'images';
let opening;

function database() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); opening = null; };
            resolve(db);
        };
    }).catch(error => { opening = null; throw error; });
    return opening;
}

export async function saveImageAsset(file) {
    const db = await database(), id = crypto.randomUUID();
    await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite'), store = transaction.objectStore(STORE);
        const request = store.getAll();
        request.onsuccess = () => {
            const entries = request.result.sort((a, b) => a.createdAt - b.createdAt);
            let size = entries.reduce((total, entry) => total + entry.size, 0), count = entries.length;
            while (entries.length && (size + file.size > 96 * 1024 * 1024 || count >= 12)) {
                const entry = entries.shift(); store.delete(entry.id); size -= entry.size; count--;
            }
            store.put({ id, file, size: file.size, name: file.name || '图片', createdAt: Date.now() });
        };
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('图片缓存不可用'));
    });
    return id;
}

export async function loadImageAsset(id) {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) return null;
    const db = await database();
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).get(id);
        request.onsuccess = () => resolve(request.result?.file || null);
        request.onerror = () => reject(request.error);
    });
}

export async function removeImageAsset(id) {
    if (!id) return;
    const db = await database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite'); transaction.objectStore(STORE).delete(id);
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
}
