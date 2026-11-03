import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
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
const {inspectCompletedTurn}=require('../extension/completion-probe.js') as {inspectCompletedTurn:(url:string,includeGoalText?:boolean)=>Record<string,unknown>};
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
 assert.equal(native.firstTurn,false);assert.equal(native.firstUserSentAtMs,null,'a later turn cannot masquerade as allocation evidence');
 element.__reactFiber$fixture.memoizedProps.entries.splice(0,1);
 Object.assign(last,{timestampTurns:[{role:'user',sentAtMs:100000}]});
 const first=inspectCompletedTurn('https://chatgpt.com/c/exact');
 assert.equal(first.firstTurn,true);assert.equal(first.firstUserSentAtMs,100000);

 last.turn.status='in_progress';
 const unfinished=inspectCompletedTurn('https://chatgpt.com/c/exact');
 assert.equal(unfinished.turnStatus,'in_progress');
 assert.equal(completedAttemptEvidence({...attempt,promptKey:unfinished.promptKey},{...unfinished,attemptId:attempt.id}),null);
 assert.equal(inspectCompletedTurn('https://chatgpt.com/c/other').ok,false);
}finally{globals.document=before.document;globals.location=before.location;}
console.log('stuck-loader native latest-turn binding: passed');

// Goal reads only the already-sent latest native message, with an explicit
// opt-in. Composer drafts and interface speaker/feedback labels are unrelated.
{
 const {document}=parseHTML(`<html><body><section data-app-shell-active-page="true">
  <article data-content-search-turn-key="latest-turn">
   <div data-chatgpt-search-unit-key="latest-turn:0:user">Rendered sent request</div>
   <article data-chatgpt-search-unit-key="latest-turn:2:assistant">
    <h4 class="sr-only" data-conversation-role="assistant"><span>ChatGPT сказал:</span><span aria-hidden="true">ChatGPT</span></h4>
    <div data-markdown-text-style="assistant-message"><div class="markdown"><p>GOAL_COMPLETE</p></div></div>
    <button aria-label="Copy">Copy</button><button aria-label="Good response">Good response</button>
   </article>
  </article><form data-composer-body><textarea id="prompt-textarea">UNSENT PRIVATE DRAFT</textarea></form>
 </section></body></html>`);
 const nativeUser={type:'user-message',messageId:'latest-user-id',message:'  Sent goal instruction\nwith exact whitespace  '};
 const nativeAssistant={type:'assistant-message',messageId:'latest-assistant-id',phase:'final_answer',completed:true,content:'GOAL_COMPLETE',
  contentReferences:[] as {model_dil_v2?:{fallbackMarkdown?:string}}[]};
 const latest={id:'latest-turn',isMostRecentTurn:true,isReadOnly:false,errorMessage:null,
  timestampTurns:[{role:'user',sentAtMs:100000},{role:'assistant',sentAtMs:100001},{role:'user',sentAtMs:100002}],
  turn:{status:'complete',items:[nativeUser,nativeAssistant]}};
 const element=document.querySelector('[data-content-search-turn-key]')!;
 (element as unknown as Record<string,unknown>).__reactFiber$fixture={memoizedProps:{entries:[{...latest,id:'older-turn'},latest]},return:null};
 const saved={document:globals.document,location:globals.location};
 globals.document=document;globals.location={origin:'https://chatgpt.com',pathname:'/c/exact'};
 try {
  const metadata=inspectCompletedTurn(attempt.url);
  for(const key of ['userText','userSentAtMs','goalResponse','goalRawExact'])assert.equal(Object.hasOwn(metadata,key),false,'default snapshot remains metadata only');
  assert.deepEqual(inspectCompletedTurn(attempt.url,false),metadata);
  const goal=inspectCompletedTurn(attempt.url,true);
  assert.equal(goal.userText,nativeUser.message,'native sent text preserves whitespace and excludes the composer draft');
  assert.equal(goal.userSentAtMs,100002,'latest user timestamp is exposed even after the first turn');
  assert.equal(goal.firstUserSentAtMs,null,'first-turn allocation evidence is unchanged');
  assert.equal(goal.goalResponse,'GOAL_COMPLETE');assert.equal(goal.goalRawExact,true,'speaker heading and feedback are interface content');
  const rendered=document.querySelector('[data-markdown-text-style]')!;
  const reference='::chatgpt-content-reference{index="0" source_message_id="latest-assistant-id"}';
  nativeAssistant.content=reference;
  nativeAssistant.contentReferences=[{model_dil_v2:{fallbackMarkdown:'GOAL_COMPLETE'}}];
  const referenced=inspectCompletedTurn(attempt.url,true);
  assert.equal(referenced.goalResponse,'GOAL_COMPLETE','a whole native reference resolves to its complete fallback Markdown');
  assert.equal(referenced.goalRawExact,true,'plain exact rendered marker agrees with complete native fallback');
  nativeAssistant.contentReferences=[{model_dil_v2:{fallbackMarkdown:'GOAL\\_COMPLETE'}}];
  const escaped=inspectCompletedTurn(attempt.url,true);
  assert.equal(escaped.goalResponse,'GOAL_COMPLETE','native DIL Markdown may escape the one literal underscore');
  assert.equal(escaped.goalRawExact,true,'escaped native serialization still requires the plain exact rendered marker');
  nativeAssistant.content='GOAL\\_COMPLETE';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'normalization applies only to a whole native DIL reference');
  nativeAssistant.content=reference;
  for(const content of [reference+'\nStill working','Before '+reference,'`'+reference+'`',' '+reference]) {
   nativeAssistant.content=content;
   assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'text or Markdown outside a reference cannot be discarded');
  }
  nativeAssistant.content=reference;
  for(const references of [[],[{}],[{model_dil_v2:{fallbackMarkdown:'GOAL_COMPLETE'}},{}],
   [{model_dil_v2:{fallbackMarkdown:'`GOAL_COMPLETE`'}}],
   [{model_dil_v2:{fallbackMarkdown:'`GOAL\\_COMPLETE`'}}],
   [{model_dil_v2:{fallbackMarkdown:'GOAL\\_COMPLETE\nStill working'}}],
   [{model_dil_v2:{fallbackMarkdown:'GOAL_COMPLETE\nStill working'}}],
   [{model_dil_v2:{fallbackMarkdown:'GOAL_COMPLETE'}},{model_dil_v2:{fallbackMarkdown:'More native content'}}]]) {
   nativeAssistant.contentReferences=references;
   assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'missing references, Markdown and additional fallback content cannot complete a goal');
  }
  nativeAssistant.contentReferences=[{model_dil_v2:{fallbackMarkdown:'GOAL\\_COMPLETE'}}];
  for(const content of ['<p><code>GOAL_COMPLETE</code></p>','<pre>GOAL_COMPLETE</pre>','<p><strong>GOAL_COMPLETE</strong></p>','<p>GOAL_COMPLETE</p><p>Still working</p>']) {
   rendered.innerHTML=content;assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'non-plain or additional rendered answer text cannot complete a goal');
  }
  rendered.innerHTML='<p>GOAL_COMPLETE</p>';
  nativeAssistant.content='GOAL_COMPLETE\nStill working';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'native whole answer must also be exactly the marker');
  nativeAssistant.content='GOAL_COMPLETE';
  const extra=document.createElement('p');extra.textContent='Additional assistant answer';rendered.after(extra);
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'assistant content outside the first markdown node still disqualifies completion');
 } finally {globals.document=saved.document;globals.location=saved.location;}
}
console.log('Native Goal opt-in sent text, latest timestamp and exact plain marker: passed');

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
