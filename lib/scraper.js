const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HTTP_CLIENT = axios.create({
    headers: { 'User-Agent': USER_AGENT },
    timeout: 15000,
});

async function scrapeList(userId, listId) {
    const baseUrl = `https://www.filmaffinity.com/es/userlist.php?user_id=${userId}&list_id=${listId}`;
    console.log(`[Scraper] Fetching list: userId=${userId}, listId=${listId}`);

    let allItems = [];
    let listName = '';
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const url = page === 1 ? baseUrl : `${baseUrl}&p=${page}`;
        let html;
        try {
            const res = await HTTP_CLIENT.get(url);
            html = res.data;
        } catch (err) {
            console.error(`[Scraper] HTTP error for userId=${userId}, listId=${listId}, page=${page}: ${err.message}`);
            if (page === 1) throw err;
            break;
        }

        const $ = cheerio.load(html);

        if (page === 1) {
            listName = extractListName($);
        }

        const items = extractItems($);
        if (items.length === 0) {
            if (page === 1) {
                console.warn(`[Scraper] No items found on first page for userId=${userId}, listId=${listId}`);
            }
            hasMore = false;
        } else {
            allItems = allItems.concat(items);
            // Check for next page link
            const nextLink = $('a.pag-next, a[rel="next"], .pagination .next a, a:contains("Siguiente")').length > 0;
            if (nextLink) {
                page++;
            } else {
                hasMore = false;
            }
        }
    }

    // Re-number positions sequentially across pages
    allItems.forEach((item, i) => { item.position = i + 1; });

    console.log(`[Scraper] List "${listName}": found ${allItems.length} items (userId=${userId}, listId=${listId})`);
    return { listName, items: allItems };
}

function extractListName($) {
    const title = $('title').text().trim();
    const match = title.match(/Lista de .+? - (.+?) - Filmaffinity/i);
    if (match) return match[1].trim();

    const h1 = $('h1').first().text().trim();
    if (h1) return h1;

    return 'Lista Filmaffinity';
}

function extractItems($) {
    const items = [];

    // Each movie is in a <li data-movie-id="XXXXX"> or <div class="movie-card" data-movie-id="XXXXX">
    $('li[data-movie-id]').each((_, li) => {
        const $li = $(li);
        const faId = $li.attr('data-movie-id');
        if (!faId) return;

        const $card = $li.find('.movie-card').first();
        const $titleEl = $li.find('.mc-title a').first();
        const title = cleanTitle($titleEl.text().trim());
        if (!title) return;

        const yearText = $li.find('.mc-year').first().text().trim();
        const year = yearText ? parseInt(yearText) : null;

        const ratingText = $li.find('.avg').first().text().trim();
        const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

        const posText = $li.find('.fa-list-position').first().text().trim();
        const position = posText ? parseInt(posText) : items.length + 1;

        // Detect series: check for "(Serie de TV)" or "(TV Series)" in the full text around the title
        const fullText = $li.text();
        const isSeries = detectSeries(fullText);

        // Extract poster from data-srcset
        let poster = null;
        const $img = $li.find('.mc-poster img').first();
        const srcset = $img.attr('data-srcset') || '';
        if (srcset) {
            // Get the largest image (last in srcset)
            const parts = srcset.split(',').map(s => s.trim());
            const lastPart = parts[parts.length - 1];
            if (lastPart) {
                poster = lastPart.split(/\s+/)[0];
            }
        }

        items.push({ faId, title, year, type: isSeries ? 'series' : 'movie', rating, poster, position });
    });

    // Fallback: try movie-card divs directly if no li[data-movie-id] found
    if (items.length === 0) {
        $('.movie-card[data-movie-id]').each((_, card) => {
            const $card = $(card);
            const faId = $card.attr('data-movie-id');
            if (!faId) return;

            const $titleEl = $card.find('.mc-title a').first();
            const title = cleanTitle($titleEl.text().trim());
            if (!title) return;

            const yearText = $card.find('.mc-year').first().text().trim();
            const year = yearText ? parseInt(yearText) : null;

            const ratingText = $card.find('.avg').first().text().trim();
            const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

            const fullText = $card.text();
            const isSeries = detectSeries(fullText);

            let poster = null;
            const srcset = $card.find('.mc-poster img').attr('data-srcset') || '';
            if (srcset) {
                const parts = srcset.split(',').map(s => s.trim());
                const lastPart = parts[parts.length - 1];
                if (lastPart) poster = lastPart.split(/\s+/)[0];
            }

            items.push({ faId, title, year, type: isSeries ? 'series' : 'movie', rating, poster, position: items.length + 1 });
        });
    }

    return items;
}

function cleanTitle(title) {
    return title.replace(/\s*\(Serie de TV\)\s*/g, '')
                .replace(/\s*\(TV Series\)\s*/g, '')
                .replace(/\s*\(Miniserie de TV\)\s*/g, '')
                .replace(/\s*\(TV\)\s*/g, '')
                .replace(/\s*\(C\)\s*/g, '')
                .trim();
}

function detectSeries(text) {
    return /\(Serie de TV\)|\(TV Series\)|\(Miniserie de TV\)|Serie TV/i.test(text);
}

module.exports = { scrapeList };
