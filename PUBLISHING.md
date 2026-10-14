# Publishing to npm

Names: `gildforge` (umbrella CLI) + `@gildforge/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}`
(binaries). The `@gildforge/server[-*]` packages publish from gildforge/server,
not here.

A new platform package (`@gildforge/cli-linux-arm64` from 0.6.13) must exist on
npm and have the trusted publisher (gildforge/cli, `release.yml`, environment
`release`) set before the Release workflow can publish it: publish its first
version by hand, then add the trusted publisher in its npm settings.

```sh
npm login

bun run pack                 # builds packages/{cli-*,gildforge}

# platform packages first, then the umbrellas
for p in packages/cli-*; do (cd "$p" && npm publish --access public); done
(cd packages/gildforge && npm publish --access public)
```

Version bumps: edit `version` in the root package.json, re-run both pack
scripts, republish everything (platform versions pin the umbrella exactly).
