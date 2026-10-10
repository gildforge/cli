import {execFileSync,spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import assert from 'node:assert/strict'
const baseline='bd97f4c5a8dbcb7257df3d60673f22638f7f0d05',files=['src/chat.ts','src/chat-tui.ts','src/spawn-bridge.ts'],saved=new Map(files.map(f=>[f,readFileSync(f)]))
mkdirSync('.tmp',{recursive:true})
try {
  for(const f of files)writeFileSync(f,execFileSync('git',['show',baseline+':'+f]))
  const result=spawnSync('bun',['test','--timeout','30000','--test-name-pattern','branch selectors|repo event bridge|buffer list switches|branch trigger prompts','src/chat.test.ts','src/chat-tui.test.ts','src/spawn-bridge.test.ts'],{encoding:'utf8'})
  writeFileSync('.tmp/branch-channels-reverted.log',result.stdout+result.stderr)
  process.stdout.write(result.stdout);process.stderr.write(result.stderr)
  assert.notEqual(result.status,0,'branch regressions must fail against the unmodified IRC TUI')
  assert.match(result.stderr,/4 fail/,'all four feature regressions fail when fixes are reverted')
  console.log('Revert proof: flags, TUI branch switching and scoped mention prompts all fail against the original TUI')
} finally {for(const [f,text] of saved)writeFileSync(f,text)}

const reporter='src/spawn-receipts.ts',original=readFileSync(reporter,'utf8'),needle='channel ? { channel } : undefined'
assert.ok(original.includes(needle),'receipt channel mutation reaches the real reporter')
try {
  writeFileSync(reporter,original.replace(needle,'undefined'))
  const result=spawnSync('bun',['test','src/spawn-receipts.test.ts','--test-name-pattern','branch receipt reports'],{encoding:'utf8'})
  writeFileSync('.tmp/branch-receipts-reverted.log',result.stdout+result.stderr)
  assert.notEqual(result.status,0);assert.match(result.stderr,/expect\(|1 fail/)
  console.log('Revert proof: branch receipt routing fails without the channel query')
} finally {writeFileSync(reporter,original)}
const restored=spawnSync('bun',['test','src/spawn-receipts.test.ts','--test-name-pattern','branch receipt reports'],{encoding:'utf8'})
assert.equal(restored.status,0,restored.stderr)

const instructions='src/agent-instructions.ts',synced=readFileSync(instructions,'utf8'),hint='this.options.enqueue(reread+workNoteHint'
assert.ok(synced.includes(hint),'instruction note mutation reaches the sync prompt')
try {
 writeFileSync(instructions,synced.replace(hint,'if(false)this.options.enqueue(reread+workNoteHint'))
 const result=spawnSync('bun',['test','src/agent-instructions.test.ts','--test-name-pattern','instruction sync tells'],{encoding:'utf8'})
 writeFileSync('.tmp/branch-instructions-reverted.log',result.stdout+result.stderr)
 assert.notEqual(result.status,0);assert.match(result.stderr,/expect\(|1 fail/)
 console.log('Revert proof: instruction sync loses branch work-note guidance when the hint is removed')
} finally {writeFileSync(instructions,synced)}
