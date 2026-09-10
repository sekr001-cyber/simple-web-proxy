const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));


// =====================================================
// URL HELPERS
// =====================================================

function proxyUrl(url) {
    return "/proxy?url=" + encodeURIComponent(url);
}

function makeAbsolute(value, baseUrl) {
    if (!value) return null;

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
        const absolute = new URL(trimmed, baseUrl);

        if (
            absolute.protocol !== "http:" &&
            absolute.protocol !== "https:"
        ) {
            return null;
        }

        return absolute.href;
    } catch {
        return null;
    }
}


// =====================================================
// COOKIE STORAGE
// =====================================================

// Temporary in-memory cookie storage.
// This is intentionally simple for V7.
// A restart of the Render service clears these cookies.

const cookieJar = new Map();

function getSessionId(req) {
    const existing = req.headers["x-proxy-session"];

    if (existing) {
        return existing;
    }

    return null;
}

function getCookies(sessionId, hostname) {
    if (!sessionId) return "";

    const session = cookieJar.get(sessionId);

    if (!session) return "";

    const cookies = session[hostname];

    if (!cookies) return "";

    return Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}

function storeCookies(sessionId, hostname, setCookieHeaders) {
    if (!sessionId || !setCookieHeaders) return;

    if (!cookieJar.has(sessionId)) {
        cookieJar.set(sessionId, {});
    }

    const session = cookieJar.get(sessionId);

    if (!session[hostname]) {
        session[hostname] = {};
    }

    for (const header of setCookieHeaders) {
        const firstPart = header.split(";")[0];

        const separator = firstPart.indexOf("=");

        if (separator === -1) {
            continue;
        }

        const name =
            firstPart.substring(0, separator).trim();

        const value =
            firstPart.substring(separator + 1).trim();

        if (name) {
            session[hostname][name] = value;
        }
    }
}


// =====================================================
// TEST
// =====================================================

app.get("/test", (req, res) => {
    res.send("V7 SERVER IS RUNNING");
});


// =====================================================
// API
// =====================================================

app.get("/api", async (req, res) => {

    const target = req.query.url;

    if (!target) {
        return res.status(400).json({
            error: "Missing URL"
        });
    }

    let targetUrl;

    try {
        targetUrl = new URL(target);
    } catch {
        return res.status(400).json({
            error: "Invalid URL"
        });
    }

    if (
        targetUrl.protocol !== "http:" &&
        targetUrl.protocol !== "https:"
    ) {
        return res.status(400).json({
            error:
                "Only HTTP and HTTPS are supported"
        });
    }

    try {

        const sessionId =
            getSessionId(req);

        const headers = {
            "User-Agent": "Mozilla/5.0",
            "Accept":
                "application/json,text/plain,*/*"
        };

        const cookies =
            getCookies(
                sessionId,
                targetUrl.hostname
            );

        if (cookies) {
            headers["Cookie"] = cookies;
        }

        const response = await fetch(
            targetUrl.href,
            {
                redirect: "follow",
                headers
            }
        );

        console.log(
            "API request:",
            targetUrl.href
        );

        console.log(
            "API final URL:",
            response.url
        );

        console.log(
            "API status:",
            response.status
        );

        // Store cookies returned by the target.
        const setCookies =
            typeof response.headers.getSetCookie === "function"
                ? response.headers.getSetCookie()
                : [];

        storeCookies(
            sessionId,
            targetUrl.hostname,
            setCookies
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
            "API error:",
            error
        );

        return res.status(500).json({
            error:
                "API request failed"
        });
    }
});


// =====================================================
// MAIN PROXY
// =====================================================

app.get("/proxy", async (req, res) => {

    const target = req.query.url;

    if (!target) {
        return res.status(400).send(
            "Missing URL"
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

    try {

        const sessionId =
            getSessionId(req);

        const headers = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",

            "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
        };

        const cookies =
            getCookies(
                sessionId,
                targetUrl.hostname
            );

        if (cookies) {
            headers["Cookie"] = cookies;
        }

        console.log(
            "Proxy request:",
            targetUrl.href
        );

        const response =
            await fetch(
                targetUrl.href,
                {
                    redirect: "follow",
                    headers
                }
            );

        const finalUrl =
            new URL(response.url);

        console.log(
            "Final URL:",
            finalUrl.href
        );

        console.log(
            "Upstream status:",
            response.status
        );

        // Save cookies from the target.
        const setCookies =
            typeof response.headers.getSetCookie === "function"
                ? response.headers.getSetCookie()
                : [];

        storeCookies(
            sessionId,
            finalUrl.hostname,
            setCookies
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


        // =================================================
        // HTML
        // =================================================

        if (
            contentType.includes(
                "text/html"
            )
        ) {

            const html =
                await response.text();

            const $ =
                cheerio.load(html);

            $("base").remove();


            // Links

            $("a[href]").each(
                (_, element) => {

                    const href =
                        $(element)
                            .attr("href");

                    const absolute =
                        makeAbsolute(
                            href,
                            finalUrl.href
                        );

                    if (absolute) {
                        $(element).attr(
                            "href",
                            proxyUrl(absolute)
                        );
                    }
                }
            );


            // Images

            $("img[src]").each(
                (_, element) => {

                    const src =
                        $(element)
                            .attr("src");

                    const absolute =
                        makeAbsolute(
                            src,
                            finalUrl.href
                        );

                    if (absolute) {
                        $(element).attr(
                            "src",
                            proxyUrl(absolute)
                        );
                    }
                }
            );


            // Scripts

            $("script[src]").each(
                (_, element) => {

                    const src =
                        $(element)
                            .attr("src");

                    const absolute =
                        makeAbsolute(
                            src,
                            finalUrl.href
                        );

                    if (absolute) {
                        $(element).attr(
                            "src",
                            proxyUrl(absolute)
                        );
                    }
                }
            );


            // Stylesheets

            $("link[href]").each(
                (_, element) => {

                    const href =
                        $(element)
                            .attr("href");

                    const absolute =
                        makeAbsolute(
                            href,
                            finalUrl.href
                        );

                    if (absolute) {
                        $(element).attr(
                            "href",
                            proxyUrl(absolute)
                        );
                    }
                }
            );


            // Forms

            $("form[action]").each(
                (_, element) => {

                    const action =
                        $(element)
                            .attr("action");

                    const absolute =
                        makeAbsolute(
                            action,
                            finalUrl.href
                        );

                    if (absolute) {
                        $(element).attr(
                            "action",
                            proxyUrl(absolute)
                        );
                    }
                }
            );


            // Media

            $(
                "video[src]," +
                "audio[src]," +
                "source[src]"
            ).each(
                (_, element) => {

                    const src =
                        $(element)
                            .attr("src");

                    const absolute =
                        makeAbsolute(
                            src,
                            finalUrl.href
                        );

                    if (absolute) {
                        $(element).attr(
                            "src",
                            proxyUrl(absolute)
                        );
                    }
                }
            );


            // Inline CSS

            $("[style]").each(
                (_, element) => {

                    let style =
                        $(element)
                            .attr("style");

                    if (!style) return;

                    style =
                        style.replace(
                            /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
                            (
                                match,
                                quote,
                                resource
                            ) => {

                                const absolute =
                                    makeAbsolute(
                                        resource,
                                        finalUrl.href
                                    );

                                if (!absolute) {
                                    return match;
                                }

                                return `url("${proxyUrl(
                                    absolute
                                )}")`;
                            }
                        );

                    $(element).attr(
                        "style",
                        style
                    );
                }
            );


            res.setHeader(
                "Content-Type",
                "text/html; charset=utf-8"
            );

            return res.send(
                $.html()
            );
        }


        // =================================================
        // OTHER RESOURCES
        // =================================================

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

        return res.send(buffer);

    } catch (error) {

        console.error(
            "Proxy error:",
            error
        );

        return res.status(500).send(
            "Failed to retrieve website"
        );
    }
});


// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {
    console.log(
        `V7 server running on port ${PORT}`
    );
});
