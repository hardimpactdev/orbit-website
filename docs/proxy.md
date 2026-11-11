# Documentation proxy

`/docs` forwards read-only documentation requests to Mintlify. Forwarded responses
keep the upstream status, content type, cache policy, CSP, and redirects.

Header names are case-insensitive. Do not forward hop-by-hop headers or the
upstream content length and content encoding: the HTTP client can decode the
body, and the local web server must frame the returned body itself. Forwarding
these transport headers can leave the browser with an empty response or an
HTTP/2 protocol error.

## Local development

Use Orbit's `vp-dev` Process preset. It serves plain HTTP on the Instance's assigned
Vite port; Caddy serves `/__orbit/vite/` over the Route's HTTPS origin. Vite's
`server.origin` must contain only that origin. Its base already contains the path.
Allow the application origin for CORS instead of the backend's direct port.

Inertia's development SSR endpoint is `/__inertia_ssr` at the backend root. Set
`INERTIA_SSR_HOT_URL` through Orbit environment operations to the Instance's
loopback Vite URL, without `/__orbit/vite`, when the Laravel process cannot reach
that endpoint through the public proxy. Keep SSR enabled and verify initial HTML
with JavaScript disabled as well as client hydration.

## Hydration regression

Run `bun run test:hydration` for the actual agent scene. It builds React in
development mode into a disposable directory, captures `console.error` before
hydration, and models the tiny `Math.hypot` differences between JavaScript
engines. It checks that the scene is present without JavaScript and that its
initial SVG geometry survives hydration. Removing the SVG precision repair
makes this test fail with React's attribute-mismatch warning. Pest's default
console recorder does not capture that warning.

The test uses intercepted requests, with no app server, shared SSR port or
database. Install Playwright Chromium first (`bunx playwright install chromium`).
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing local Chrome.
