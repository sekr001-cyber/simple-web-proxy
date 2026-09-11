const express = require("express");
const cheerio = require("cheerio");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const app = express();

const PORT = process.env.PORT || 3000;

const REQUEST_TIMEOUT = 15000;
const MAX_URL_LENGTH = 4096;
const SESSION_COOKIE = "proxy_sid";

app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(express.static("public"));


// =====================================================
// SESSION STORAGE
// =====================================================

const sessions = new Map();

function createSession() {
    const id = crypto.randomBytes(24).toString("hex");

    sessions.set(id, {
        createdAt: Date.now(),
        lastUsed: Date.now(),
        cookies: {},
        history: [],
        bookmarks: []
    });

    return id;
}


// =====================================================
// COOKIES / SESSION
// =====================================================

function parseCookies(header) {
    const result = {};

    if (!header) {
        return result;
    }

    for (const part of header.split(";")) {
        const index = part.indexOf("=");

        if (index === -1) {
            continue;
        }

        const name = part.substring(0, index).trim();
        const value = part.substring(index + 1).trim();

        if (name) {
            result[name] = value;
        }
    }

    return result;
}


function getOrCreateSession(req, res) {
    const cookies = parseCookies(req.headers.cookie);

    let sessionId = cookies[SESSION_COOKIE];

    if (!sessionId || !sessions.has(sessionId)) {
        sessionId = createSession();

        res.setHeader(
            "Set-Cookie",
            `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`
        );
    }

    const session = sessions.get(sessionId);

    session.lastUsed = Date.now();

    return session;
}


// =====================================================
// SESSION CLEANUP
// =====================================================

setInterval(() => {
    const now = Date.now();
    const maxAge = 1000 * 60 * 60 * 24;

    for (const [id, session] of sessions) {
        if (now - session.lastUsed > maxAge) {
            sessions.delete(id);
        }
    }
}, 1000 * 60 * 30);


// =====================================================
// TARGET COOKIES
// =====================================================

function getTargetCookies(session, hostname) {
    const cookies = session.cookies[hostname];

    if (!cookies) {
        return "";
    }

    return Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}


function storeTargetCookies(session, hostname, setCookieHeaders) {
    if (!setCookieHeaders || !setCookieHeaders.length) {
        return;
    }

    if (!session.cookies[hostname]) {
        session.cookies[hostname] = {};
    }

    for (const header of setCookieHeaders) {
        const firstPart = header.split(";")[0];

        const index = firstPart.indexOf("=");

        if (index === -1) {
            continue;
        }

        const name = firstPart.substring(0, index).trim();
        const value = firstPart.substring(index + 1).trim();

        if (name) {
            session.cookies[hostname][name] = value;
        }
    }
}


// =====================================================
// HISTORY
// =====================================================

function addHistory(session, url, status) {
    session.history.unshift({
        url,
        status,
        time: new Date().toISOString()
    });

    session.history = session.history.slice(0, 50);
}


// =====================================================
// BOOKMARKS
// =====================================================

function addBookmark(session, url, title = url) {
    const exists = session.bookmarks.some(
        item => item.url === url
    );

    if (!exists) {
        session.bookmarks.unshift({
            url,
            title,
            time: new Date().toISOString()
        });
    }
}


// =====================================================
// URL HELPERS
// =====================================================

function proxyUrl(url) {
    return "/proxy?url=" + encodeURIComponent(url);
}


function makeAbsolute(value, baseUrl) {
    if (!value) {
        return null;
    }

    const trimmed = value.trim();

    if (
        trimmed.startsWith("#") ||
        trimmed.startsWith("data:") ||
        trimmed.startsWith("blob:") ||
        trimmed.startsWith("javascript:") ||
        trimmed.startsWith("mailto:") ||
        trimmed.startsWith("tel:")
    ) {
        return null;
    }

    try {
        const url = new URL(trimmed, baseUrl);

        if (
            url.protocol !== "http:" &&
            url.protocol !== "https:"
        ) {
            return null;
        }

        return url.href;

    } catch {
        return null;
    }
}


// =====================================================
// SSRF PROTECTION
// =====================================================

function isPrivateIPv4(ip) {
    const parts = ip.split(".").map(Number);

    if (parts.length !== 4) {
        return false;
    }

    const [a, b] = parts;

    return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
    );
}


function isPrivateIPv6(ip) {
    const normalized = ip.toLowerCase();

    return (
        normalized === "::1" ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80:")
    );
}


async function isSafeTarget(url) {
    const hostname = url.hostname.toLowerCase();

    if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost")
    ) {
        return false;
    }

    if (net.isIP(hostname)) {
        if (net.isIPv4(hostname)) {
            return !isPrivateIPv4(hostname);
        }

        if (net.isIPv6(hostname)) {
            return !isPrivateIPv6(hostname);
        }
    }

    try {
        const addresses = await dns.lookup(
            hostname,
            {
                all: true
            }
        );

        for (const address of addresses) {
            if (
                net.isIPv4(address.address) &&
                isPrivateIPv4(address.address)
            ) {
                return false;
            }

            if (
                net.isIPv6(address.address) &&
                isPrivateIPv6(address.address)
            ) {
                return false;
            }
        }

        return true;

    } catch {
        return false;
    }
}


// =====================================================
// FETCH
// =====================================================

async function fetchTarget(targetUrl, session) {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT
    );

    const headers = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

        "Accept-Language":
            "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7"
    };

    const cookies = getTargetCookies(
        session,
        targetUrl.hostname
    );

    if (cookies) {
        headers.Cookie = cookies;
    }

    try {
        return await fetch(
            targetUrl.href,
            {
                redirect: "follow",
                headers,
                signal: controller.signal
            }
        );

    } finally {
        clearTimeout(timeout);
    }
}


// =====================================================
// CSS REWRITE
// =====================================================

function rewriteCss(css, baseUrl) {
    return css.replace(
        /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (match, quote, resource) => {

            const absolute = makeAbsolute(
                resource,
                baseUrl
            );

            if (!absolute) {
                return match;
            }

            return `url("${proxyUrl(absolute)}")`;
        }
    );
}


// =====================================================
// HTML REWRITE
// =====================================================

function rewriteHtml(html, baseUrl) {
    const $ = cheerio.load(html);

    $("base").remove();


    $("a[href]").each((_, element) => {
        const value = $(element).attr("href");

        const absolute = makeAbsolute(
            value,
            baseUrl
        );

        if (absolute) {
            $(element).attr(
                "href",
                proxyUrl(absolute)
            );
        }
    });


    $(
        "img[src]," +
        "video[src]," +
        "audio[src]," +
        "source[src]"
    ).each((_, element) => {

        const value = $(element).attr("src");

        const absolute = makeAbsolute(
            value,
            baseUrl
        );

        if (absolute) {
            $(element).attr(
                "src",
                proxyUrl(absolute)
            );
        }
    });


    $("[srcset]").each((_, element) => {
        const srcset = $(element).attr("srcset");

        if (!srcset) {
            return;
        }

        const rewritten = srcset
            .split(",")
            .map(part => {

                const pieces =
                    part.trim().split(/\s+/);

                const resource =
                    pieces.shift();

                const absolute =
                    makeAbsolute(
                        resource,
                        baseUrl
                    );

                if (!absolute) {
                    return part;
                }

                return [
                    proxyUrl(absolute),
                    ...pieces
                ].join(" ");
            })
            .join(", ");

        $(element).attr(
            "srcset",
            rewritten
        );
    });


    $("script[src]").each((_, element) => {
        const value = $(element).attr("src");

        const absolute = makeAbsolute(
            value,
            baseUrl
        );

        if (absolute) {
            $(element).attr(
                "src",
                proxyUrl(absolute)
            );
        }
    });


    $("link[href]").each((_, element) => {
        const value = $(element).attr("href");

        const absolute = makeAbsolute(
            value,
            baseUrl
        );

        if (absolute) {
            $(element).attr(
                "href",
                proxyUrl(absolute)
            );
        }
    });


    $("form[action]").each((_, element) => {
        const value = $(element).attr("action");

        const absolute = makeAbsolute(
            value,
            baseUrl
        );

        if (absolute) {
            $(element).attr(
                "action",
                proxyUrl(absolute)
            );
        }
    });


    $("[style]").each((_, element) => {
        const style = $(element).attr("style");

        if (!style) {
            return;
        }

        $(element).attr(
            "style",
            rewriteCss(style, baseUrl)
        );
    });


    return $.html();
}


// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        version: "V18",
        uptime: Math.round(process.uptime()),
        sessions: sessions.size,
        timestamp: new Date().toISOString()
    });
});


app.get("/test", (req, res) => {
    res.send("V18 SERVER IS RUNNING");
});


app.get("/debug", (req, res) => {
    res.json({
        version: "V18",
        node: process.version,
        uptime: Math.round(process.uptime()),
        sessions: sessions.size,
        memory: process.memoryUsage()
    });
});


// =====================================================
// SESSION API
// =====================================================

app.get("/api/session", (req, res) => {
    const session = getOrCreateSession(
        req,
        res
    );

    res.json({
        history: session.history,
        bookmarks: session.bookmarks
    });
});


// =====================================================
// BOOKMARK API
// =====================================================

app.post("/api/bookmark", (req, res) => {
    const session = getOrCreateSession(
        req,
        res
    );

    const { url, title } = req.body;

    if (!url) {
        return res.status(400).json({
            error: "Missing URL"
        });
    }

    addBookmark(
        session,
        url,
        title || url
    );

    res.json({
        status: "ok",
        bookmarks: session.bookmarks
    });
});


// =====================================================
// SEARCH API
// =====================================================

app.get("/api/search", (req, res) => {
    const query =
        String(req.query.q || "").trim();

    if (!query) {
        return res.status(400).json({
            error: "Missing search query"
        });
    }

    const url =
        "https://www.google.com/search?q=" +
        encodeURIComponent(query);

    res.json({
        status: "ok",
        query,
        url
    });
});


// =====================================================
// PROXY INFO API
// =====================================================

app.get("/api/info", (req, res) => {
    res.json({
        name: "Simple Web Proxy",
        version: "V18",
        features: [
            "HTTP/HTTPS fetching",
            "HTML rewriting",
            "CSS rewriting",
            "Session cookies",
            "History",
            "Bookmarks",
            "SSRF protection",
            "Request timeout"
        ],
        limits: {
            maxUrlLength: MAX_URL_LENGTH,
            timeoutMs: REQUEST_TIMEOUT
        }
    });
});


// =====================================================
// PROXY
// =====================================================

app.get("/proxy", async (req, res) => {

    const target = req.query.url;

    if (!target) {
        return res.status(400).send(
            "Missing URL"
        );
    }

    if (
        typeof target !== "string" ||
        target.length > MAX_URL_LENGTH
    ) {
        return res.status(414).send(
            "URL too long"
        );
    }

    let targetUrl;

    try {
        targetUrl = new URL(target);

    } catch {
        return res.status(400).send(
            "Invalid URL"
        );
    }

    if (
        targetUrl.protocol !== "http:" &&
        targetUrl.protocol !== "https:"
    ) {
        return res.status(400).send(
            "Only HTTP and HTTPS are supported"
        );
    }

    if (
        !(await isSafeTarget(targetUrl))
    ) {
        return res.status(403).send(
            "Target address is not allowed"
        );
    }

    const session =
        getOrCreateSession(
            req,
            res
        );

    const startTime = Date.now();

    try {

        console.log(
            "Proxy request:",
            targetUrl.href
        );

        const response =
            await fetchTarget(
                targetUrl,
                session
            );

        const finalUrl =
            new URL(response.url);

        const setCookies =
            typeof response.headers.getSetCookie ===
            "function"
                ? response.headers.getSetCookie()
                : [];

        storeTargetCookies(
            session,
            finalUrl.hostname,
            setCookies
        );

        const responseTime =
            Date.now() - startTime;

        console.log(
            "Upstream status:",
            response.status
        );

        console.log(
            "Response time:",
            responseTime + "ms"
        );

        addHistory(
            session,
            finalUrl.href,
            response.status
        );


        if (!response.ok) {

            return res
                .status(response.status)
                .send(
                    `Target returned HTTP ${response.status}`
                );
        }


        const contentType =
            response.headers.get(
                "content-type"
            ) || "";


        if (
            contentType.includes(
                "text/html"
            )
        ) {

            const html =
                await response.text();

            const rewritten =
                rewriteHtml(
                    html,
                    finalUrl.href
                );

            res.setHeader(
                "Content-Type",
                "text/html; charset=utf-8"
            );

            res.setHeader(
                "X-Proxy-Version",
                "V18"
            );

            res.setHeader(
                "X-Proxy-Response-Time",
                `${responseTime}ms`
            );

            return res.send(
                rewritten
            );
        }


        if (
            contentType.includes(
                "text/css"
            )
        ) {

            const css =
                await response.text();

            const rewritten =
                rewriteCss(
                    css,
                    finalUrl.href
                );

            res.setHeader(
                "Content-Type",
                "text/css; charset=utf-8"
            );

            return res.send(
                rewritten
            );
        }


        const buffer =
            Buffer.from(
                await response.arrayBuffer()
            );

        if (contentType) {
            res.setHeader(
                "Content-Type",
                contentType
            );
        }

        res.setHeader(
            "X-Proxy-Version",
            "V18"
        );

        return res.send(
            buffer
        );

    } catch (error) {

        console.error(
            "[PROXY ERROR]",
            error
        );

        if (
            error.name ===
            "AbortError"
        ) {
            return res
                .status(504)
                .send(
                    "Target request timed out"
                );
        }

        return res
            .status(502)
            .send(
                "Failed to retrieve target"
            );
    }
});


// =====================================================
// 404
// =====================================================

app.use((req, res) => {
    res.status(404).json({
        error: "Route not found",
        path: req.path
    });
});


// =====================================================
// START
// =====================================================

app.listen(PORT, () => {
    console.log(
        `V18 server running on port ${PORT}`
    );
});
