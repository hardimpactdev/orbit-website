<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Http;

class DocsProxyController extends Controller
{
    private const string UpstreamHost = 'platform11-d668e881.mintlify.site';

    public function __invoke(Request $request, ?string $path = null): Response
    {
        $upstream = 'https://'.self::UpstreamHost.$request->getRequestUri();

        $response = Http::withHeaders([
            'Accept' => $request->header('Accept', '*/*'),
            'Accept-Language' => $request->header('Accept-Language', ''),
            'Origin' => 'https://'.self::UpstreamHost,
            'User-Agent' => $request->userAgent() ?: 'OrbitDocsProxy',
            'X-Forwarded-Host' => 'orbit.nckrtl.com',
            'X-Forwarded-Proto' => 'https',
        ])->withOptions([
            'http_errors' => false,
            'allow_redirects' => false,
        ])->send($request->method(), $upstream, [
            'body' => $request->getContent(),
        ]);

        $headers = collect($response->headers())
            ->reject(fn (array|string $value, string $name): bool => in_array(strtolower($name), [
                'connection',
                'content-encoding',
                'content-length',
                'keep-alive',
                'transfer-encoding',
            ], true))
            ->map(fn (array|string $value): string => is_array($value) ? (string) $value[0] : $value)
            ->all();

        return response($response->body(), $response->status(), $headers);
    }
}
