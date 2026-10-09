import {resolveMention} from './identity/display'
import { join } from 'node:path'
import { GildClient } from './api/client'
import { expect,test } from 'bun:test'
import { cli,fixture } from './test-cli'
const current={id:'account-1',kind:'user',handle:'samifou.ad',handle_verified:true,placeholder:'sami-12345678.gild.gg',label:'sami',requested:null,failures:0,checked_at:1,next_check:2}
test('whoami reads the live stable identity and shows handle verification',async()=>{
 const f=await fixture(req=>{expect(new URL(req.url).pathname).toBe('/api/v1/user/identity');return Response.json(current)})
 try{await f.identity();const r=await cli(f.root,['whoami','--server',f.origin]);expect(r.code).toBe(0);expect(r.out).toContain('@samifou.ad');expect(r.out).toContain('Verified')}finally{await f.close()}
})
test('handle set prints TXT proof for the stable id; check persists the pointer',async()=>{
 const calls:string[]=[],f=await fixture(async req=>{
  const path=new URL(req.url).pathname;calls.push(path)
  if(path.endsWith('/challenge')){expect(await req.json()).toEqual({domain:'samifou.ad'});return Response.json({id:current.id,domain:'samifou.ad',txt:{name:'_gild.samifou.ad',value:'gild='+current.id}})}
  expect(path).toBe('/api/v1/user/identity/check');return Response.json(current)
 })
 try{await f.identity();const set=await cli(f.root,['handle','set','samifou.ad','--server',f.origin]);expect(set.code).toBe(0);expect(set.out).toContain('_gild.samifou.ad');expect(set.out).toContain('gild=account-1');expect(set.out).not.toContain('HTTPS');expect(set.out).not.toContain('.well-known');const check=await cli(f.root,['handle','check','--server',f.origin]);expect(check.code).toBe(0);expect(check.out).toContain('@samifou.ad · Verified');expect(calls).toEqual(['/api/v1/user/identity/challenge','/api/v1/user/identity/check'])}finally{await f.close()}
})

test('agent whoami is bare and retains the owner namespace',async()=>{
 const f=await fixture(()=>Response.json({...current,id:'account-1/ava',kind:'agent',handle:'ava.samifou.ad',owner:{id:current.id,handle:current.handle}}))
 try{await f.agent();const r=await cli(f.root,['whoami','--agent','test','--server',f.origin]);expect(r.code).toBe(0);expect(r.out).toContain('ava.samifou.ad');expect(r.out).not.toContain('@ava.')}finally{await f.close()}
})
test('clone uses the live canonical remote returned by the API',async()=>{
 let source=''
 const f=await fixture(req=>{expect(new URL(req.url).pathname).toBe('/api/v1/repos/alice/demo');return Response.json({id:1,name:'demo',full_name:'samifou.ad/demo',owner:{id:'account-1',login:'samifou.ad',type:'User',html_url:f.origin+'/samifou.ad'},private:false,stargazers_count:0,description:null,default_branch:'main',html_url:f.origin+'/samifou.ad/demo',url:f.origin+'/api/v1/repos/samifou.ad/demo',clone_url:source,created_at:'now',updated_at:'now'})})
 try{
  source=join(f.root,'canonical.git');const target=join(f.root,'clone')
  expect(Bun.spawnSync(['git','init','--bare','--initial-branch=main',source]).exitCode).toBe(0)
  const result=await cli(f.root,['clone','alice/demo',target,'--server',f.origin]);expect(result.code).toBe(0)
  expect(Bun.spawnSync(['git','-C',target,'remote','get-url','origin']).stdout.toString().trim()).toBe(source)
 }finally{await f.close()}
},30000) // Includes a real native Git clone and a separate CLI process.
test('handle redirects preserve a mutation body and refuse credential forwarding',async()=>{
 const f=await fixture(async req=>{
  const path=new URL(req.url).pathname
  if(path==='/api/v1/repos/alice/demo/visibility')return new Response(null,{status:301,headers:{location:f.origin+'/api/v1/repos/samifou.ad/demo/visibility'}})
  if(path==='/api/v1/repos/cross/demo/visibility')return new Response(null,{status:301,headers:{location:'https://untrusted.example/api'}})
  expect(req.method).toBe('PATCH');expect(req.headers.get('authorization')).toBe('Bearer gf_fixturetoken');expect(await req.json()).toEqual({visibility:'private'});return Response.json({visibility:'private'})
 })
 try{
  const client=new GildClient(f.origin+'/api/v1','gf_fixturetoken')
  await expect(client.request('setRepoVisibility',{owner:'alice',repo:'demo'},{visibility:'private'})).resolves.toEqual({visibility:'private'})
  await expect(client.request('setRepoVisibility',{owner:'cross',repo:'demo'},{visibility:'private'})).rejects.toThrow()
 }finally{await f.close()}
})

test('Unicode full mentions resolve even when the organization uses an alias',()=>{
 const person={id:'stable-id',kind:'user' as const,handle:'xn--bcher-kva.de',handle_verified:true}
 expect(resolveMention('@bücher.de',[person],{orgs:['org-id'],aliases:[{org:'org-id',id:person.id,alias:'writer'}]})).toEqual(person)
})
