/**
 * TingShu 本地代理服务器
 * 
 * 用途: 解决播放页需要 PHPSESSID 会话 cookie 的问题
 * 零依赖，仅使用 Node.js 内置模块
 * 
 * 启动: node proxy.js
 * 端口: 9275
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 9275;

// 简单的 cookie jar - 按域名存储 cookies
const cookieJar = new Map();

function getCookiesForDomain(domain) {
    return cookieJar.get(domain) || {};
}

function setCookiesFromHeaders(domain, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const cookies = getCookiesForDomain(domain);
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const header of headers) {
        const parts = header.split(';')[0].split('=');
        if (parts.length >= 2) {
            const name = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            cookies[name] = value;
        }
    }
    cookieJar.set(domain, cookies);
}

function buildCookieString(domain) {
    const cookies = getCookiesForDomain(domain);
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function fetchUrl(targetUrl, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

        const parsed = new URL(targetUrl);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const domain = parsed.hostname;
        const cookieStr = buildCookieString(domain);

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': `https://${domain}/`,
                ...(cookieStr ? { 'Cookie': cookieStr } : {}),
            },
        };

        const req = lib.request(options, (res) => {
            // 存储 Set-Cookie
            setCookiesFromHeaders(domain, res.headers['set-cookie']);

            // 处理重定向
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith('/')) {
                    redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
                }
                res.resume(); // 消费响应体
                return fetchUrl(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.end();
    });
}

// 预热: 先访问书籍页获取 session cookie
async function warmupSession(bookUrl) {
    try {
        const domain = new URL(bookUrl).hostname;
        const cookies = getCookiesForDomain(domain);
        if (cookies.PHPSESSID) {
            console.log(`[Session] 已有 session for ${domain}: ${cookies.PHPSESSID.substring(0, 8)}...`);
            return true;
        }
        console.log(`[Session] 预热中: ${bookUrl}`);
        const resp = await fetchUrl(bookUrl);
        const newCookies = getCookiesForDomain(domain);
        if (newCookies.PHPSESSID) {
            console.log(`[Session] ✓ 获取到 session: ${newCookies.PHPSESSID.substring(0, 8)}...`);
            return true;
        }
        console.log('[Session] ⚠ 未获取到 PHPSESSID');
        return false;
    } catch (e) {
        console.log(`[Session] 预热失败: ${e.message}`);
        return false;
    }
}

const server = http.createServer(async (req, res) => {
    // CORS 响应头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const parsed = new URL(req.url, `http://localhost:${PORT}`);

    // 健康检查
    if (parsed.pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, cookies: Object.fromEntries(cookieJar) }));
    }

    // 预热 session
    if (parsed.pathname === '/warmup') {
        const bookUrl = parsed.searchParams.get('url');
        if (!bookUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing url parameter' }));
        }
        const ok = await warmupSession(bookUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok, cookies: Object.fromEntries(cookieJar) }));
    }

    // 代理请求
    if (parsed.pathname === '/proxy') {
        const targetUrl = parsed.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing url parameter');
        }

        try {
            const t0 = Date.now();
            const resp = await fetchUrl(targetUrl);
            const elapsed = Date.now() - t0;

            // 透传 Content-Type
            const ct = resp.headers['content-type'] || 'text/html; charset=utf-8';
            res.writeHead(resp.status, { 'Content-Type': ct });
            res.end(resp.body);

            const domain = new URL(targetUrl).hostname;
            console.log(`[Proxy] ${resp.status} ${targetUrl.substring(0, 80)}... (${elapsed}ms) [cookies: ${Object.keys(getCookiesForDomain(domain)).join(',')}]`);
        } catch (e) {
            console.error(`[Proxy] ERROR: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Proxy error: ${e.message}`);
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Use /proxy?url=<target> or /warmup?url=<bookUrl> or /ping');
});

server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log(`║  TingShu 代理已启动: http://localhost:${PORT}  ║`);
    console.log('║  按 Ctrl+C 停止                          ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('接口说明:');
    console.log(`  GET /proxy?url=<url>    代理请求 (自动携带cookie)`);
    console.log(`  GET /warmup?url=<url>   预热: 先访问书籍页获取session`);
    console.log(`  GET /ping               健康检查`);
    console.log('');
});
