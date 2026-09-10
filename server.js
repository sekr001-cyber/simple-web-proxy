const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));


// =====================================================
// TEST
// =====================================================

app.get("/test", (req, res) => {
    res.send("V5 SERVER IS RUNNING");
});


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
            error: "Only HTTP and HTTPS are supported"
        });
    }

    console.log("API request:", targetUrl.href);

    try {

        const response = await fetch(
            targetUrl.href,
            {
                redirect: "follow",
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    "Accept":
                        "application/json,text/plain,*/*"
                }
            }
        );

        console.log(
            "API status:",
            response.status
        );

        const body = await response.text();

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
            error: "API request failed"
        });
    }
});


// =====================================================
// MAIN PROXY
// =====================================================

function proxyUrl(url) {
    return "/proxy?url=" +
        encodeURIComponent(url);
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

    console.log(
        "Proxy request:",
        targetUrl.href
    );

    try {

        const response = await fetch(
            targetUrl.href,
            {
                redirect: "follow",
                headers: {
                    "User-Agent":
                        "Mozilla/5.0"
                }
            }
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
                            targetUrl.href
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


            // Images

            $("img[src]").each(
                (_, element) => {

                    const src =
                        $(element)
                            .attr("src");

                    const absolute =
                        makeAbsolute(
                            src,
                            targetUrl.href
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


            // Scripts

            $("script[src]").each(
                (_, element) => {

                    const src =
                        $(element)
                            .attr("src");

                    const absolute =
                        makeAbsolute(
                            src,
                            targetUrl.href
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


            // CSS

            $("link[href]").each(
                (_, element) => {

                    const href =
                        $(element)
                            .attr("href");

                    const absolute =
                        makeAbsolute(
                            href,
                            targetUrl.href
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


            // Forms

            $("form[action]").each(
                (_, element) => {

                    const action =
                        $(element)
                            .attr("action");

                    const absolute =
                        makeAbsolute(
                            action,
                            targetUrl.href
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


            res.setHeader(
                "Content-Type",
                "text/html; charset=utf-8"
            );

            return res.send(
                $.html()
            );
        }


        // =================================================
        // EVERYTHING ELSE
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
        `V5 server running on port ${PORT}`
    );

});
