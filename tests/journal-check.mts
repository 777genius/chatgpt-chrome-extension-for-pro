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
