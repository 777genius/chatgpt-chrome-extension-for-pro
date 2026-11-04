import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/service-worker.js','utf8');
const code=source.slice(source.indexOf('const retryReadinessRecoveries=new Map();'),source.indexOf('const goalAckProofs=new Map();'));
const url='https://chatgpt.com/c/retry-readiness-fixture',promptKey='/c/retry-readiness-fixture|user-1',attemptId='1000000';
const baseState={reason:'native-not-ready',blocked:true,blockedAttemptId:attemptId,lastAttemptId:attemptId,lastPromptKey:promptKey,failures:[999999],recentErrors:[{at:999999}],sameErrorCount:1};
async function fixture(extra:any={}) {
 let state:any={...structuredClone(baseState),...extra.state},writes=0,calls=0,goalCalls=0;
 const events:any[]=[{kind:'retry.planned',operationId:'op',sourceUrl:url,tabId:7,retryUserId:'user',promptKey,attemptId,requestId:'request',recordedAt:1000100},
  ...(extra.cleanupOnly?[]:[{kind:'retry.send_intent',operationId:'op'},{kind:'send.authorized',operationId:'op'}]),
  ...(extra.noRefusal?[]:[{kind:'send.not_clicked',operationId:'op'}]),
  {kind:extra.cleanupOnly?'draft.restore_failed':'retry.failed',sourceUrl:url,tabId:7,operationId:'op',attemptId,error:'native-not-ready',clicked:extra.cleanupOnly?undefined:extra.clicked??false},
  {kind:'retry.finished',operationId:'op',clicked:false},...(extra.events||[])];
 const native={ok:true,isLatest:true,isReadOnly:false,hasError:true,userId:'user',promptKey,lastUserSentAtMs:999990,...extra.native};
 const appendJournal=async(e:any)=>{writes++;state={...state,blocked:false,preparationRecovered:true};events.push(e);};
 const chrome={tabs:{get:async()=>({url:extra.url||url,status:extra.status||'complete'})},scripting:{executeScript:async(o:any)=>{
  calls++;
  if(o.func===inspectCompletedTurn)return [{result:native}];
  if(o.func===inspectChatError)return [{result:{action:extra.action||'retry'}}];
  if(o.func===controlChatComposer)return [{result:{ok:extra.empty!==false}}];
  return [{result:{attemptId:extra.runtimeAttempt||attemptId,requestId:'request'}}];
 }}};
 function inspectCompletedTurn(){}function inspectChatError(){}function controlChatComposer(){}
 const fn=new Function('readRetryState','readRetryDraft','readJournal','chrome','goalController','inspectCompletedTurn','inspectChatError','controlChatComposer','appendJournal','completionCheckpointRead','inspectBoundNativeTurn',
  code+';return recoverNoClickRetry;')(
  async()=>structuredClone(state),async()=>extra.draftRecord|| (extra.draft?{draft:'owner'}:null),async()=>({ok:true,storageError:'',events}),chrome,
  {get:async()=>extra.goal||null,retry:async()=>{goalCalls++;}},inspectCompletedTurn,inspectChatError,controlChatComposer,appendJournal,async()=>({state:'active',url,promptKey,startedAt:1000000,requestId:'request',httpCompleted:extra.httpCompleted!==false}),async()=>native);
 const result=await fn(7,url);return {result,writes,calls,goalCalls,fn};
}
const safe=await fixture();assert.equal(safe.writes,1);assert.equal(safe.result.blocked,false);
await safe.fn(7,url);assert.equal(safe.result.preparationRecovered,true);
for(const extra of [{clicked:true},{noRefusal:true},{draft:true},{empty:false},{status:'unloaded'},
 {state:{reason:'budget exhausted'}},{state:{terminal:true}},{state:{remainingRetries:0}},{state:{preparationRecoveries:2}},
 {native:{userId:'different-user'}},{native:{hasError:false}},{native:{isLatest:false}},{native:{isReadOnly:true}},{native:{lastUserSentAtMs:500000}},
 {native:{promptKey:'other'}},{runtimeAttempt:'2000000'},{action:'new-chat'},
 {goal:{phase:'stopped'}},{goal:{phase:'paused'}},{goal:{phase:'blocked',operation:{status:'clicked'}}},
 {events:[{kind:'send.dispatched',operationId:'op'}]},
 {events:[{kind:'request.started',operationId:'other',sourceUrl:url,tabId:8,recordedAt:1000200}]},
 {events:[{kind:'retry.failed',sourceUrl:url,tabId:8,operationId:'unknown',attemptId,clicked:true}]},
 {events:[{kind:'draft.restore_failed',sourceUrl:url,tabId:7,operationId:'op',attemptId}]}]) {
 const test=await fixture(extra);assert.equal(test.writes,0,JSON.stringify(extra));
}
const emptyTerminal={hasError:false,terminalEmptyResponse:true,nativeConversationInactive:true};
assert.equal((await fixture({cleanupOnly:true,native:emptyTerminal})).writes,1,'no-click own-text cleanup may recover a verified empty terminal response');
assert.equal((await fixture({cleanupOnly:true,native:emptyTerminal,httpCompleted:false})).writes,0);
assert.equal((await fixture({cleanupOnly:true,native:emptyTerminal,events:[{kind:'draft.saved',operationId:'op'}]})).writes,0,'an historical owner draft remains fenced');
assert.equal((await fixture({cleanupOnly:true,native:{hasError:true}})).writes,0);
// Real reducer preserves historical failures/limits and makes the grant one-use.
const ctx=createContext({URL,Date});runInContext(readFileSync('extension/journal-store.js','utf8'),ctx);
ctx.state={[new URL(url).pathname.split('/').at(-1)!]:{...baseState,remainingRetries:2}};
ctx.event={kind:'retry.preparation_recovered',sourceUrl:url,promptKey,attemptId,preparationDraftOperationId:'op',preparationDraftSequence:12};
const recovered=runInContext('reduceRetrySummary(state,event)',ctx)[new URL(url).pathname.split('/').at(-1)!];
assert.equal(recovered.blocked,false);assert.equal(recovered.remainingRetries,2);
assert.deepEqual(recovered.failures,baseState.failures);assert.equal(recovered.preparationRecoveries,1);
assert.equal(recovered.preparationDraftOperationId,'op');assert.equal(recovered.preparationDraftSequence,12);
ctx.state={fixture:1,[new URL(url).pathname.split('/').at(-1)!]:recovered};
ctx.event={kind:'retry.planned',sourceUrl:url,operationId:'fresh'};
const planned=runInContext('reduceRetrySummary(state,event)',ctx)[new URL(url).pathname.split('/').at(-1)!];
assert.equal(planned.preparationRecovered,false);assert.equal(planned.remainingRetries,1);
console.log('No-click retry recovery: exact native/journal proof; unknown sends, cross-tab failures, drafts, Stop and budgets remain fenced.');

const carry={operationId:'op',attemptId,phase:'not-clicked',savedSequence:12,draft:'Synthetic owner draft'};
assert.equal((await fixture({draftRecord:carry,native:{generating:false,nativeConversationInactive:true}})).writes,1,'proven no-click backup is carried into the same protected retry');
for(const draftRecord of [{...carry,phase:'unknown'},{...carry,claimedAt:1},{...carry,operationId:'other'},{...carry,attemptId:'other'}])
 assert.equal((await fixture({draftRecord,native:{generating:false,nativeConversationInactive:true}})).writes,0);
assert.equal((await fixture({draftRecord:carry,native:{generating:true,nativeConversationInactive:true}})).writes,0);

ctx.state={[new URL(url).pathname.split('/').at(-1)!]:recovered};ctx.event={kind:'retry.confirmed',sourceUrl:url};
assert.equal(runInContext('reduceRetrySummary(state,event)',ctx)[new URL(url).pathname.split('/').at(-1)!].preparationDraftOperationId,null,'a confirmed retry retires the carry reference');
