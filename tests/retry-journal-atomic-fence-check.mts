import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/journal-store.js','utf8');
const url='https://chatgpt.com/c/atomic-retry',tab={id:7,url},path='/c/atomic-retry',attemptId='1000';
async function fixture(){
 const data:Record<string,any>={},writes:any[]=[];let before:any=null,after:any=null,fail:any=null,entered:()=>void=()=>{},release:()=>void=()=>{},gate:Promise<void>;
 const chrome={runtime:{getManifest:()=>({version:'test'})},storage:{local:{
  get:async(k:any)=>structuredClone(k===null?data:Array.isArray(k)?Object.fromEntries(k.map((x:string)=>[x,data[x]])):{[k]:data[k]}),
  set:async(v:any)=>{if(fail?.(v)){fail=null;throw Error('synthetic cleanup failure');}if(before?.(v)){before=null;entered();await gate;}writes.push(structuredClone(v));Object.assign(data,structuredClone(v));if(after?.(v)){after=null;entered();await gate;}}
 }}};
 let ctx=createContext({URL,console,chrome});runInContext(source,ctx);
 const append=(e:any,t=tab)=>{ctx.e=e;ctx.t=t;return runInContext('appendJournal(e,t)',ctx)};
 await runInContext("initializeJournal('test')",ctx);
 await append({kind:'error.detected',action:'retry',sourceUrl:url,promptKey:path,attemptId,error:'Interrupted'});
 await append({kind:'retry.failed',sourceUrl:url,promptKey:path,attemptId,reason:'refused',clicked:false});
 const beforeState=structuredClone(data['chatgpt-journal:meta'].retryByChat['atomic-retry']);
 const draft={operationId:'owner-draft',phase:'saved',savedSequence:88};data['chatgpt-journal:meta'].retryDraftByChat[url]=structuredClone(draft);
 const proof={expectedSequence:data['chatgpt-journal:meta'].sequence,oldPromptKey:path,newPromptKey:path+'|user'};
 const commit=()=>append({kind:'retry.preparation_recovered',sourceUrl:url,operationId:'recovery',promptKey:path,attemptId,legacyNoClick:proof});
 function defer(predicate:any,committed=false){const observed=new Promise<void>(r=>{entered=r});gate=new Promise<void>(r=>{release=r});if(committed)after=predicate;else before=predicate;return {observed,release:()=>release()};}
 const reboot=()=>{ctx=createContext({URL,console,chrome});runInContext(source,ctx)};
 return {data,writes,append,commit,defer,reboot,beforeState,draft,failOnce:(p:any)=>{fail=p},recover:()=>runInContext('recoverProvisionalGoalCAS()',ctx)};
}
{
 const f=await fixture(),held=f.defer((v:any)=>v['chatgpt-retry-cas:provisional']);
 const commit=f.commit();await held.observed;
 const request=f.append({kind:'request.started',sourceUrl:'https://chatgpt.com/',requestId:'unknown'}, {id:8,url:'https://chatgpt.com/'});
 held.release();await assert.rejects(commit,(e:any)=>e.code==='RETRY_LEGACY_RACE');await request;
 assert.deepEqual(f.data['chatgpt-journal:meta'].retryByChat['atomic-retry'],f.beforeState);
 assert.deepEqual(f.data['chatgpt-journal:meta'].retryDraftByChat[url],f.draft);
 assert.equal(f.data['chatgpt-retry-cas:provisional'],null);
 assert.ok(Object.values(f.data).some((v:any)=>v?.kind==='retry.preparation_rollback'));
 delete f.data['chatgpt-journal:meta'].retrySchema;f.reboot();
 const migrated=await f.append({kind:'watcher.started',sourceUrl:'https://chatgpt.com/c/other'},{id:9,url:'https://chatgpt.com/c/other'});
 assert.equal(migrated.ok,true);assert.deepEqual(f.data['chatgpt-journal:meta'].retryByChat['atomic-retry'],f.beforeState,'migration replays rollback rather than reopening the blocked state');
}
{
 const f=await fixture(),held=f.defer((v:any)=>v['chatgpt-retry-cas:provisional'],true);
 void f.commit();await held.observed;assert.ok(f.data['chatgpt-retry-cas:provisional']);
 f.reboot();assert.equal((await f.recover()).recovered,true);
 assert.deepEqual(f.data['chatgpt-journal:meta'].retryByChat['atomic-retry'],f.beforeState);
 assert.deepEqual(f.data['chatgpt-journal:meta'].retryDraftByChat[url],f.draft);
 assert.equal(f.data['chatgpt-retry-cas:provisional'],null);
}
for(const kind of ['retry.manual_reset','retry.resume','retry.preparation_superseded','retry.failed']) {
 const f=await fixture();f.failOnce((v:any)=>Object.hasOwn(v,'chatgpt-retry-cas:provisional')&&v['chatgpt-retry-cas:provisional']===null);
 await assert.rejects(()=>f.commit(),(e:any)=>e.code==='RETRY_CAS_CLEANUP_UNKNOWN');
 const sequence=f.data['chatgpt-journal:meta'].sequence;
 await f.append({kind,sourceUrl:url,operationId:'user',startedAt:2000,remainingRetries:2,clicked:false,attemptId:'2000'});
 assert.equal(f.data['chatgpt-retry-cas:provisional'],null,'same-chat mutation first resolves provisional recovery');
 assert.equal(f.data['chatgpt-journal:event:'+String(sequence+1).padStart(12,'0')].kind,'retry.preparation_rollback');
 assert.equal(f.data['chatgpt-journal:event:'+String(sequence+2).padStart(12,'0')].kind,kind);
 if(kind==='retry.manual_reset')assert.equal(f.data['chatgpt-journal:meta'].retryByChat['atomic-retry'],undefined,'explicit reset wins over rolled back state');
 assert.equal((await f.recover()).recovered,false,'subsequent startup recovery cannot resurrect stale state');
}
{
 const f=await fixture();f.failOnce((v:any)=>Object.hasOwn(v,'chatgpt-retry-cas:provisional')&&v['chatgpt-retry-cas:provisional']===null);
 await assert.rejects(()=>f.commit(),(e:any)=>e.code==='RETRY_CAS_CLEANUP_UNKNOWN');
 await f.append({kind:'retry.manual_reset',sourceUrl:'https://chatgpt.com/c/unrelated'},{id:8,url:'https://chatgpt.com/c/unrelated'});
 assert.ok(f.data['chatgpt-retry-cas:provisional'],'different chat is not blocked or made to resolve receipt');
 assert.equal((await f.recover()).recovered,true);
}
{
 const f=await fixture(),held=f.defer((v:any)=>v['chatgpt-retry-cas:provisional']);
 const commit=f.commit();await held.observed;
 const request=f.append({kind:'request.started',sourceUrl:'https://chatgpt.com/c/unrelated',requestId:'other'}, {id:8,url:'https://chatgpt.com/c/unrelated'});
 held.release();assert.equal((await commit).ok,true);await request;
 assert.equal(f.data['chatgpt-journal:meta'].retryByChat['atomic-retry'].blocked,false);
 assert.equal(f.data['chatgpt-retry-cas:provisional'],null);
}
for(const variant of ['same-tab','same-chat','unknown','unrelated']) {
 const f=await fixture(),prompt=path+'|retry-user';
 await f.append({kind:'retry.planned',sourceUrl:url,operationId:'grant-op',promptKey:prompt});
 await f.append({kind:'retry.send_intent',sourceUrl:url,operationId:'grant-op',promptKey:prompt});
 const held=f.defer((v:any)=>v['chatgpt-journal:meta']?.active?.[7]?.consumed===true);
 const grant=f.append({kind:'send.authorized',sourceUrl:url,operationId:'grant-op'});await held.observed;
 const nextUrl=variant==='same-tab'||variant==='same-chat'?url:variant==='unknown'?'https://chatgpt.com/':'https://chatgpt.com/c/unrelated';
 const nextTab={id:variant==='same-tab'?7:8,url:nextUrl};
 const request=f.append({kind:'request.started',sourceUrl:nextUrl,requestId:'during-grant'},nextTab);
 held.release();
 if(variant==='unrelated')assert.equal((await grant).ok,true,'known unrelated chat does not block grant');
 else await assert.rejects(grant,(e:any)=>e.code==='RETRY_GRANT_RACE',variant+' fails closed before page dispatch');
 await request;
 assert.equal(f.data['chatgpt-journal:meta'].active[7].consumed,true,'a grant recorded during ingress stays consumed');
 f.reboot();await assert.rejects(()=>f.append({kind:'send.authorized',sourceUrl:url,operationId:'grant-op'}),/Повторная автоматическая отправка запрещена/,'restart cannot replay consumed grant');
}
{
 const f=await fixture(),prompt=path+'|retry-user';
 await f.append({kind:'retry.planned',sourceUrl:url,operationId:'before-grant',promptKey:prompt});
 await f.append({kind:'retry.send_intent',sourceUrl:url,operationId:'before-grant',promptKey:prompt});
 await f.append({kind:'request.started',sourceUrl:url,requestId:'before-grant-request'},{id:8,url});
 await assert.rejects(()=>f.append({kind:'send.authorized',sourceUrl:url,operationId:'before-grant'}),'a newer request recorded before grant must not authorize the old retry');
}
for(const variant of ['unknown','unrelated']) {
 const f=await fixture(),prompt=path+'|retry-user';
 await f.append({kind:'retry.planned',sourceUrl:url,operationId:'pre-'+variant,promptKey:prompt});
 await f.append({kind:'retry.send_intent',sourceUrl:url,operationId:'pre-'+variant,promptKey:prompt});
 const other=variant==='unknown'?'https://chatgpt.com/':'https://chatgpt.com/c/unrelated';
 await f.append({kind:'request.started',sourceUrl:other,requestId:'before-grant-request'},{id:8,url:other});
 f.reboot();const grant=()=>f.append({kind:'send.authorized',sourceUrl:url,operationId:'pre-'+variant});
 if(variant==='unknown')await assert.rejects(grant,'unknown durable request blocks old grant after restart');
 else assert.equal((await grant()).ok,true,'known unrelated durable request does not block grant');
}
for(const newer of [true,false]) {
 const f=await fixture(),prompt=path+'|legacy-user',op='legacy-plan-'+newer;
 await f.append({kind:'retry.planned',sourceUrl:url,operationId:op,promptKey:prompt});
 delete f.data['chatgpt-journal:meta'].retryPreparingByChat[url].plannedSequence;
 if(newer)await f.append({kind:'request.started',sourceUrl:url,requestId:'newer'},{id:8,url});
 f.reboot();
 await assert.rejects(()=>f.append({kind:'retry.send_intent',sourceUrl:url,operationId:op,promptKey:prompt}),
  /Автоповтор этого запроса уже запускался/,'a legacy reservation without a plan anchor cannot invent one at intent');
 assert.equal(f.data['chatgpt-journal:meta'].active?.[7],undefined);
 await assert.rejects(()=>f.append({kind:'send.authorized',sourceUrl:url,operationId:op}));
}
{
 const f=await fixture(),prompt=path+'|unplanned';
 await assert.rejects(()=>f.append({kind:'retry.send_intent',sourceUrl:url,operationId:'no-plan',promptKey:prompt}),
  /Автоповтор этого запроса уже запускался/,'an intent without any reservation cannot fabricate a plan anchor');
}
console.log('Retry recovery CAS fences concurrent ingress and restores budget/draft after restart.');
