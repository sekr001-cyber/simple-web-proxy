const express = require("express");
const cheerio = require("cheerio");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const app = express();

const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.use(express.static("public"));


// =====================================================
// CONFIG
// =====================================================

const REQUEST_TIMEOUT = 15000;
const MAX_URL_LENGTH = 4096;
const SESSION_COOKIE = "proxy_sid";


// =====================================================
// SESSION STORAGE
// =====================================================

const sessions = new Map();

function createSession() {

    const id =
        crypto.randomBytes(24).toString("hex");

    sessions.set(id, {
        createdAt: Date.now(),
        lastUsed: Date.now(),
        cookies: {}
    });

    return id;
}


function getOrCreateSession(req, res) {

    let sessionId =
        req.cookies?.[SESSION_COOKIE];

    if (
        !sessionId ||
        !sessions.has(sessionId)
    ) {
        sessionId = createSession();

        res.cookie(
            SESSION_COOKIE,
            sessionId,
            {
                httpOnly: true,
                sameSite: "lax",
                secure: process.env.NODE_ENV === "production",
                maxAge: 1000 * 60 * 60 * 24
            }
        );
    }

    const session =
        sessions.get(sessionId);

    session.lastUsed = Date.now();

    return {
        id: sessionId,
        data: session
    };
}


// =====================================================
// SESSION CLEANUP
// =====================================================

setInterval(() => {

    const now = Date.now();

    const MAX_AGE =
        1000 * 60 * 60 * 24;

    for (const [id, session] of sessions) {

        if (
            now - session.lastUsed >
            MAX_AGE
        ) {
            sessions.delete(id);
        }
    }

}, 1000 * 60 * 30);


// =====================================================
// COOKIE PARSER
// =====================================================

function parseCookieHeader(header) {

    const result = {};

    if (!header) {
        return result;
    }

    for (
        const part of header.split(";")
    ) {

        const index =
            part.indexOf("=");

        if (index === -1) continue;

        const name =
            part
                .substring(0, index)
                .trim();

        const value =
            part
                .substring(index + 1)
                .trim();

        if (name) {
            result[name] = value;
        }
    }

    return result;
}


function getTargetCookies(
    session,
    hostname
) {

    const cookies =
        session.cookies[hostname];

    if (!cookies) {
        return "";
    }

    return Object.entries(cookies)
        .map(
            ([name, value]) =>
                `${name}=${value}`
        )
        .join("; ");
}


function storeTargetCookies(
    session,
    hostname,
    headers
) {

    if (!headers || headers.length === 0) {
        return;
    }

    if (!session.cookies[hostname]) {
        session.cookies[hostname] = {};
    }

    for (const header of headers) {

        const first =
            header.split(";")[0];

        const index =
            first.indexOf("=");

        if (index === -1) {
            continue;
        }

        const name =
            first
                .substring(0, index)
                .trim();

        const value =
            first
                .substring(index + 1)
                .trim();

        if (!name) continue;

        session.cookies[hostname][name] =
            value;
    }
}


// =====================================================
// URL HELPERS
// =====================================================

function proxyUrl(url) {

    return (
        "/proxy?url=" +
        encodeURIComponent(url)
    );
}


function makeAbsolute(
    value,
    baseUrl
) {

    if (!value) {
        return null;
    }

    const trimmed =
        value.trim();

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

        const url =
            new URL(
                trimmed,
                baseUrl
            );

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
// PRIVATE NETWORK PROTECTION
// =====================================================

function isPrivateIPv4(ip) {

    const parts =
        ip.split(".").map(Number);

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

    const normalized =
        ip.toLowerCase();

    return (
        normalized === "::1" ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80:")
    );
}


async function isSafeTarget(url) {

    const hostname =
        url.hostname;

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

        const addresses =
            await dns.lookup(
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
// FETCH HELPER
// =====================================================

async function fetchTarget(
    targetUrl,
    session
) {

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () =>
                controller.abort(),
            REQUEST_TIMEOUT
        );

    const headers = {

        "User-Agent":
            "Mozilla/5.0",

        "Accept":
            "*/*"
    };

    const cookies =
        getTargetCookies(
            session,
            targetUrl.hostname
        );

    if (cookies) {
        headers.Cookie = cookies;
    }

    try {

        const response =
            await fetch(
                targetUrl.href,
                {
                    redirect: "follow",
                    headers,
                    signal:
                        controller.signal
                }
            );

        return response;

    } finally {

        clearTimeout(timeout);
    }
}


// =====================================================
// CSS REWRITER
// =====================================================

function rewriteCss(
    css,
    baseUrl
) {

    return css.replace(
        /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (
            match,
            quote,
            resource
        ) => {

            const absolute =
                makeAbsolute(
                    resource,
                    baseUrl
                );

            if (!absolute) {
                return match;
            }

            return (
                `url("${proxyUrl(
                    absolute
                )}")`
            );
        }
    );
}


// =====================================================
// HTML REWRITER
// =====================================================

function rewriteHtml(
    html,
    baseUrl
) {

    const $ =
        cheerio.load(html);

    $("base").remove();


    // -----------------------------------------------
    // Links
    // -----------------------------------------------

    $("a[href]").each(
        (_, element) => {

            const value =
                $(element)
                    .attr("href");

            const absolute =
                makeAbsolute(
                    value,
                    baseUrl
                );

            if (absolute) {

                $(element).attr(
                    "href",
                    proxyUrl(absolute)
                );
            }
        }
    );


    // -----------------------------------------------
    // Images
    // -----------------------------------------------

    $(
        "img[src], " +
        "video[src], " +
        "audio[src], " +
        "source[src]"
    ).each(
        (_, element) => {

            const value =
                $(element)
                    .attr("src");

            const absolute =
                makeAbsolute(
                    value,
                    baseUrl
                );

            if (absolute) {

                $(element).attr(
                    "src",
                    proxyUrl(absolute)
                );
            }
        }
    );


    // -----------------------------------------------
    // srcset
    // -----------------------------------------------

    $("[srcset]").each(
        (_, element) => {

            const srcset =
                $(element)
                    .attr("srcset");

            if (!srcset) return;

            const rewritten =
                srcset
                    .split(",")
                    .map(part => {

                        const pieces =
                            part
                                .trim()
                                .split(/\s+/);

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
                            proxyUrl(
                                absolute
                            ),
                            ...pieces
                        ].join(" ");
                    })
                    .join(", ");

            $(element).attr(
                "srcset",
                rewritten
            );
        }
    );


    // -----------------------------------------------
    // Scripts
    // -----------------------------------------------

    $("script[src]").each(
        (_, element) => {

            const value =
                $(element)
                    .attr("src");

            const absolute =
                makeAbsolute(
                    value,
                    baseUrl
                );

            if (absolute) {

                $(element).attr(
                    "src",
                    proxyUrl(absolute)
                );
            }
        }
    );


    // -----------------------------------------------
    // CSS
    // -----------------------------------------------

    $("link[href]").each(
        (_, element) => {

            const value =
                $(element)
                    .attr("href");

            const absolute =
                makeAbsolute(
                    value,
                    baseUrl
                );

            if (absolute) {

                $(element).attr(
                    "href",
                    proxyUrl(absolute)
                );
            }
        }
    );


    // -----------------------------------------------
    // Forms
    // -----------------------------------------------

    $("form[action]").each(
        (_, element) => {

            const value =
                $(element)
                    .attr("action");

            const absolute =
                makeAbsolute(
                    value,
                    baseUrl
                );

            if (absolute) {

                $(element).attr(
                    "action",
                    proxyUrl(absolute)
                );
            }
        }
    );


    // -----------------------------------------------
    // Inline CSS
    // -----------------------------------------------

    $("[style]").each(
        (_, element) => {

            const style =
                $(element)
                    .attr("style");

            if (!style) return;

            $(element).attr(
                "style",
                rewriteCss(
                    style,
                    baseUrl
                )
            );
        }
    );


    return $.html();
}


// =====================================================
// HEALTH
// =====================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            status: "ok",

            version: "V15",

            uptime:
                Math.round(
                    process.uptime()
                ),

            sessions:
                sessions.size,

            timestamp:
                new Date().toISOString()
        });
    }
);


// =====================================================
// TEST
// =====================================================

app.get(
    "/test",
    (req, res) => {

        res.send(
            "V15 SERVER IS RUNNING"
        );
    }
);


// =====================================================
// DEBUG
// =====================================================

app.get(
    "/debug",
    (req, res) => {

        res.json({

            version: "V15",

            node:
                process.version,

            uptime:
                Math.round(
                    process.uptime()
                ),

            sessions:
                sessions.size,

            memory:
                process.memoryUsage()
        });
    }
);


// =====================================================
// API
// =====================================================

app.get(
    "/api",
    async (req, res) => {

        const target =
            req.query.url;

        if (!target) {

            return res
                .status(400)
                .json({
                    error:
                        "Missing URL"
                });
        }

        if (
            target.length >
            MAX_URL_LENGTH
        ) {

            return res
                .status(414)
                .json({
                    error:
                        "URL too long"
                });
        }

        let targetUrl;

        try {

            targetUrl =
                new URL(target);

        } catch {

            return res
                .status(400)
                .json({
                    error:
                        "Invalid URL"
                });
        }

        if (
            targetUrl.protocol !==
                "http:" &&
            targetUrl.protocol !==
                "https:"
        ) {

            return res
                .status(400)
                .json({
                    error:
                        "Only HTTP and HTTPS are supported"
                });
        }

        if (
            !(await isSafeTarget(
                targetUrl
            ))
        ) {

            return res
                .status(403)
                .json({
                    error:
                        "Target address is not allowed"
                });
        }

        const {
            data: session
        } =
            getOrCreateSession(
                req,
                res
            );

        try {

            const response =
                await fetchTarget(
                    targetUrl,
                    session
                );

            const finalUrl =
                new URL(
                    response.url
                );

            const setCookies =
                typeof response.headers
                    .getSetCookie ===
                "function"
                    ? response.headers
                        .getSetCookie()
                    : [];

            storeTargetCookies(
                session,
                finalUrl.hostname,
                setCookies
            );

            console.log(
                `[API] ${response.status} ${finalUrl.href}`
            );

            const body =
                await response.text();

            const contentType =
                response.headers.get(
                    "content-type"
                );

            if (contentType) {

                res.setHeader(
                    "Content-Type",
                    contentType
                );
            }

            return res
                .status(response.status)
                .send(body);

        } catch (error) {

            console.error(
                "[API ERROR]",
                error
            );

            if (
                error.name ===
                "AbortError"
            ) {

                return res
                    .status(504)
                    .json({
                        error:
                            "Target request timed out"
                    });
            }

            return res
                .status(502)
                .json({
                    error:
                        "Could not reach target"
                });
        }
    }
);


// =====================================================
// PROXY
// =====================================================

app.get(
    "/proxy",
    async (req, res) => {

        const target =
            req.query.url;

        if (!target) {

            return res
                .status(400)
                .send(
                    "Missing URL"
                );
        }

        if (
            target.length >
            MAX_URL_LENGTH
        ) {

            return res
                .status(414)
                .send(
                    "URL too long"
                );
        }

        let targetUrl;

        try {

            targetUrl =
                new URL(target);

        } catch {

            return res
                .status(400)
                .send(
                    "Invalid URL"
                );
        }

        if (
            targetUrl.protocol !==
                "http:" &&
            targetUrl.protocol !==
                "https:"
        ) {

            return res
                .status(400)
                .send(
                    "Only HTTP and HTTPS are supported"
                );
        }

        if (
            !(await isSafeTarget(
                targetUrl
            ))
        ) {

            return res
                .status(403)
                .send(
                    "Target address is not allowed"
                );
        }

        const {
            data: session
        } =
            getOrCreateSession(
                req,
                res
            );

        try {

            const response =
                await fetchTarget(
                    targetUrl,
                    session
                );

            const finalUrl =
                new URL(
                    response.url
                );

            const setCookies =
                typeof response.headers
                    .getSetCookie ===
                "function"
                    ? response.headers
                        .getSetCookie()
                    : [];

            storeTargetCookies(
                session,
                finalUrl.hostname,
                setCookies
            );

            console.log(
                `[PROXY] ${response.status} ${finalUrl.href}`
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


            // -----------------------------------------
            // HTML
            // -----------------------------------------

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

                return res.send(
                    rewritten
                );
            }


            // -----------------------------------------
            // CSS
            // -----------------------------------------

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


            // -----------------------------------------
            // Everything else
            // -----------------------------------------

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
    }
);


// =====================================================
// 404
// =====================================================

app.use(
    (req, res) => {

        res.status(404).json({

            error:
                "Route not found",

            path:
                req.path
        });
    }
);


// =====================================================
// ERROR HANDLER
// =====================================================

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled error:",
            error
        );

        res.status(500).json({

            error:
                "Internal server error"
        });
    }
);


// =====================================================
// START
// =====================================================

app.listen(
    PORT,
    () => {

        console.log(
            `V15 server running on port ${PORT}`
        );

    }
);
