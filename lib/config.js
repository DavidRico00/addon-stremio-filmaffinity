function encodeConfig(config) {
    return Buffer.from(JSON.stringify(config)).toString('base64url');
}

function decodeConfig(encoded) {
    try {
        // Support both base64 and base64url
        const json = Buffer.from(encoded, 'base64url').toString('utf8');
        return JSON.parse(json);
    } catch (e) {
        try {
            const json = Buffer.from(encoded, 'base64').toString('utf8');
            return JSON.parse(json);
        } catch (e2) {
            return null;
        }
    }
}

function parseConfigFromUrl(urlOrConfig) {
    // Config format: { lists: [{ userId, listId, alias? }] }
    if (typeof urlOrConfig === 'string') {
        return decodeConfig(urlOrConfig);
    }
    return urlOrConfig;
}

function extractUserIdFromUrl(url) {
    const match = url.match(/user_id=(\d+)/);
    return match ? match[1] : null;
}

function extractListIdFromUrl(url) {
    const match = url.match(/list_id=(\d+)/);
    return match ? match[1] : null;
}

module.exports = { encodeConfig, decodeConfig, parseConfigFromUrl, extractUserIdFromUrl, extractListIdFromUrl };
