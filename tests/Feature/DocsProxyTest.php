<?php

use Illuminate\Support\Facades\Http;

it('returns the documentation body without upstream transport headers', function () {
    $body = '<!doctype html><title>Orbit docs</title><h1>Quickstart</h1>';

    Http::fake([
        'platform11-d668e881.mintlify.site/docs/quickstart' => Http::response($body, 200, [
            'Content-Type' => 'text/html; charset=utf-8',
            'Content-Length' => '9999',
            'Content-Encoding' => 'gzip',
            'Transfer-Encoding' => 'chunked',
            'Connection' => 'keep-alive',
            'Keep-Alive' => 'timeout=5',
            'Content-Security-Policy' => "default-src 'self' https:",
        ]),
    ]);

    $this->get('/docs/quickstart')
        ->assertOk()
        ->assertContent($body)
        ->assertHeader('Content-Type', 'text/html; charset=utf-8')
        ->assertHeader('Content-Security-Policy', "default-src 'self' https:")
        ->assertHeaderMissing('Content-Length')
        ->assertHeaderMissing('Content-Encoding')
        ->assertHeaderMissing('Transfer-Encoding')
        ->assertHeaderMissing('Connection')
        ->assertHeaderMissing('Keep-Alive');
});

it('preserves documentation redirects and their location', function () {
    Http::fake([
        'platform11-d668e881.mintlify.site/docs/old' => Http::response('', 301, [
            'Location' => '/docs/quickstart',
        ]),
    ]);

    $this->get('/docs/old')->assertStatus(301)->assertRedirect('/docs/quickstart');
});
