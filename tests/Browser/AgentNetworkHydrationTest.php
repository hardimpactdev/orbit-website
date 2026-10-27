<?php

it('hydrates the server-rendered agent orbits without coordinate mismatches', function () {
    visit('/', ['reducedMotion' => 'reduce'])
        ->assertPresent('[data-agent-network]')
        ->assertNoJavaScriptErrors()
        ->assertNoConsoleLogs();
});
