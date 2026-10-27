<?php

// The development React console.error regression runs in bun run test:hydration.
it('renders the agent orbits without uncaught browser errors', function () {
    visit('/', ['reducedMotion' => 'reduce'])
        ->assertPresent('[data-agent-network]')
        ->assertNoJavaScriptErrors()
        ->assertNoConsoleLogs();
});
