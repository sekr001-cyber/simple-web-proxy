const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/proxy", async (req, res) => {
    const target = req.query.url;

    if (!target) {
        return res.status(400).send("Missing URL");
    }

    let targetUrl;

    try {
        targetUrl = new URL(target);
    } catch {
        return res.status(400).send("Invalid URL");
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
        return res.status(400).send(
            "Only HTTP and HTTPS are supported"
        );
    }

    console.log("Proxy request:", targetUrl.href);

    try {
        const response = await fetch(targetUrl.href, {
            redirect: "follow",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",

                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
            }
        });

        console.log("Upstream status:", response.status);

        if (!response.ok) {
            return res
                .status(response.status)
                .send(`Target returned HTTP ${response.status}`);
        }

        const contentType =
            response.headers.get("content-type") || "";

        /*
         * HTML
         */
        if (contentType.includes("text/html")) {

            const html = await response.text();
            const $ = cheerio.load(html);

            /*
             * Links
             */
            $("a[href]").each((_, element) => {

                const href = $(element).attr("href");

                if (!href) return;

                if (
                    href.startsWith("#") ||
                    href.startsWith("javascript:") ||
                    href.startsWith("mailto:") ||
                    href.startsWith("tel:")
                ) {
                    return;
                }

                try {

                    const absoluteUrl =
                        new URL(href, targetUrl.href);

                    if (
                        absoluteUrl.protocol === "http:" ||
                        absoluteUrl.protocol === "https:"
                    ) {

                        $(element).attr(
                            "href",
                            "/proxy?url=" +
                            encodeURIComponent(
                                absoluteUrl.href
                            )
                        );
                    }

                } catch {
                    // Ignore invalid URLs
                }
            });

            /*
             * Images
             */
            $("img[src]").each((_, element) => {

                const src = $(element).attr("src");

                if (!src) return;

                try {

                    const absoluteUrl =
                        new URL(src, targetUrl.href);

                    if (
                        absoluteUrl.protocol === "http:" ||
                        absoluteUrl.protocol === "https:"
                    ) {

                        $(element).attr(
                            "src",
                            "/proxy?url=" +
                            encodeURIComponent(
                                absoluteUrl.href
                            )
                        );
                    }

                } catch {
                    // Ignore invalid URLs
                }
            });

            /*
             * Scripts
             */
            $("script[src]").each((_, element) => {

                const src = $(element).attr("src");

                if (!src) return;

                try {

                    const absoluteUrl =
                        new URL(src, targetUrl.href);

                    if (
                        absoluteUrl.protocol === "http:" ||
                        absoluteUrl.protocol === "https:"
                    ) {

                        $(element).attr(
                            "src",
                            "/proxy?url=" +
                            encodeURIComponent(
                                absoluteUrl.href
                            )
                        );
                    }

                } catch {
                    // Ignore invalid URLs
                }
            });

            /*
             * Stylesheets
             */
            $("link[href]").each((_, element) => {

                const href = $(element).attr("href");

                if (!href) return;

                try {

                    const absoluteUrl =
                        new URL(href, targetUrl.href);

                    if (
                        absoluteUrl.protocol === "http:" ||
                        absoluteUrl.protocol === "https:"
                    ) {

                        $(element).attr(
                            "href",
                            "/proxy?url=" +
                            encodeURIComponent(
                                absoluteUrl.href
                            )
                        );
                    }

                } catch {
                    // Ignore invalid URLs
                }
            });

            /*
             * Forms
             */
            $("form[action]").each((_, element) => {

                const action = $(element).attr("action");

                if (!action) return;

                try {

                    const absoluteUrl =
                        new URL(action, targetUrl.href);

                    if (
                        absoluteUrl.protocol === "http:" ||
                        absoluteUrl.protocol === "https:"
                    ) {

                        $(element).attr(
                            "action",
                            "/proxy?url=" +
                            encodeURIComponent(
                                absoluteUrl.href
                            )
                        );
                    }

                } catch {
                    // Ignore invalid URLs
                }
            });

            res.setHeader(
                "Content-Type",
                "text/html; charset=utf-8"
            );

            return res.send($.html());
        }

        /*
         * Everything that isn't HTML
         *
         * Images, CSS, JavaScript, fonts,
         * JSON and other resources are
         * passed through unchanged.
         */

        const buffer = Buffer.from(
            await response.arrayBuffer()
        );

        if (contentType) {
            res.setHeader(
                "Content-Type",
                contentType
            );
        }

        res.send(buffer);

    } catch (error) {

        console.error("Proxy error:", error);

        res.status(500).send(
            "Failed to retrieve the website"
        );
    }
});

app.listen(PORT, () => {
    console.log(
        `Server running on port ${PORT}`
    );
});

