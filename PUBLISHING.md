# Publishing to npm

Names: `gildforge` (umbrella CLI) + `@gildforge/cli-{darwin-arm64,darwin-x64,linux-x64}`
(binaries) + `@gildforge/server[-*]` (placeholders until the Rust server lands).

```sh
npm login

bun run pack                 # builds packages/{cli-*,gildforge}
bun run pack:server          # builds packages/server-* placeholders

# platform packages first, then the umbrellas
for p in packages/cli-* packages/server-*; do (cd "$p" && npm publish --access public); done
(cd packages/gildforge && npm publish --access public)
(cd packages/server && npm publish --access public)
```

Version bumps: edit `version` in the root package.json, re-run both pack
scripts, republish everything (platform versions pin the umbrella exactly).
