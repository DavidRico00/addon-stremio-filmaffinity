const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const IMDB_CACHE_FILE = path.join(CACHE_DIR, 'imdb-map.json');

let imdbCache = {};
let listCache = {};

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function loadImdbCache() {
    ensureCacheDir();
    try {
        if (fs.existsSync(IMDB_CACHE_FILE)) {
            imdbCache = JSON.parse(fs.readFileSync(IMDB_CACHE_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[Cache] Error loading IMDb cache:', e.message);
        imdbCache = {};
    }
}

function saveImdbCache() {
    ensureCacheDir();
    try {
        fs.writeFileSync(IMDB_CACHE_FILE, JSON.stringify(imdbCache, null, 2), 'utf8');
    } catch (e) {
        console.error('[Cache] Error saving IMDb cache:', e.message);
    }
}

function getImdbId(faId) {
    const val = imdbCache[faId];
    if (!val) return null;
    if (val === 'NOT_FOUND') return 'NOT_FOUND';
    if (typeof val === 'string') return null;
    return val;
}

function setImdbId(faId, imdbId) {
    imdbCache[faId] = imdbId;
    saveImdbCache();
}

function getListCacheKey(userId, listId) {
    return `${userId}_${listId}`;
}

function getListCache(userId, listId, ignoreExpiry) {
    const key = getListCacheKey(userId, listId);
    const entry = listCache[key];
    if (!entry) return null;

    if (!ignoreExpiry) {
        const maxAge = (parseInt(process.env.CACHE_HOURS) || 24) * 60 * 60 * 1000;
        if (Date.now() - entry.timestamp > maxAge) return null;
    }

    return entry.data;
}

function setListCache(userId, listId, data) {
    const key = getListCacheKey(userId, listId);
    listCache[key] = { data, timestamp: Date.now() };

    ensureCacheDir();
    try {
        const file = path.join(CACHE_DIR, `list_${key}.json`);
        fs.writeFileSync(file, JSON.stringify({ data, timestamp: Date.now() }, null, 2), 'utf8');
    } catch (e) {
        console.error(`[Cache] Error saving list cache ${key}:`, e.message);
    }
}

function loadListCacheFromDisk() {
    ensureCacheDir();
    try {
        const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith('list_') && f.endsWith('.json'));
        for (const file of files) {
            try {
                const content = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
                const key = file.replace('list_', '').replace('.json', '');
                listCache[key] = content;
            } catch (e) { /* skip corrupted files */ }
        }
    } catch (e) { /* cache dir might not exist yet */ }
}

function init() {
    loadImdbCache();
    loadListCacheFromDisk();
}

function clearAllCache() {
    listCache = {};
    imdbCache = {};
    ensureCacheDir();
    try {
        const files = fs.readdirSync(CACHE_DIR);
        for (const file of files) {
            fs.unlinkSync(path.join(CACHE_DIR, file));
        }
    } catch (e) { /* ignore */ }
}

module.exports = { init, getImdbId, setImdbId, getListCache, setListCache, clearAllCache };
