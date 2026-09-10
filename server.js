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
        return res.status(400).send("Only HTTP and HTTPS are supported");
    }

    console.log("Proxy request:", targetUrl.href);

    try {
        const response = await fetch(targetUrl.href, {
            redirect: "follow",
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept": "text/html,application/xhtml+xml"
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

        if (!contentType.includes("text/html")) {
            return res
                .status(415)
                .send("This version only supports HTML pages");
        }

        const html = await response.text();

        const $ = cheerio.load(html);

        /*
         * Rewrite normal links
         */
        $("a[href]").each((_, element) => {
            const href = $(element).attr("href");

            if (!href) {
                return;
            }

            if (
                href.startsWith("#") ||
                href.startsWith("javascript:") ||
                href.startsWith("mailto:")
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
                        encodeURIComponent(absoluteUrl.href)
                    );
                }
            } catch {
                // Ignore invalid URLs
            }
        });

        /*
         * Rewrite images
         */
        $("img[src]").each((_, element) => {
            const src = $(element).attr("src");

            if (!src) {
                return;
            }

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
                        encodeURIComponent(absoluteUrl.href)
                    );
                }
            } catch {
                // Ignore invalid URLs
            }
        });

        /*
         * Rewrite stylesheets
         */
        $('link[rel="stylesheet"][href]').each((_, element) => {
            const href = $(element).attr("href");

            if (!href) {
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
                        encodeURIComponent(absoluteUrl.href)
                    );
                }
            } catch {
                // Ignore invalid URLs
            }
        });

        res.status(200);

        res.setHeader(
            "Content-Type",
            "text/html; charset=utf-8"
        );

        res.send($.html());

    } catch (error) {
        console.error("Proxy error:", error);

        res.status(500).send(
            "Failed to retrieve the website"
        );
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

