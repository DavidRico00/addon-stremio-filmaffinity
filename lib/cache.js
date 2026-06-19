const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const IMDB_CACHE_FILE = path.join(CACHE_DIR, 'imdb-map.json');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let imdbCache = {};
let listCache = {};

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

// --- Redis helpers ---

async function redisSet(key, value) {
    if (!REDIS_URL || !REDIS_TOKEN) return;
    try {
        await axios.post(REDIS_URL, ['SET', key, JSON.stringify(value)], {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            timeout: 5000,
        });
    } catch (e) {
        console.error(`[Cache] Redis SET error (${key}):`, e.message);
    }
}

async function redisGet(key) {
    if (!REDIS_URL || !REDIS_TOKEN) return null;
    try {
        const res = await axios.post(REDIS_URL, ['GET', key], {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            timeout: 5000,
        });
        if (res.data && res.data.result) {
            return JSON.parse(res.data.result);
        }
        return null;
    } catch (e) {
        console.error(`[Cache] Redis GET error (${key}):`, e.message);
        return null;
    }
}

async function redisDel(key) {
    if (!REDIS_URL || !REDIS_TOKEN) return;
    try {
        await axios.post(REDIS_URL, ['DEL', key], {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            timeout: 5000,
        });
    } catch (e) {
        console.error(`[Cache] Redis DEL error (${key}):`, e.message);
    }
}

async function redisKeys(pattern) {
    if (!REDIS_URL || !REDIS_TOKEN) return [];
    try {
        const res = await axios.post(REDIS_URL, ['KEYS', pattern], {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            timeout: 5000,
        });
        return (res.data && res.data.result) || [];
    } catch (e) {
        console.error(`[Cache] Redis KEYS error:`, e.message);
        return [];
    }
}

// --- IMDb cache ---

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
    redisSet('imdb-cache', imdbCache);
}

// --- List cache ---

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
    const entry = { data, timestamp: Date.now() };
    listCache[key] = entry;

    ensureCacheDir();
    try {
        const file = path.join(CACHE_DIR, `list_${key}.json`);
        fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8');
    } catch (e) {
        console.error(`[Cache] Error saving list cache ${key}:`, e.message);
    }

    redisSet(`list:${key}`, entry);
}

// --- Load from disk ---

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

// --- Load from Redis (fallback when disk is empty) ---

async function loadFromRedis() {
    if (!REDIS_URL || !REDIS_TOKEN) return;

    const hasLocalData = Object.keys(listCache).length > 0 && Object.keys(imdbCache).length > 0;
    if (hasLocalData) {
        console.log('[Cache] Local cache found, skipping Redis load');
        return;
    }

    console.log('[Cache] Local cache empty, loading from Redis...');

    if (Object.keys(imdbCache).length === 0) {
        const redisImdb = await redisGet('imdb-cache');
        if (redisImdb && typeof redisImdb === 'object') {
            imdbCache = redisImdb;
            saveImdbCache();
            console.log(`[Cache] Loaded ${Object.keys(imdbCache).length} IMDb entries from Redis`);
        }
    }

    if (Object.keys(listCache).length === 0) {
        const keys = await redisKeys('list:*');
        for (const redisKey of keys) {
            const entry = await redisGet(redisKey);
            if (entry) {
                const key = redisKey.replace('list:', '');
                listCache[key] = entry;
            }
        }
        if (keys.length > 0) {
            console.log(`[Cache] Loaded ${keys.length} lists from Redis`);
        }
    }
}

// --- Init and clear ---

async function init() {
    loadImdbCache();
    loadListCacheFromDisk();
    await loadFromRedis();
}

async function clearAllCache() {
    listCache = {};
    imdbCache = {};
    ensureCacheDir();
    try {
        const files = fs.readdirSync(CACHE_DIR);
        for (const file of files) {
            fs.unlinkSync(path.join(CACHE_DIR, file));
        }
    } catch (e) { /* ignore */ }

    await redisDel('imdb-cache');
    const keys = await redisKeys('list:*');
    for (const key of keys) {
        await redisDel(key);
    }
}

module.exports = { init, getImdbId, setImdbId, getListCache, setListCache, clearAllCache };
