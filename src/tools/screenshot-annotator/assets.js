const DATABASE = 'dtkit-screenshot-assets';
let opening;

function database() {
    if (!opening) opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); opening = null; };
            resolve(db);
        };
    }).catch(error => { opening = null; throw error; });
    return opening;
}

// The page journal stores only this reference; image bytes never enter localStorage.
export async function storeImage(file) {
    const db = await database(), id = crypto.randomUUID();
    await new Promise((resolve, reject) => {
        const transaction = db.transaction('images', 'readwrite'), store = transaction.objectStore('images');
        const read = store.getAll();
        read.onsuccess = () => {
            const entries = read.result.sort((a, b) => a.created - b.created);
            let bytes = entries.reduce((total, entry) => total + entry.file.size, 0);
            while (entries.length && (bytes + file.size > 160 * 1024 * 1024 || entries.length >= 20)) {
                const oldest = entries.shift(); store.delete(oldest.id); bytes -= oldest.file.size;
            }
            store.put({ id, file, created: Date.now() });
        };
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('截图缓存不可用'));
    });
    return id;
}

export async function readImage(id) {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) return null;
    const db = await database();
    return new Promise((resolve, reject) => {
        const request = db.transaction('images').objectStore('images').get(id);
        request.onsuccess = () => resolve(request.result?.file || null);
        request.onerror = () => reject(request.error);
    });
}
