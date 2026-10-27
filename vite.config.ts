import { defineLaunchConfig } from "@nckrtl/launch-ui/vite";
import { defineConfig } from "vite-plus";

const launchConfig = await defineLaunchConfig({
    // The SSR port is baked into bootstrap/ssr/app.js at build time and has no env
    // override, so it has to be pinned here. 13714-13718 are taken on the main1
    // production node, hence 13719.
    inertia: { ssr: { port: 13719 } },
});

function resolveDevServerOrigin(): string | undefined {
    const host = process.env.ORBIT_DEV_SERVER_HOST?.trim();
    const port = process.env.ORBIT_DEV_SERVER_PORT?.trim();
    const appUrl = process.env.VITE_APP_URL?.trim() || process.env.APP_URL?.trim();

    // Prefer host:port over Orbit's path-based ORBIT_DEV_SERVER_ORIGIN.
    // /__orbit/vite currently falls through to Laravel (404), and the gateway's
    // shared :5173 is claimed by Commander, so keep public/hot absent until the
    // Orbit Vite proxy routes correctly for this instance.
    if (host && port) {
        try {
            const protocol = appUrl ? new URL(appUrl).protocol : "https:";
            return `${protocol}//${host}:${port}`;
        } catch {
            return `https://${host}:${port}`;
        }
    }

    const orbitOrigin = process.env.ORBIT_DEV_SERVER_ORIGIN?.trim();
    if (orbitOrigin) {
        return orbitOrigin.replace(/\/$/, "");
    }

    return process.env.VITE_DEV_SERVER_ORIGIN?.trim() || undefined;
}

export default defineConfig(async (environment) => {
    const config = await launchConfig(environment);
    const origin = resolveDevServerOrigin();
    const allowedHost = process.env.ORBIT_DEV_SERVER_HOST?.trim();

    return {
        ...config,
        server: {
            ...config.server,
            ...(origin ? { origin } : {}),
            ...(allowedHost ? { allowedHosts: [allowedHost] } : {}),
        },
        fmt: { ignorePatterns: [".agents/**"] },
        // Pre-commit tasks, run against staged files only by `vp staged` from
        // .vite-hooks/pre-commit. Anything they fix is re-staged automatically.
        staged: {
            "*": "vp check --fix",
            "*.php": "vendor/bin/pint",
        },
    };
});
