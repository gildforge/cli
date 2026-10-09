import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const cases=[
 ['live whoami','src/gild.ts','console.log(displayIdentity(current))',"console.log('@legacy')",'whoami reads'],
 ['TXT record','src/gild.ts','console.log(proof.txt.value)',"console.log('disabled proof')",'handle set'],
 ['agent prefix','src/identity/display.ts',"identity.kind === 'agent' ? '' : '@'","'@'",'agent whoami'],
 ['canonical git remote','src/gild.ts','const url=repository.clone_url',"const url=opts.server+'/'+repoArg+'.git'",'clone uses'],
 ['method-preserving redirect','src/api/client.ts','[301,302,307,308].includes(res.status)','[302,307,308].includes(res.status)','handle redirects'],
]
const results=[]
for(const [name,file,before,after,pattern] of cases){
 const original=readFileSync(file,'utf8');if(!original.includes(before))throw Error('Missing revert target: '+name)
 try{
  writeFileSync(file,original.replace(before,after))
  const result=spawnSync('bun',['test','src/handles.test.ts','--test-name-pattern',pattern],{encoding:'utf8',timeout:60000})
  if(result.status===0||result.error||!(result.stdout+result.stderr).includes('expect('))throw Error('Expected assertion failure: '+name+' '+result.stdout+result.stderr)
  results.push({name,exit:result.status});console.log(name+': assertion failed with fix reverted')
 }finally{writeFileSync(file,original)}
}
mkdirSync('docs/identity',{recursive:true});writeFileSync('docs/identity/revert-evidence.json',JSON.stringify(results,null,2)+'\n')
