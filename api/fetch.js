/**
 * Vercel Serverless Proxy for TingShu
 * 
 * 无状态设计：客户端负责存储 session，每次请求时传入
 * 
 * 用法：
 *   GET /api/fetch?url=<target_url>&session=<PHPSESSID>
 * 
 * 响应头：
 *   X-Session: <当前PHPSESSID>  — 客户端应存储此值供后续请求使用
 */

export const config = {
    maxDuration: 15,
};

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function extractCookies(resp) {
    const cookies = {};
    const raw = resp.headers.getSetCookie?.() || [];
    for (const h of raw) {
        const parts = h.split(';')[0].split('=');
        if (parts.length >= 2) {
            cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
        }
    }
    return cookies;
}

function buildCookieStr(session) {
    return session ? `PHPSESSID=${session}` : '';
}

// 从 play URL 提取 book URL: /play/63/xxx.html → /book/63.html
function playUrlToBookUrl(playUrl) {
    try {
        const u = new URL(playUrl);
        const m = u.pathname.match(/\/play\/(\d+)\//);
        if (m) {
            return `${u.protocol}//${u.hostname}/book/${m[1]}.html`;
        }
    } catch {}
    return null;
}

async function doFetch(url, session, maxRedirects = 5) {
    if (maxRedirects <= 0) throw new Error('Too many redirects');

    const headers = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': new URL(url).origin + '/',
    };
    const cookieStr = buildCookieStr(session);
    if (cookieStr) headers['Cookie'] = cookieStr;

    const resp = await fetch(url, {
        headers,
        redirect: 'manual',
    });

    // 提取 Set-Cookie
    const cookies = extractCookies(resp);
    const newSession = cookies.PHPSESSID || session;

    // 处理重定向
    if ([301, 302, 303, 307, 308].includes(resp.status) && resp.headers.get('location')) {
        let loc = resp.headers.get('location');
        if (loc.startsWith('/')) {
            const u = new URL(url);
            loc = `${u.protocol}//${u.host}${loc}`;
        }
        return doFetch(loc, newSession, maxRedirects - 1);
    }

    const body = await resp.text();
    return { body, session: newSession, status: resp.status };
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Session');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    const { url, session } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const isPlayPage = url.includes('/play/');
        let currentSession = session || '';

        // 如果是播放页且没有 session → 自动预热
        if (isPlayPage && !currentSession) {
            const bookUrl = playUrlToBookUrl(url);
            if (bookUrl) {
                console.log(`[Warmup] Auto-warming: ${bookUrl}`);
                const warmup = await doFetch(bookUrl, '');
                currentSession = warmup.session || '';
                console.log(`[Warmup] Got session: ${currentSession ? currentSession.substring(0, 8) + '...' : 'none'}`);
            }
        }

        // 获取目标页面
        const result = await doFetch(url, currentSession);

        // 检查播放页是否被重定向到首页
        if (isPlayPage && (result.body.includes('最近上架') || result.body.includes('热门搜索'))) {
            // session 无效，重新预热
            console.log('[Retry] Play page redirected to home, re-warming...');
            const bookUrl = playUrlToBookUrl(url);
            if (bookUrl) {
                const warmup = await doFetch(bookUrl, '');
                currentSession = warmup.session || '';
                if (currentSession) {
                    const retry = await doFetch(url, currentSession);
                    res.setHeader('X-Session', currentSession);
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    return res.status(200).send(retry.body);
                }
            }
        }

        res.setHeader('X-Session', result.session || '');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(result.body);

    } catch (e) {
        console.error(`[Error] ${e.message}`);
        return res.status(500).json({ error: e.message });
    }
}
