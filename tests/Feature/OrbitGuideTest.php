<?php

use Inertia\Testing\AssertableInertia as Assert;

it('serves the complete Orbit guide at its explicit Markdown URL', function () {
    $this->get('/get-started.md')
        ->assertSuccessful()
        ->assertHeader('Content-Type', 'text/markdown; charset=utf-8')
        ->assertSee('# Get started with Orbit')
        ->assertSee('## Bring up one useful environment')
        ->assertSee('orbit doctor')
        ->assertDontSee('<html', escape: false);
});

it('negotiates a Markdown homepage without changing browser responses', function (string $accept, string $agent, bool $markdown) {
    $response = $this->withHeaders(['Accept' => $accept, 'User-Agent' => $agent])->get('/');

    $response->assertSuccessful();
    expect($response->baseResponse->getVary())->toContain('X-Inertia', 'Accept', 'User-Agent');
    $response->assertHeader('Link', '</get-started.md>; rel="alternate"; type="text/markdown"');

    if ($markdown) {
        $response->assertHeader('Content-Type', 'text/markdown; charset=utf-8')
            ->assertSee('# Get started with Orbit')
            ->assertDontSee('<html', escape: false);
        expect($response->getContent())->toBe(file_get_contents(resource_path('markdown/get-started.md')));
    } else {
        $response->assertHeader('Content-Type', 'text/html; charset=utf-8')
            ->assertInertia(fn (Assert $page) => $page->component('Home')->has('orbitUrl'));
    }
})->with([
    'explicit markdown' => ['text/markdown', 'curl/8.0', true],
    'markdown with charset' => ['text/markdown; charset=utf-8', 'curl/8.0', true],
    'parameterized html preference' => ['text/html; charset=utf-8, text/markdown;q=0.5', 'Mozilla/5.0', false],
    'markdown preferred' => ['text/html;q=0.5, text/markdown;q=1', 'Mozilla/5.0', true],
    'html preferred' => ['text/markdown;q=0.5, text/html;q=1', 'Mozilla/5.0', false],
    'markdown rejected' => ['text/markdown;q=0, */*', 'ChatGPT-User/1.0', false],
    'wildcard preferred' => ['text/markdown;q=0.5, */*;q=1', 'curl/8.0', false],
    'normal browser' => ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Mozilla/5.0', false],
    'generic client' => ['*/*', 'curl/8.0', false],
    'no accept header' => ['', '', false],
    'chatgpt fetch' => ['*/*', 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)', true],
    'claude fetch' => ['', 'Claude-User/1.0', true],
    'perplexity fetch' => ['*/*', 'Perplexity-User/1.0', true],
    'case insensitive agent' => ['*/*', 'claudebot/1.0', true],
    'explicit agent html preference' => ['text/html', 'ChatGPT-User/1.0', false],
    'json preference' => ['application/json', 'ChatGPT-User/1.0', false],
    'rejected wildcard' => ['*/*;q=0', 'Claude-User/1.0', false],
]);

it('preserves Inertia visits even with an agent identifier and markdown preference', function () {
    $version = $this->get('/')->viewData('page')['version'];
    $this->withHeaders([
        'X-Inertia' => 'true',
        'X-Inertia-Version' => $version,
        'Accept' => 'text/markdown',
        'User-Agent' => 'ChatGPT-User/1.0',
    ])->get('/')
        ->assertSuccessful()
        ->assertHeader('X-Inertia', 'true')
        ->assertJsonPath('component', 'Home')
        ->assertJsonStructure(['props' => ['orbitUrl']]);
});

it('provides an absolute share URL for the current site', function () {
    $this->get('https://orbit.example/')
        ->assertInertia(fn (Assert $page) => $page
            ->component('Home')
            ->where('orbitUrl', 'https://orbit.example'));
});
