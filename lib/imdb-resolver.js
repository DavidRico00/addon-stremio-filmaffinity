const axios = require('axios');
const cheerio = require('cheerio');
const cache = require('./cache');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const http = axios.create({
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
});

const DELAY_MS = 350;
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveImdbId(faId, title, year, type) {
    const cached = cache.getImdbId(faId);
    if (cached) {
        if (cached === 'NOT_FOUND') return null;
        if (typeof cached === 'object') return cached;
        return { id: cached, type };
    }

    try {
        // Strategy 1: Search with the Spanish title
        let result = await tryImdbSuggestions(title, year, type);

        // Strategy 2: Simplified Spanish title (remove subtitle)
        if (!result) {
            const simplified = simplifyTitle(title);
            if (simplified !== title) {
                result = await tryImdbSuggestions(simplified, year, type);
            }
        }

        // Strategy 3: Fetch original title from Filmaffinity Spanish page
        if (!result) {
            const origTitle = await fetchOriginalTitle(faId);
            if (origTitle && origTitle.toLowerCase() !== title.toLowerCase()) {
                console.log(`[IMDb] Trying original title: "${origTitle}" for "${title}"`);
                result = await tryImdbSuggestions(origTitle, year, type);

                if (!result) {
                    const simpOrig = simplifyTitle(origTitle);
                    if (simpOrig !== origTitle) {
                        result = await tryImdbSuggestions(simpOrig, year, type);
                    }
                }
            }
        }

        // Strategy 4: Fetch English title from Filmaffinity English page
        if (!result) {
            const enTitle = await fetchEnglishTitle(faId);
            if (enTitle && enTitle.toLowerCase() !== title.toLowerCase()) {
                console.log(`[IMDb] Trying English title: "${enTitle}" for "${title}"`);
                result = await tryImdbSuggestions(enTitle, year, type);

                if (!result) {
                    const simpEn = simplifyTitle(enTitle);
                    if (simpEn !== enTitle) {
                        result = await tryImdbSuggestions(simpEn, year, type);
                    }
                }
            }
        }

        if (result) {
            cache.setImdbId(faId, result);
            console.log(`[IMDb] Resolved: "${title}" (${year}) → ${result.id} [${result.type}]`);
            return result;
        }
    } catch (err) {
        console.error(`[IMDb] Error resolving "${title}" (${year}): ${err.message}`);
    }

    cache.setImdbId(faId, 'NOT_FOUND');
    console.warn(`[IMDb] Could not resolve: "${title}" (${year}) [faId=${faId}]`);
    return null;
}

async function fetchOriginalTitle(faId) {
    try {
        await delay(DELAY_MS);
        const url = `https://www.filmaffinity.com/es/film${faId}.html`;
        const res = await http.get(url);
        const $ = cheerio.load(res.data);

        // Look for "Título original" (original title) in the film page
        // It's typically in a dt/dd pair or a specific element
        let origTitle = null;

        $('dt').each((_, dt) => {
            if ($(dt).text().trim().toLowerCase().includes('título original')) {
                const dd = $(dt).next('dd');
                if (dd.length) {
                    // Remove the "aka" span before extracting text
                    dd.find('.show-akas').remove();
                    origTitle = dd.text().trim();
                }
            }
        });

        if (!origTitle) {
            const ogTitle = $('meta[property="og:title"]').attr('content') || '';
            if (ogTitle) origTitle = ogTitle.replace(/ - Filmaffinity$/i, '').trim();
        }

        if (origTitle) {
            origTitle = origTitle.replace(/\s*\(aka.*?\)\s*/gi, '').trim();
            origTitle = origTitle.replace(/\s*aka\s*$/i, '').trim();
        }

        return origTitle || null;
    } catch (err) {
        console.error(`[IMDb] Error fetching original title for faId=${faId}: ${err.message}`);
        return null;
    }
}

async function fetchEnglishTitle(faId) {
    try {
        await delay(DELAY_MS);
        const url = `https://www.filmaffinity.com/en/film${faId}.html`;
        const res = await http.get(url);
        const $ = cheerio.load(res.data);

        // The English title is the page heading, NOT the "Original title" field
        let enTitle = null;

        const h1 = $('h1#main-title').text().trim();
        if (h1) enTitle = h1;

        if (!enTitle) {
            const ogTitle = $('meta[property="og:title"]').attr('content') || '';
            if (ogTitle) {
                enTitle = ogTitle.replace(/\s*\(\d{4}\)\s*$/, '').replace(/ - Filmaffinity$/i, '').trim();
            }
        }

        return enTitle || null;
    } catch (err) {
        console.error(`[IMDb] Error fetching English title for faId=${faId}: ${err.message}`);
        return null;
    }
}

async function tryImdbSuggestions(title, year, type) {
    const query = title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    if (!query) return null;
    const firstChar = query[0] || 'a';
    const url = `https://v2.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(query)}.json`;

    await delay(DELAY_MS);

    try {
        const res = await http.get(url);
        const data = res.data;
        if (!data || !data.d) return null;

        const candidates = data.d.filter(item => item.id && item.id.startsWith('tt'));

        let bestMatch = null;
        let bestScore = -1;

        for (const item of candidates) {
            let score = 0;
            const itemTitle = normalizeTitle(item.l || '');
            const searchTitle = normalizeTitle(title);

            if (itemTitle === searchTitle) {
                score += 10;
            } else if (itemTitle.includes(searchTitle) || searchTitle.includes(itemTitle)) {
                score += 5;
            } else {
                score -= 5;
            }

            if (year && item.y) {
                const diff = Math.abs(item.y - year);
                if (diff === 0) score += 5;
                else if (diff === 1) score += 3;
                else if (diff <= 2) score += 1;
                else score -= 3;
            }

            const itemType = (item.qid || item.q || '').toLowerCase();
            if (type === 'series') {
                if (itemType.includes('tvseries') || itemType.includes('tvmini')) score += 3;
            } else {
                if (itemType.includes('movie') || itemType.includes('feature')) score += 3;
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = item;
            }
        }

        if (bestMatch && bestScore >= 5) {
            const matchType = (bestMatch.qid || bestMatch.q || '').toLowerCase();
            let resolvedType = 'movie';
            if (matchType.includes('tvseries') || matchType.includes('tvmini')) {
                resolvedType = 'series';
            }
            return { id: bestMatch.id, type: resolvedType };
        }

        return null;
    } catch (err) {
        if (err.response && err.response.status === 404) return null;
        throw err;
    }
}

function normalizeTitle(title) {
    return title.normalize('NFD')
                .replace(/[̀-ͯ]/g, '')
                .replace(/[^\w\s]/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
}

function simplifyTitle(title) {
    const simplified = title.split(/[:\-–—.]/).shift().trim();
    return simplified || title;
}

async function resolveAll(items) {
    const resolved = [];
    for (const item of items) {
        const result = await resolveImdbId(item.faId, item.title, item.year, item.type);
        if (result) {
            resolved.push({ ...item, imdbId: result.id, type: result.type });
        }
    }
    return resolved;
}

module.exports = { resolveImdbId, resolveAll };
