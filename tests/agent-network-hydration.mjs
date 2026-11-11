import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "..");

test("actual agent scene preserves initial SSR geometry across engine math tails", async (t) => {
    const output = await mkdtemp(path.join(tmpdir(), "orbit-hydration-test-"));
    t.after(() => rm(output, { recursive: true, force: true }));
    await symlink(path.join(root, "node_modules"), path.join(output, "node_modules"), "dir");
    const entry = path.join(root, "tests/fixtures/agent-network-hydration.tsx");
    const config = {
        root,
        configFile: false,
        publicDir: false,
        logLevel: "error",
        mode: "development",
        define: { "process.env.NODE_ENV": JSON.stringify("development") },
    };
    await build({
        ...config,
        build: {
            minify: false,
            outDir: path.join(output, "client"),
            rollupOptions: { input: entry, output: { entryFileNames: "app.js" } },
        },
    });
    await build({
        ...config,
        build: { minify: false, outDir: path.join(output, "server"), ssr: entry },
    });
    const { render } = await import(
        pathToFileURL(path.join(output, "server/agent-network-hydration.js"))
    );
    const body = render();
    assert.match(body, /data-agent-network/);
    assert.match(body, /data-agent-planet/);
    assert.match(body, /Hermes, OpenClaw or Grok/);
    const script = await readFile(path.join(output, "client/app.js"));
    const browser = await chromium.launch({
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
            : {}),
        args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const context = await browser.newContext({ reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
        if (new URL(route.request().url()).pathname === "/app.js")
            return route.fulfill({ contentType: "application/javascript", body: script });
        return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html><body><div id="app">${body}</div><script type="module" src="/app.js"></script></body></html>`,
        });
    });
    // Model the harmless last-digit Math differences between Node and Chromium.
    // This runs before the component module computes its orbit samples.
    await context.addInitScript(() => {
        const originalHypot = Math.hypot;
        Math.hypot = (...values) => originalHypot(...values) + 1e-12;
    });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("https://orbit-hydration.test/");
    await page.waitForSelector('html[data-hydrated="true"]');
    assert.equal(await page.locator("[data-agent-planet]").count(), 8);
    assert.deepEqual(
        errors,
        [],
        "React development console.error must include no hydration mismatches",
    );

    const initialContext = await browser.newContext({ javaScriptEnabled: false });
    await initialContext.route("**/*", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><div id="app">${body}</div>`,
        }),
    );
    const initialPage = await initialContext.newPage();
    await initialPage.goto("https://orbit-initial.test/");
    assert.equal(await initialPage.locator("[data-agent-planet]").count(), 8);
    const attributes = (scene) =>
        scene.evaluateAll((elements) =>
            elements.map((el) => ({
                transform: el.getAttribute("transform"),
                d: el.getAttribute("d"),
            })),
        );
    assert.deepEqual(
        await attributes(page.locator("[data-agent-planet], [data-agent-link]")),
        await attributes(initialPage.locator("[data-agent-planet], [data-agent-link]")),
    );
});
