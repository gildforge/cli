import {execFileSync,spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import assert from 'node:assert/strict'
const baseline='bd97f4c5a8dbcb7257df3d60673f22638f7f0d05',files=['src/chat.ts','src/chat-tui.ts','src/spawn-bridge.ts'],saved=new Map(files.map(f=>[f,readFileSync(f)]))
mkdirSync('.tmp',{recursive:true})
try {
  for(const f of files)writeFileSync(f,execFileSync('git',['show',baseline+':'+f]))
  const result=spawnSync('bun',['test','--timeout','30000','--test-name-pattern','branch selectors|repo event bridge|buffer list switches','src/chat.test.ts','src/chat-tui.test.ts','src/spawn-bridge.test.ts'],{encoding:'utf8'})
  writeFileSync('.tmp/branch-channels-reverted.log',result.stdout+result.stderr)
  process.stdout.write(result.stdout);process.stderr.write(result.stderr)
  assert.notEqual(result.status,0,'branch regressions must fail against the unmodified IRC TUI')
  assert.match(result.stderr,/3 fail/,'all three feature regressions fail when fixes are reverted')
  console.log('Revert proof: flags, TUI branch switching and scoped mention prompts all fail against the original TUI')
} finally {for(const [f,text] of saved)writeFileSync(f,text)}
