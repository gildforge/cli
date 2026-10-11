// Test-only preload: hold the real host worker inside socket cleanup, before
// process.exit can hide a missing explicit terminal restoration. No product hooks.
const fs = require('node:fs')
const path = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const barrier = process.env.TEST_GILD_TERMINAL_BARRIER
if (
  barrier &&
  /[\\/]spawn-worker-[a-f0-9]{16}\.mjs$/.test(process.argv[1] ?? '')
) {
  const socket = path.join(
    path.dirname(barrier),
    '.gild',
    'sessions',
    'test.sock',
  )
  const unlink = fs.unlinkSync
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  let held = false
  fs.unlinkSync = function (entry) {
    try {
      return unlink.apply(this, arguments)
    } finally {
      // server.close may already have unlinked its Unix socket. Preserve ENOENT.
      if (entry === socket && !held && !fs.existsSync(socket)) {
        held = true
        fs.writeFileSync(
          barrier + '.tmp',
          JSON.stringify({ pid: process.pid, socket }),
          {
            mode: 0o600,
          },
        )
        fs.renameSync(barrier + '.tmp', barrier)
        const deadline = Date.now() + 8000
        while (!fs.existsSync(barrier + '.release')) {
          if (Date.now() >= deadline)
            throw new Error('terminal cleanup barrier was not released')
          Atomics.wait(sleeper, 0, 0, 10)
        }
      }
    }
  }
  syncBuiltinESMExports()
}
