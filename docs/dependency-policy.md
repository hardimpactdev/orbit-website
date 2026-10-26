# Dependency policy

This site uses Composer (`composer.lock`) and Bun (`bun.lock`). `package.json` declares Bun. There is no release-age policy: no `vet.json`, no Bun `minimumReleaseAge`, and no `.npmrc` `min-release-age`. Do not add one in a dependency pull request.

`scripts/dependencies` is the standard wrapper for [`hardimpactdev/maintainer`](https://github.com/hardimpactdev/maintainer). It installs Composer dependencies without scripts when `vendor/bin/maintainer` is missing, then forwards every argument. The package README defines `routine`, `detect`, and `package`.

Do not silence an advisory. Do not run `audit fix`. A major or a security fix updates one direct package.

The Orbit task check is `composer test && composer analyse && vp check`. `composer check` also runs the browser tests.
