<?php

declare(strict_types=1);

use Illuminate\Support\Facades\File;

it('keeps the composer manifest installable from a public registry', function (): void {
    $composer = json_decode(
        File::get(base_path('composer.json')),
        associative: true,
        flags: JSON_THROW_ON_ERROR,
    );

    // Path repositories and @dev constraints resolve only on the maintainer's machine and
    // would break `composer create-project` for anyone downloading the kit. Local packages
    // are linked with `composer link` instead.
    expect($composer)->not->toHaveKey('repositories');

    $constraints = array_merge($composer['require'] ?? [], $composer['require-dev'] ?? []);

    foreach ($constraints as $package => $constraint) {
        expect($constraint)->not->toContain('@dev', "{$package} must not use a @dev constraint");
    }
});
