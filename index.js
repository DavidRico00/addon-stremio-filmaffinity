const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { decodeConfig, encodeConfig } = require('./lib/config');
const { scrapeList, parseHtml } = require('./lib/scraper');
const { resolveAll, resolveWithHtml } = require('./lib/imdb-resolver');
const cache = require('./lib/cache');

const PORT = parseInt(process.env.PORT) || 7000;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

cache.init().then(() => {
    console.log('[Main] Cache initialized');
}).catch(err => {
    console.error('[Main] Cache init error:', err.message);
});

// --- In-memory store for resolved catalog data per user config ---
const catalogStore = {};

async function loadListData(userId, listId) {
    let listData = cache.getListCache(userId, listId);
    if (listData) {
        console.log(`[Main] Using cached data for userId=${userId}, listId=${listId}`);
        return listData;
    }

    console.log(`[Main] Scraping userId=${userId}, listId=${listId}...`);
    try {
        const scraped = await scrapeList(userId, listId);
        console.log(`[Main] Resolving IMDb IDs for ${scraped.items.length} items...`);
        const resolved = await resolveAll(scraped.items);
        console.log(`[Main] Resolved ${resolved.length}/${scraped.items.length} items`);

        listData = { listName: scraped.listName, items: resolved };
        cache.setListCache(userId, listId, listData);
        return listData;
    } catch (err) {
        console.error(`[Main] Scraping failed: ${err.message}`);
        const stale = cache.getListCache(userId, listId, true);
        if (stale) {
            console.log(`[Main] Using stale cache as fallback`);
            return stale;
        }
        throw err;
    }
}

function buildMetas(items, typeFilter) {
    return items
        .filter(item => item.imdbId && item.type === typeFilter)
        .sort((a, b) => a.position - b.position)
        .map(item => ({
            id: item.imdbId,
            type: item.type,
            name: item.title,
            ...(item.poster ? { poster: item.poster } : {}),
            ...(item.year ? { releaseInfo: String(item.year) } : {}),
        }));
}

// --- HTTP server that handles both config page and addon SDK ---
const configHtml = fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8');

function handleConfigPage(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(configHtml.replace('__BASE_URL__', BASE_URL));
}

function handleGenerateConfig(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const config = JSON.parse(body);
            const encoded = encodeConfig(config);
            const installUrl = `${BASE_URL}/${encoded}/manifest.json`;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ installUrl, configId: encoded }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid config' }));
        }
    });
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function handleAddonRequest(configId, pathParts, res) {
    const config = decodeConfig(configId);
    if (!config || !config.lists || config.lists.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid configuration' }));
        return;
    }

    const resource = pathParts[0];

    if (resource === 'manifest.json') {
        const manifest = await buildManifest(config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(manifest));
        return;
    }

    // Routes: /catalog/{type}/{catalogId}.json or /catalog/{type}/{catalogId}/skip={n}.json
    if (resource === 'catalog') {
        const type = pathParts[1]; // movie or series
        let catalogIdRaw = pathParts[2] || '';
        catalogIdRaw = catalogIdRaw.replace('.json', '');

        // Handle skip parameter
        const skipMatch = catalogIdRaw.match(/\/skip=(\d+)/);
        catalogIdRaw = catalogIdRaw.split('/')[0];

        const listConfig = config.lists.find(l => getCatalogId(l) === catalogIdRaw);
        if (!listConfig) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ metas: [] }));
            return;
        }

        try {
            const data = await loadListData(listConfig.userId, listConfig.listId);
            const metas = buildMetas(data.items, type);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ metas }));
        } catch (err) {
            console.error(`[Main] Error loading catalog: ${err.message}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ metas: [] }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
}

function getCatalogId(listConfig) {
    return `fa_${listConfig.userId}_${listConfig.listId}`;
}

async function buildManifest(config) {
    const catalogs = [];

    for (const listConf of config.lists) {
        const catalogId = getCatalogId(listConf);
        let name = listConf.alias || '';

        if (!name) {
            try {
                const data = await loadListData(listConf.userId, listConf.listId);
                name = data.listName || `Lista ${listConf.listId}`;
            } catch {
                name = `Lista ${listConf.listId}`;
            }
        }

        catalogs.push({
            type: 'movie',
            id: catalogId,
            name,
        });
        catalogs.push({
            type: 'series',
            id: catalogId,
            name,
        });
    }

    return {
        id: 'community.filmaffinity.lists',
        version: '1.0.0',
        name: 'Filmaffinity Lists',
        description: 'Browse your public Filmaffinity lists as Stremio catalogs',
        logo: 'https://www.filmaffinity.com/images/logo4.png',
        resources: ['catalog'],
        types: ['movie', 'series'],
        catalogs,
        behaviorHints: {
            configurable: true,
        },
    };
}

// --- Custom HTTP server ---
const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

    // Configuration page
    if (pathname === '/configure' || pathname === '') {
        handleConfigPage(req, res);
        return;
    }

    if (pathname === '/' ) {
        handleConfigPage(req, res);
        return;
    }

    // API to generate config
    if (pathname === '/api/generate-config' && req.method === 'POST') {
        handleGenerateConfig(req, res);
        return;
    }

    // API to clear cache
    if (pathname === '/api/clear-cache' && req.method === 'POST') {
        await cache.clearAllCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // Sync endpoint: receive HTML from Termux/client, parse and resolve
    if (pathname === '/api/sync' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                let userId, listId, html;

                const contentType = req.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    const json = JSON.parse(body);
                    userId = json.userId;
                    listId = json.listId;
                    html = json.html;
                } else {
                    userId = parsed.query.userId;
                    listId = parsed.query.listId;
                    html = body;
                }

                if (!userId || !listId || !html) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing userId, listId, or html' }));
                    return;
                }

                console.log(`[Sync] Received HTML for userId=${userId}, listId=${listId} (${html.length} chars)`);
                const result = parseHtml(html);
                console.log(`[Sync] Parsed ${result.items.length} items from list "${result.listName}"`);

                const resolved = await resolveAll(result.items);
                console.log(`[Sync] Resolved ${resolved.length}/${result.items.length} IMDb IDs`);

                const resolvedIds = new Set(resolved.map(r => r.faId));
                const unresolved = result.items.filter(item => !resolvedIds.has(item.faId));

                const allItems = [
                    ...resolved,
                    ...unresolved,
                ];
                const listData = { listName: result.listName, items: allItems };
                cache.setListCache(userId, listId, listData);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    listName: result.listName,
                    parsed: result.items.length,
                    resolved: resolved.length,
                    unresolved: unresolved.map(i => ({ faId: i.faId, title: i.title, year: i.year, type: i.type })),
                }));
            } catch (e) {
                console.error(`[Sync] Error: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Sync-resolve endpoint: resolve a single item using pre-fetched FA film page HTML
    if (pathname === '/api/sync-resolve' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const userId = parsed.query.userId;
                const listId = parsed.query.listId;
                const faId = parsed.query.faId;
                const title = decodeURIComponent(parsed.query.title || '');
                const year = parseInt(parsed.query.year) || null;
                const type = parsed.query.type || 'movie';
                const lang = parsed.query.lang || 'es';

                if (!faId || !body) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing faId or HTML body' }));
                    return;
                }

                const esHtml = lang === 'es' ? body : null;
                const enHtml = lang === 'en' ? body : null;

                const result = await resolveWithHtml(faId, title, year, type, esHtml, enHtml);

                if (result && userId && listId) {
                    const listData = cache.getListCache(userId, listId, true);
                    if (listData) {
                        const existing = listData.items.find(i => i.faId === faId);
                        if (existing) {
                            existing.imdbId = result.id;
                            existing.type = result.type;
                        } else {
                            listData.items.push({
                                faId, title, year, type: result.type,
                                imdbId: result.id, position: listData.items.length + 1,
                            });
                        }
                        cache.setListCache(userId, listId, listData);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    faId,
                    resolved: result ? true : false,
                    imdbId: result ? result.id : null,
                }));
            } catch (e) {
                console.error(`[SyncResolve] Error: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Debug endpoint
    if (pathname === '/api/debug-list' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { userId, listId } = JSON.parse(body);
                const { execSync } = require('child_process');
                const testUrl = `https://www.filmaffinity.com/es/userlist.php?user_id=${userId}&list_id=${listId}`;
                let curlVersion = 'unknown';
                try { curlVersion = execSync('curl --version', { encoding: 'utf8', timeout: 5000 }).split('\n')[0]; } catch(e) { curlVersion = 'not found: ' + e.message; }
                let html = '';
                try {
                    html = execSync(`curl -s -L --max-time 15 -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" "${testUrl}"`, { encoding: 'utf8', timeout: 20000 });
                } catch(e) { html = 'curl error: ' + e.message; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    curlVersion,
                    htmlLength: html.length,
                    hasMovieCards: html.includes('data-movie-id'),
                    htmlStart: html.substring(0, 1000),
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Addon routes: /{configId}/manifest.json, /{configId}/catalog/..., /{configId}/configure
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
        const configId = parts[0];
        const restParts = parts.slice(1);

        // Stremio opens /{configId}/configure when configurable is true
        if (restParts[0] === 'configure') {
            handleConfigPage(req, res);
            return;
        }

        try {
            await handleAddonRequest(configId, restParts, res);
        } catch (err) {
            console.error(`[Server] Error handling request: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal error' }));
        }
        return;
    }

    // Handle /{configId} alone (single path segment that looks like base64)
    if (parts.length === 1 && parts[0].length > 20) {
        handleConfigPage(req, res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`\n=== Filmaffinity Lists Stremio Addon ===`);
    console.log(`Server running at ${BASE_URL}`);
    console.log(`Configure: ${BASE_URL}/configure`);
    console.log(`\nReady to serve catalogs!\n`);
});
