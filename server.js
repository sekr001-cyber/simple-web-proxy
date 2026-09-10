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

        const absolute =
            new URL(
                trimmed,
                baseUrl
            );

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
// API PROXY
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

    console.log(
        "API request:",
        targetUrl.href
    );

    try {

        const response = await fetch(
            targetUrl.href,
            {
                redirect: "follow",

                headers: {
                    "User-Agent":
                        "Mozilla/5.0",

                    "Accept":
                        "application/json,text/plain,*/*"
                }
            }
        );

        console.log(
            "API status:",
            response.status
        );

        /*
         * The final URL after redirects.
         */

        console.log(
            "API final URL:",
            response.url
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
// MAIN WEB PROXY
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

        targetUrl =
            new URL(target);

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

    console.log(
        "Proxy request:",
        targetUrl.href
    );

    try {

        const response =
            await fetch(
                targetUrl.href,
                {
                    redirect: "follow",

                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",

                        "Accept":
                            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
                    }
                }
            );


        /*
         * IMPORTANT:
         *
         * response.url contains the final URL
         * after redirects.
         */

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


            /*
             * Remove base tags.
             */

            $("base").remove();


            // =================================================
            // LINKS
            // =================================================

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
                            proxyUrl(
                                absolute
                            )
                        );
                    }
                }
            );


            // =================================================
            // IMAGES
            // =================================================

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
                            proxyUrl(
                                absolute
                            )
                        );
                    }
                }
            );


            // =================================================
            // IMAGE SRCSET
            // =================================================

            $("img[srcset]").each(
                (_, element) => {

                    const srcset =
                        $(element)
                            .attr("srcset");

                    if (!srcset) {
                        return;
                    }

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
                                        finalUrl.href
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


            // =================================================
            // JAVASCRIPT
            // =================================================

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
                            proxyUrl(
                                absolute
                            )
                        );
                    }
                }
            );


            // =================================================
            // CSS / OTHER LINK RESOURCES
            // =================================================

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
                            proxyUrl(
                                absolute
                            )
                        );
                    }
                }
            );


            // =================================================
            // FORMS
            // =================================================

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
                            proxyUrl(
                                absolute
                            )
                        );
                    }
                }
            );


            // =================================================
            // VIDEO / AUDIO / SOURCE
            // =================================================

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
                            proxyUrl(
                                absolute
                            )
                        );
                    }
                }
            );


            // =================================================
            // INLINE CSS
            // =================================================

            $("[style]").each(
                (_, element) => {

                    let style =
                        $(element)
                            .attr("style");

                    if (!style) {
                        return;
                    }

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


            // =================================================
            // SEND HTML
            // =================================================

            res.setHeader(
                "Content-Type",
                "text/html; charset=utf-8"
            );

            return res.send(
                $.html()
            );
        }


        // =================================================
        // NON-HTML RESOURCES
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


        return res.send(
            buffer
        );

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
        `V6 server running on port ${PORT}`
    );

});
