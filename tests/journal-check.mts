import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/journal-store.js','utf8');
const storage:Record<string,any>={};
let fail=false;
function boot(){
 const ctx=createContext({URL,console,chrome:{runtime:{getManifest:()=>({version:'1.2.0'})},storage:{local:{
  get:async(key:string|string[]|null)=>structuredClone(key===null?storage:Array.isArray(key)?Object.fromEntries(key.map(k=>[k,storage[k]])):{[key]:storage[key]}),
  set:async(value:any)=>{if(fail)throw new Error('Disk full'); await new Promise(r=>setTimeout(r,1));Object.assign(storage,structuredClone(value));}
 }}}});
 runInContext(source,ctx);return ctx;
}
let ctx=boot();
async function append(event:Record<string,any>,tab={id:7,url:'https://chatgpt.com/c/source-chat',title:'Source'}){
 ctx.event=event;ctx.tab=tab;return await runInContext('appendJournal(event,tab)',ctx);
}
await runInContext("initializeJournal('test')",ctx);
await Promise.all(Array.from({length:30},(_,i)=>append({kind:'retry.planned',operationId:`op-${i}`,text:'доделай е2е'})));
let result=await runInContext('readJournal()',ctx);
assert.equal(result.events.length,32,'concurrent writes must not lose events');
assert.deepEqual(Array.from(result.events,(e:any)=>e.sequence),Array.from({length:32},(_,i)=>i+1));
const payload='History\n'.repeat(5000);
await append({kind:'handoff.navigating',operationId:'handoff',text:payload,sourceUrl:'https://chatgpt.com/c/source-chat'});
await append({kind:'handoff.sending',operationId:'handoff',sourceUrl:'https://chatgpt.com/c/source-chat',targetUrl:'https://chatgpt.com/'});
ctx=boot(); // Service worker suspension must retain active operation and sequence.
await append({kind:'request.started',requestId:'r-1',sourceUrl:'https://chatgpt.com/'});
await append({kind:'handoff.sent',operationId:'handoff',sourceUrl:'https://chatgpt.com/c/source-chat',targetUrl:'https://chatgpt.com/c/target-chat'});
await append({kind:'request.completed',requestId:'r-1',statusCode:200});
result=await runInContext('readJournal()',ctx);
const sent=result.events.find((e:any)=>e.kind==='handoff.sent');
assert.equal(sent.sourceChatId,'source-chat');assert.equal(sent.targetChatId,'target-chat');
assert.equal(result.events.find((e:any)=>e.kind==='request.started').operationId,'handoff');
assert.equal(result.events.at(-1).operationId,'handoff','network completion must retain correlation after confirmed send');
assert.equal(result.events.find((e:any)=>e.kind==='handoff.navigating').text,payload,'full payload must survive export and restart');
await append({kind:'request.started',requestId:'r-2'});
result=await runInContext('readJournal()',ctx);assert.equal(result.events.at(-1).automatic,false,'later manual send must not inherit completed operation');
const before=result.events.length;fail=true;await assert.rejects(append({kind:'retry.send_intent',operationId:'no-send'}),/Disk full/);
result=await runInContext('readJournal()',ctx);assert.equal(result.events.length,before);assert.match(result.storageError,/Disk full/);
fail=false;await append({kind:'watcher.started'});result=await runInContext('readJournal()',ctx);assert.equal(result.events.length,before+1);assert.equal(result.storageError,'');
console.log('PASS: concurrent durable audit, exact payload export, worker restart correlation, source/target chat IDs, no false manual attribution, disk failure recovery');

// Legacy no-click rebinding is an atomic summary transition, never a reset of
// retry budget. A racing journal append prevents the old proof being used.
{
 const tab={id:90,url:'https://chatgpt.com/c/legacy-no-click',title:'Fixture'},path='/c/legacy-no-click',next=path+'|server:0:user',attemptId=String(Date.now());
 await append({kind:'error.detected',action:'retry',sourceUrl:tab.url,promptKey:path,attemptId,error:'Interrupted'},tab);
 await append({kind:'retry.failed',sourceUrl:tab.url,promptKey:path,attemptId,reason:'Stopped before send',clicked:false},tab);
 const seq=storage['chatgpt-journal:meta'].sequence,proof={expectedSequence:seq,oldPromptKey:path,newPromptKey:next};
 await append({kind:'watcher.started',sourceUrl:'https://chatgpt.com/c/unrelated'},{id:89,url:'https://chatgpt.com/c/unrelated',title:'Other'});
 await append({kind:'retry.preparation_recovered',sourceUrl:tab.url,operationId:'recovered',promptKey:path,attemptId,legacyNoClick:proof},tab);
 ctx.url=tab.url;let state=await runInContext('readRetryState(url)',ctx);
 assert.equal(state.blocked,false);assert.equal(state.lastPromptKey,next);assert.equal(state.preparationRecoveries,1);
 await append({kind:'error.detected',action:'retry',sourceUrl:tab.url,promptKey:path,attemptId,error:'Interrupted'},tab);
 await append({kind:'retry.failed',sourceUrl:tab.url,promptKey:path,attemptId,reason:'Stopped before send',clicked:false},tab);
 const stale={expectedSequence:storage['chatgpt-journal:meta'].sequence,oldPromptKey:path,newPromptKey:next};
 await append({kind:'watcher.started',sourceUrl:tab.url},tab);
 await assert.rejects(()=>append({kind:'retry.preparation_recovered',sourceUrl:tab.url,operationId:'stale',promptKey:path,attemptId,legacyNoClick:stale},tab),/изменился/);
 state=await runInContext('readRetryState(url)',ctx);assert.equal(state.blocked,true,'a stale proof cannot release the blocked state');
}

for(const variant of ['unknown','unrelated','write-failure']) {
 const tab={id:90,url:'https://chatgpt.com/c/legacy-delta-'+variant,title:'Fixture'},path='/c/legacy-delta-'+variant,attemptId=String(Date.now());
 await append({kind:'error.detected',action:'retry',sourceUrl:tab.url,promptKey:path,attemptId,error:'Interrupted'},tab);
 await append({kind:'retry.failed',sourceUrl:tab.url,promptKey:path,attemptId,reason:'Stopped before send',clicked:false},tab);
 const proof={expectedSequence:storage['chatgpt-journal:meta'].sequence,oldPromptKey:path,newPromptKey:path+'|server:user'};
 if(variant==='write-failure'){
  fail=true;await assert.rejects(()=>append({kind:'request.started',sourceUrl:tab.url,requestId:'lost'},tab),/Disk full/);fail=false;
  await append({kind:'watcher.started',sourceUrl:'https://chatgpt.com/c/other'},{id:89,url:'https://chatgpt.com/c/other',title:'Other'});
 } else {
  const url=variant==='unknown'?'https://chatgpt.com/':'https://chatgpt.com/c/other';
  await append({kind:'request.started',sourceUrl:url,requestId:'concurrent'}, {id:89,url,title:'Other'});
 }
 const recover=()=>append({kind:'retry.preparation_recovered',sourceUrl:tab.url,operationId:'recover-'+variant,promptKey:path,attemptId,legacyNoClick:proof},tab);
 if(variant==='unrelated')assert.equal((await recover()).ok,true,'known unrelated request does not block legacy recovery');
 else await assert.rejects(recover,/изменился/,'unknown or missing request invalidates legacy recovery');
}

// Consecutive same-error count survives worker restart and duplicate DOM scans.
const repeatTab={id:91,url:'https://chatgpt.com/c/repeated-error',title:'Test'};
for(let i=0;i<3;i++)await append({kind:'error.detected',action:'retry',sourceUrl:repeatTab.url,
 promptKey:'prompt-'+i,attemptId:String(Date.now()+i),error:'Timeout'},repeatTab);
ctx=boot();ctx.repeatUrl=repeatTab.url;
assert.equal((await runInContext('readRetryState(repeatUrl)',ctx)).sameErrorCount,3);
await append({kind:'error.detected',action:'retry',sourceUrl:repeatTab.url,
 promptKey:'prompt-2',attemptId:(await runInContext('readRetryState(repeatUrl)',ctx)).lastAttemptId,error:'Timeout'},repeatTab);
assert.equal((await runInContext('readRetryState(repeatUrl)',ctx)).sameErrorCount,3);
await append({kind:'error.detected',action:'retry',sourceUrl:repeatTab.url,
 promptKey:'different',attemptId:String(Date.now()+5),error:'Another failure'},repeatTab);
assert.equal((await runInContext('readRetryState(repeatUrl)',ctx)).sameErrorCount,1);

// Temporary fallback turn keys can be reused for a different native user.
const stableTab={id:92,url:'https://chatgpt.com/c/stable-user',title:'Test'};
async function claimNativeUser(operationId:string,retryUserId:string,promptKey:string) {
 await append({kind:'retry.planned',operationId,retryUserId,promptKey,sourceUrl:stableTab.url},stableTab);
 await append({kind:'retry.send_intent',operationId,promptKey,sourceUrl:stableTab.url,text:'доделай е2е'},stableTab);
 await append({kind:'send.authorized',operationId,sourceUrl:stableTab.url,text:'доделай е2е'},stableTab);
 await append({kind:'retry.confirmed',operationId,sourceUrl:stableTab.url},stableTab);
}
await claimNativeUser('native-first','user-1','/c/stable-user|fallback-turn-1:0:user');
ctx=boot();
await assert.rejects(()=>append({kind:'retry.planned',operationId:'route-after-native',promptKey:'/c/stable-user',sourceUrl:stableTab.url},stableTab),
 /Автоповтор этого запроса уже запускался/,'an unbound route-only key cannot bypass an earlier native-user claim');
await claimNativeUser('native-second','user-2','/c/stable-user|fallback-turn-1:0:user');
for(const migrated of [false,true]) {
 if(migrated){delete storage['chatgpt-journal:meta'].retrySendClaimSchema;storage['chatgpt-journal:meta'].retrySendClaims={};}
 ctx=boot();
 await assert.rejects(()=>append({kind:'retry.planned',operationId:'fallback-after-native-'+migrated,
  promptKey:'/c/stable-user|fallback-turn-1:0:user',sourceUrl:stableTab.url},{...stableTab,id:93}),
  /Автоповтор этого запроса уже запускался/,'missing native ID must not bypass a consumed same-turn claim');
}
delete storage['chatgpt-journal:meta'].retrySendClaimSchema;
storage['chatgpt-journal:meta'].retrySendClaims={};
ctx=boot();
await assert.rejects(()=>claimNativeUser('native-duplicate','user-1','/c/stable-user|fallback-turn-9:0:user'),
 /Автоповтор этого запроса уже запускался/);

// A positive no-click receipt releases the stable-user claim, not merely the
// transient DOM key. A fresh operation may retry, while the old one stays spent.
const noClickPrompt='/c/stable-user|fallback-turn-3:0:user';
await append({kind:'retry.planned',operationId:'native-refused',retryUserId:'user-refused',promptKey:noClickPrompt,sourceUrl:stableTab.url},stableTab);
await append({kind:'retry.send_intent',operationId:'native-refused',promptKey:noClickPrompt,sourceUrl:stableTab.url},stableTab);
await append({kind:'send.authorized',operationId:'native-refused',sourceUrl:stableTab.url},stableTab);
await append({kind:'send.not_clicked',operationId:'native-refused',promptKey:noClickPrompt,sourceUrl:stableTab.url},stableTab);
await append({kind:'retry.failed',operationId:'native-refused',clicked:false,sourceUrl:stableTab.url},stableTab);
await append({kind:'retry.finished',operationId:'native-refused',clicked:false,confirmed:false,sourceUrl:stableTab.url},stableTab);
ctx=boot();
await assert.rejects(()=>claimNativeUser('native-refused','user-refused',noClickPrompt),/Автоповтор этого запроса уже запускался/);
await claimNativeUser('native-refused-fresh','user-refused',noClickPrompt);

// Schema-1 fallback claims also fence a later positively bound native view.
// A route-only consumed claim cannot be bypassed by revealing the same user
// through a newly mounted server-keyed DOM row. Only a later exact manual
// request, proven across an unbroken journal suffix, can establish a new turn.
{
 const tab={id:96,url:'https://chatgpt.com/c/route-legacy',title:'Fixture'},route='/c/route-legacy';
 for(const kind of ['retry.planned','retry.send_intent','send.authorized'])
  await append({kind,operationId:'old-route',sourceUrl:tab.url,promptKey:route},tab);
 await append({kind:'retry.failed',operationId:'old-route',sourceUrl:tab.url,clicked:true},tab);
 await append({kind:'retry.finished',operationId:'old-route',sourceUrl:tab.url,clicked:true},tab);
 const laterAt=Date.now()+1000,base={kind:'retry.planned',operationId:'later-native',sourceUrl:tab.url,
  promptKey:route+'|server-entry:0:user',retryUserId:'manual-user',requestId:'manual-request',attemptId:String(laterAt)};
 await assert.rejects(()=>append(base,tab),/Автоповтор этого запроса уже запускался/,
  'new DOM key and user ID alone cannot release a legacy route-only unknown send');
 await append({kind:'request.started',sourceUrl:tab.url,requestId:'manual-request',eventAt:laterAt},tab);
 const started=storage['chatgpt-journal:meta'].sequence;
 await append({kind:'retry.preparation_superseded',sourceUrl:tab.url,requestId:'manual-request',startedAt:laterAt},tab);
 const legacyRetryProof={requestId:'manual-request',startedAt:laterAt,userId:'manual-user',requestSequence:started};
 for(const bad of [
  {...legacyRetryProof,userId:'other'}, {...legacyRetryProof,requestId:'other'},
  {...legacyRetryProof,startedAt:laterAt+1}, {...legacyRetryProof,requestSequence:started+1}
 ])await assert.rejects(()=>append({...base,legacyRetryProof:bad},tab),/Автоповтор этого запроса уже запускался/);
 await append({...base,legacyRetryProof},tab);
 await append({kind:'retry.send_intent',operationId:base.operationId,sourceUrl:tab.url,promptKey:base.promptKey,attemptId:base.attemptId,requestId:base.requestId},tab);
 await append({kind:'send.authorized',operationId:base.operationId,sourceUrl:tab.url},tab);
 await append({kind:'retry.confirmed',operationId:base.operationId,sourceUrl:tab.url},tab);
 ctx=boot();
 await assert.rejects(()=>append({...base,operationId:'duplicate-manual',legacyRetryProof},tab),/Автоповтор этого запроса уже запускался/,
  'restart preserves the consumed manual-turn claim');
}
async function routeProofFixture(name:string,fallback=false) {
 const tab={id:97,url:'https://chatgpt.com/c/'+name,title:'Fixture'},route='/c/'+name,at=Date.now()+5000;
 for(const kind of ['retry.planned','retry.send_intent','send.authorized'])
  await append({kind,operationId:name+'-old',sourceUrl:tab.url,promptKey:fallback?route+'|fallback-turn-0:0:user':route},tab);
 await append({kind:'retry.failed',operationId:name+'-old',sourceUrl:tab.url,clicked:true},tab);
 await append({kind:'retry.finished',operationId:name+'-old',sourceUrl:tab.url,clicked:true},tab);
 await append({kind:'request.started',sourceUrl:tab.url,requestId:name+'-manual',eventAt:at},tab);
 const requestSequence=storage['chatgpt-journal:meta'].sequence;
 const event={kind:'retry.planned',operationId:name+'-new',sourceUrl:tab.url,promptKey:route+'|server:0:user',
  retryUserId:'manual-user',requestId:name+'-manual',attemptId:String(at),
  legacyRetryProof:{requestId:name+'-manual',startedAt:at,userId:'manual-user',requestSequence}};
 return {tab,at,event};
}
{
 const f=await routeProofFixture('fallback-to-server',true);
 await assert.rejects(()=>append({...f.event,legacyRetryProof:undefined},f.tab),/Автоповтор этого запроса уже запускался/,
  'revealing a server key cannot bypass a legacy fallback key without a proven new manual request');
 await append({kind:'retry.preparation_superseded',sourceUrl:f.tab.url,requestId:f.event.requestId,startedAt:f.at},f.tab);
 await append(f.event,f.tab);
 await append({...f.event,kind:'retry.send_intent'},f.tab);
 await append({kind:'send.authorized',sourceUrl:f.tab.url,operationId:f.event.operationId},f.tab);
 await append({kind:'retry.confirmed',sourceUrl:f.tab.url,operationId:f.event.operationId},f.tab);
}
{
 const f=await routeProofFixture('route-no-manual-ack');
 await assert.rejects(()=>append(f.event,f.tab),/Автоповтор этого запроса уже запускался/,'an observed POST alone is not a confirmed manual request');
}
{
 const f=await routeProofFixture('route-gap');
 await append({kind:'retry.preparation_superseded',sourceUrl:f.tab.url,requestId:f.event.requestId,startedAt:f.at},f.tab);
 const key='chatgpt-journal:event:'+String(f.event.legacyRetryProof.requestSequence).padStart(12,'0'),saved=storage[key];delete storage[key];
 await assert.rejects(()=>append(f.event,f.tab),/Автоповтор этого запроса уже запускался/,'missing durable journal entry never authorizes a retry');
 storage[key]=saved;
}
{
 const f=await routeProofFixture('route-later-request');
 await append({kind:'retry.preparation_superseded',sourceUrl:f.tab.url,requestId:f.event.requestId,startedAt:f.at},f.tab);
 await append({kind:'request.started',sourceUrl:f.tab.url,requestId:'other',eventAt:f.at+10},{...f.tab,id:98});
 await assert.rejects(()=>append(f.event,f.tab),/Автоповтор этого запроса уже запускался/,'a later request in another tab wins');
}
{
 const f=await routeProofFixture('route-write-failure');
 fail=true;await assert.rejects(()=>append({kind:'request.started',sourceUrl:f.tab.url,requestId:'lost',eventAt:f.at+1},f.tab),/Disk full/);fail=false;
 await append({kind:'retry.preparation_superseded',sourceUrl:f.tab.url,requestId:f.event.requestId,startedAt:f.at},f.tab);
 await assert.rejects(()=>append(f.event,f.tab),/Автоповтор этого запроса уже запускался/,'a recorded prior journal write failure makes manual turn proof ambiguous');
}
{
 const f=await routeProofFixture('route-grant-write-failure');
 await append({kind:'retry.preparation_superseded',sourceUrl:f.tab.url,requestId:f.event.requestId,startedAt:f.at},f.tab);
 await append(f.event,f.tab);await append({...f.event,kind:'retry.send_intent'},f.tab);
 fail=true;await assert.rejects(()=>append({kind:'request.started',sourceUrl:f.tab.url,requestId:'lost',eventAt:f.at+1},f.tab),/Disk full/);fail=false;
 await append({kind:'watcher.started',sourceUrl:f.tab.url},f.tab);
 await assert.rejects(()=>append({kind:'send.authorized',sourceUrl:f.tab.url,operationId:f.event.operationId},f.tab),/Автоповтор этого запроса уже запускался/,'a lost request after intent cannot authorize a grant');
 await append({kind:'send.not_clicked',sourceUrl:f.tab.url,operationId:f.event.operationId,promptKey:f.event.promptKey},f.tab);
 await append({kind:'retry.failed',sourceUrl:f.tab.url,operationId:f.event.operationId,clicked:false},f.tab);
 await append({kind:'retry.finished',sourceUrl:f.tab.url,operationId:f.event.operationId,clicked:false},f.tab);
}
for(const stage of ['reservation','grant'])for(const witness of ['observed','unknown','unrelated']) {
 const f=await routeProofFixture('route-'+stage+'-'+witness);
 await append({kind:'retry.preparation_superseded',sourceUrl:f.tab.url,requestId:f.event.requestId,startedAt:f.at},f.tab);
 if(stage==='grant'){await append(f.event,f.tab);await append({...f.event,kind:'retry.send_intent'},f.tab);}
 const other={id:98,title:'Fixture',url:witness==='observed'?f.tab.url:witness==='unknown'?'https://chatgpt.com/':'https://chatgpt.com/c/unrelated'};
 const sourceUrl=witness==='unknown'?'https://chatgpt.com/':'https://chatgpt.com/c/unrelated';
 await append({kind:'request.started',sourceUrl,requestId:'intervening',eventAt:f.at+1},other);
 const proceed=()=>stage==='grant'?append({kind:'send.authorized',sourceUrl:f.tab.url,operationId:f.event.operationId},f.tab):append(f.event,f.tab);
 if(witness==='unrelated')assert.equal((await proceed()).ok,true,'a fully identified unrelated request remains permitted');
 else await assert.rejects(proceed,/Автоповтор этого запроса уже запускался/,witness+' must invalidate '+stage);
 if(stage==='reservation'&&witness==='unrelated')await append({...f.event,kind:'retry.send_intent'},f.tab);
 if(stage==='grant'||witness==='unrelated'){
  await append({kind:'send.not_clicked',sourceUrl:f.tab.url,operationId:f.event.operationId,promptKey:f.event.promptKey},f.tab);
  await append({kind:'retry.failed',sourceUrl:f.tab.url,operationId:f.event.operationId,clicked:false},f.tab);
  await append({kind:'retry.finished',sourceUrl:f.tab.url,operationId:f.event.operationId,clicked:false},f.tab);
 }
}
{
 const f=await routeProofFixture('route-grant-race');
 await append({kind:'retry.preparation_superseded',sourceUrl:f.tab.url,requestId:f.event.requestId,startedAt:f.at},f.tab);
 await append(f.event,f.tab);
 await append({...f.event,kind:'retry.send_intent'},f.tab);
 await append({kind:'request.started',sourceUrl:f.tab.url,requestId:'newer',eventAt:f.at+10},{...f.tab,id:98});
 await assert.rejects(()=>append({kind:'send.authorized',sourceUrl:f.tab.url,operationId:f.event.operationId},f.tab),/Автоповтор этого запроса уже запускался/,
  'a newer request arriving after intent blocks the final send grant');
}
{
 const legacyTab={id:94,url:'https://chatgpt.com/c/legacy-fallback',title:'Test'},promptKey='/c/legacy-fallback|fallback-turn-1:0:user';
 for(const kind of ['retry.planned','retry.send_intent','send.authorized','retry.confirmed'])
  await append({kind,operationId:'legacy-fallback-send',sourceUrl:legacyTab.url,promptKey},legacyTab);
 storage['chatgpt-journal:meta'].retrySendClaimSchema=1;
 storage['chatgpt-journal:meta'].retrySendClaims={};ctx=boot();
 await assert.rejects(()=>append({kind:'retry.planned',operationId:'native-after-legacy',sourceUrl:legacyTab.url,
  promptKey,retryUserId:'now-known-user'},{...legacyTab,id:95}),/Автоповтор этого запроса уже запускался/);
 const consumed=storage['chatgpt-journal:meta'].retrySendClaims[JSON.stringify([legacyTab.url,promptKey])];
 assert.equal(consumed.sourceUrl,legacyTab.url);assert.equal(consumed.promptKey,promptKey);assert.equal(consumed.retryUserId,null);
 assert.equal(storage['chatgpt-journal:meta'].retrySendClaimSchema,2);
}
