import { afterEach, expect, test } from "bun:test";
import configure from "../../vite.config";

const originalEnvironment = { ...process.env };

afterEach(() => {
    process.env = { ...originalEnvironment };
});

test("Orbit assets use the Route origin once and allow the application origin", async () => {
    process.env.APP_URL = "https://orbit-website.test";
    process.env.ORBIT_DEV_SERVER_ORIGIN = "https://orbit-website.test/__orbit/vite";
    process.env.ORBIT_DEV_SERVER_HOST = "orbit-website.test";
    process.env.ORBIT_DEV_SERVER_PORT = "5205";

    if (typeof configure !== "function") {
        throw new Error("Expected the Vite configuration callback");
    }

    const config = await configure({ command: "serve", mode: "development" });

    expect(config.server?.origin).toBe("https://orbit-website.test");
    expect(config.server?.cors).toEqual({
        origin: "https://orbit-website.test",
    });
    expect(config.server?.allowedHosts).toEqual(["orbit-website.test"]);
});
