import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {completedAttemptEvidence}=require('../extension/completion-state.js') as {
 completedAttemptEvidence:(attempt:Record<string,unknown>,snapshot:Record<string,unknown>)=>null|Record<string,string>;
};
// Regression: a failed/open transport must not hide an independently completed
// current answer, and a previous completed turn must never complete a new send.
const attempt={id:'request-2',promptKey:'user-2',url:'https://chatgpt.com/c/exact'};
const complete={url:attempt.url,attemptId:attempt.id,promptKey:'user-2',isLatest:true,
 isReadOnly:false,generating:false,hasError:false,turnStatus:'complete',
 assistantKey:'assistant-2',assistantCompleted:true,assistantPhase:'final_answer'};
assert.deepEqual(completedAttemptEvidence(attempt,complete),
 {attemptId:'request-2',promptKey:'user-2',assistantKey:'assistant-2'});
for(const change of [{promptKey:'user-1'},{attemptId:'request-1'},{isLatest:false},
 {turnStatus:'in_progress'},{generating:true},{hasError:true},{assistantCompleted:false},
 {assistantPhase:'commentary'},{url:'https://chatgpt.com/c/other'}]) {
 assert.equal(completedAttemptEvidence(attempt,{...complete,...change}),null);
}
assert.equal(completedAttemptEvidence({...attempt,promptKey:''},complete),null);
console.log('stuck-loader completion evidence: passed');

// Native probe regression: the completed older turn must not conceal a latest
// unfinished turn, even when there is no visible Stop button.
const {inspectCompletedTurn}=require('../extension/completion-probe.js') as {inspectCompletedTurn:(url:string)=>Record<string,unknown>};
const last={id:'fallback-turn-2',isMostRecentTurn:true,isReadOnly:false,errorMessage:null,
 turn:{status:'complete',items:[{type:'user-message',messageId:'user-id'},
 {type:'assistant-message',messageId:'assistant-id',phase:'final_answer',completed:true}]}};
const node=(key:string)=>({getAttribute:(name:string)=>name==='data-chatgpt-search-unit-key'?key:null});
const element={getAttribute:(name:string)=>name==='data-content-search-turn-key'?'fallback-turn-2':null,
 querySelectorAll:(selector:string)=>[node(selector.includes(':user')?'fallback-turn-2:0:user':'fallback-turn-2:2:assistant')],
 __reactFiber$fixture:{memoizedProps:{entries:[{...last,id:'fallback-turn-1'},last]},return:null}};
const root={querySelectorAll:(selector:string)=>selector.startsWith('[data-content-search-turn-key]')?[element]:[]};
const globals=globalThis as unknown as Record<string,unknown>;
const before={document:globals.document,location:globals.location};
globals.location={origin:'https://chatgpt.com',pathname:'/c/exact'};
globals.document={querySelector:()=>root};
try{
 const native=inspectCompletedTurn('https://chatgpt.com/c/exact');
 assert.equal(native.turnStatus,'complete');assert.equal(native.assistantCompleted,true);
 assert.equal(native.promptKey,'/c/exact|fallback-turn-2:0:user');
 last.turn.status='in_progress';
 const unfinished=inspectCompletedTurn('https://chatgpt.com/c/exact');
 assert.equal(unfinished.turnStatus,'in_progress');
 assert.equal(completedAttemptEvidence({...attempt,promptKey:unfinished.promptKey},{...unfinished,attemptId:attempt.id}),null);
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/other').ok,false);
}finally{globals.document=before.document;globals.location=before.location;}
console.log('stuck-loader native latest-turn binding: passed');

const {bindAttemptPrompt}=require('../extension/completion-state.js') as {
 bindAttemptPrompt:(attempt:Record<string,unknown>,snapshot:Record<string,unknown>)=>null|Record<string,unknown>;
};
const pending={id:'request-2',url:attempt.url,baselineKey:'user-1'};
const observe={attemptId:'request-2',url:attempt.url,promptKey:'user-1'};
assert.equal(bindAttemptPrompt(pending,observe),null);
const bound=bindAttemptPrompt(pending,{...observe,promptKey:'user-2'});
assert.equal(bound?.promptKey,'user-2');
assert.equal(bindAttemptPrompt(bound!,{...observe,promptKey:'user-3'}),null);
assert.equal(bindAttemptPrompt(pending,{...observe,attemptId:'request-1',promptKey:'user-2'}),null);
assert.equal(bindAttemptPrompt({...pending,baselineKey:undefined},{...observe,promptKey:'user-2'}),null);
console.log('stuck-loader new-user attempt binding: passed');
