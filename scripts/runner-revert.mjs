import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
mkdirSync('.tmp',{recursive:true})
const file='src/runner.ts',original=readFileSync(file,'utf8'),evidence=[]
try {
  const before="return ['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', script]"
  if(!original.includes(before))throw new Error('pipefail mutation missing')
  writeFileSync(file,original.replace(before,"return ['bash', '--noprofile', '--norc', '-e', script]"))
  const r=spawnSync('bun',['test','--test-name-pattern','runner default bash','src/runner.test.ts'],{encoding:'utf8'})
  writeFileSync('.tmp/revert-pipefail.log',r.stdout+r.stderr)
  if(r.status===0||!r.stderr.includes('expect('))throw new Error('pipeline test did not catch removed pipefail')
  evidence.push({behavior:'default shell fails a failed pipeline',exit:r.status,assertionFailure:true});console.log('Removed pipefail: expected assertion failure')
} finally {writeFileSync(file,original)}
try {
  const before='new LogBatch(config, job, i, counter(i))'
  if(!original.includes(before))throw new Error('log counter mutation missing')
  writeFileSync(file,original.replace(before,'new LogBatch(config, job, i)'))
  const r=spawnSync('node',['scripts/actions-local.mjs'],{cwd:resolve('../gild-site'),encoding:'utf8',timeout:120_000,maxBuffer:8*1024*1024})
  writeFileSync('.tmp/revert-log-counter.log',r.stdout+r.stderr)
  if(r.status===0||!r.stderr.includes('AssertionError')||!r.stderr.includes("gild doesn't run"))throw new Error('local end-to-end test did not catch reused batch sequence')
  evidence.push({behavior:'first-step logs survive checkout and unsupported actions log their failure',exit:r.status,assertionFailure:true});console.log('Reused log batch sequence: expected end-to-end assertion failure')
} finally {writeFileSync(file,original)}
mkdirSync('docs',{recursive:true});writeFileSync('docs/runner-revert-evidence.json',JSON.stringify(evidence,null,2)+'\n')
