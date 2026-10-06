# Publishing to npm

Names: `gildforge` (umbrella CLI) + `@gildforge/cli-{darwin-arm64,darwin-x64,linux-x64}`
(binaries). The `@gildforge/server[-*]` packages publish from gildforge/server,
not here.

```sh
npm login

bun run pack                 # builds packages/{cli-*,gildforge}

# platform packages first, then the umbrellas
for p in packages/cli-*; do (cd "$p" && npm publish --access public); done
(cd packages/gildforge && npm publish --access public)
```

Version bumps: edit `version` in the root package.json, re-run both pack
scripts, republish everything (platform versions pin the umbrella exactly).
