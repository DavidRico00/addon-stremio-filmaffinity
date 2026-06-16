const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { decodeConfig, encodeConfig } = require('./lib/config');
const { scrapeList } = require('./lib/scraper');
const { resolveAll } = require('./lib/imdb-resolver');
const cache = require('./lib/cache');

const PORT = parseInt(process.env.PORT) || 7000;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

cache.init();

// --- In-memory store for resolved catalog data per user config ---
const catalogStore = {};

async function loadListData(userId, listId) {
    // Check memory/disk cache first
    let listData = cache.getListCache(userId, listId);
    if (listData) {
        console.log(`[Main] Using cached data for userId=${userId}, listId=${listId}`);
        return listData;
    }

    // Scrape and resolve
    console.log(`[Main] Scraping userId=${userId}, listId=${listId}...`);
    const scraped = await scrapeList(userId, listId);
    console.log(`[Main] Resolving IMDb IDs for ${scraped.items.length} items...`);
    const resolved = await resolveAll(scraped.items);
    console.log(`[Main] Resolved ${resolved.length}/${scraped.items.length} items`);

    listData = { listName: scraped.listName, items: resolved };
    cache.setListCache(userId, listId, listData);
    return listData;
}

function buildMetas(items, typeFilter) {
    return items
        .filter(item => item.type === typeFilter)
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
            name: `${name} (Películas)`,
        });
        catalogs.push({
            type: 'series',
            id: catalogId,
            name: `${name} (Series)`,
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
        cache.clearListCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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
