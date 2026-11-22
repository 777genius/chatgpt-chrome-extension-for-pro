import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('extension/service-worker.js','utf8');
const start=source.indexOf('function proveLegacyNoClickRoute('),end=source.indexOf('// A late native message',start);
assert.ok(start>0&&end>start);
const prove=new Function(source.slice(start,end)+';return proveLegacyNoClickRoute;')();
const url='https://chatgpt.com/c/fixture',path='/c/fixture',prompt=path+'|server:0:user';
function fixture(){return{url,tabId:7,planned:{promptKey:path,requestId:'req',attemptId:'1000'},
 native:{ok:true,isLatest:true,isReadOnly:false,generating:false,hasError:true,userId:'user',promptKey:prompt,lastUserSentAtMs:1001},
 checkpoint:{state:'active',url,requestId:'req',startedAt:1000,promptKey:prompt,requestFailedAt:1002},
 receipt:{requestId:'req',startedAt:1000,url,submittedUserId:'user'},
 journal:{ok:true,meta:{sequence:13},events:[{kind:'request.started',tabId:7,sourceUrl:url,requestId:'req',eventAt:1000,sequence:11},{kind:'request.failed',tabId:7,requestId:'req',eventAt:1002,sequence:12},{kind:'retry.finished',sequence:13}]},
 state:{blocked:true,terminal:false,blockedAttemptId:'1000',lastPromptKey:path},delivery:{action:'retry',deliveryUserSentAtMs:1001}};}
assert.deepEqual(prove(fixture()),{expectedSequence:13,oldPromptKey:path,newPromptKey:prompt});
{const x=fixture();x.state.lastPromptKey=prompt;assert.equal(prove(x).oldPromptKey,prompt,'already-remounted summary remains eligible');}
function rootFixture():any {
 const x:any=fixture();x.receipt.url='';x.journal.events[0].sourceUrl='https://chatgpt.com/';
 x.journal.events[1]={kind:'request.failed',tabId:7,requestId:'req',eventAt:1002,sequence:12};
 x.journal.events[2]={kind:'goal.manual_started',tabId:7,sourceUrl:url,composerSourceUrl:'https://chatgpt.com/',goalId:'goal',requestId:'req',startedAt:1000,userId:'user',promptKey:prompt,sequence:13};
 x.journal.events.push({kind:'completion.url_allocated',tabId:7,sourceUrl:url,requestId:'req',attemptId:'1000',promptKey:prompt,sequence:14});x.journal.meta.sequence=14;
 x.goal={id:'goal',expectedPromptKey:prompt,manualStart:{tabId:7,url,sourceUrl:'https://chatgpt.com/',requestId:'req',startedAt:1000,userId:'user',promptKey:prompt}};
 return x;
}
assert.ok(prove(rootFixture()),'root POST is allowed only with exact manual Goal and allocated-chat lineage');
for(const mutate of [(x:any)=>x.receipt.url='https://chatgpt.com/c/other', (x:any)=>x.goal.id='other',
 (x:any)=>x.goal.manualStart.userId='other',(x:any)=>x.goal.expectedPromptKey=path,
 (x:any)=>x.journal.events[2].composerSourceUrl=url,(x:any)=>x.journal.events[2].tabId=8,
 (x:any)=>x.journal.events[3].requestId='other',(x:any)=>x.journal.events[1].eventAt=1003,
 (x:any)=>{x.journal.events.push({...x.journal.events[3],sequence:15});x.journal.meta.sequence=15;}]) {
 const x=rootFixture();mutate(x);assert.equal(prove(x),null,'ambiguous root allocation cannot authorize recovery');
}
for(const mutate of [
 (x:any)=>x.native.generating=true,(x:any)=>x.native.isLatest=false,(x:any)=>x.native.isReadOnly=true,
 (x:any)=>x.native.hasError=false,(x:any)=>x.receipt.submittedUserId='other',
 (x:any)=>x.receipt.requestId='other',(x:any)=>x.checkpoint.requestFailedAt=undefined,
 (x:any)=>x.checkpoint.promptKey=path,(x:any)=>x.delivery.deliveryUserSentAtMs=1002,
 (x:any)=>x.state.terminal=true,(x:any)=>x.state.blocked=false,(x:any)=>x.state.lastPromptKey='other',
 (x:any)=>x.journal.events[1].requestId='other',(x:any)=>x.journal.events[1].eventAt=1003,
 (x:any)=>x.journal.events.splice(1,1),
 (x:any)=>{x.journal.events.push({kind:'request.started',sourceUrl:url,tabId:8,sequence:14});x.journal.meta.sequence=14;},
 (x:any)=>x.journal.events[0].operationId='automatic'
]){const x=fixture();mutate(x);assert.equal(prove(x),null,'ambiguous request, unfinished answer or changed journal must not recover');}
console.log('Legacy no-click route recovery: exact receipt, native delivery failure, writable latest turn and contiguous request tail are required.');
