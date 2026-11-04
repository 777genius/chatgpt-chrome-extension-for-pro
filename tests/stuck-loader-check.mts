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
const element={closest:()=>null,getAttribute:(name:string)=>name==='data-content-search-turn-key'?'fallback-turn-2':null,
 querySelectorAll:(selector:string)=>selector.startsWith('aside')||selector.includes('data-automation-card')?[]:[node(selector.includes(':user')?'fallback-turn-2:0:user':'fallback-turn-2:2:assistant')],
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
 const {document,window}=parseHTML(`<html><body><section data-app-shell-active-page="true">
  <article data-content-search-turn-key="latest-turn">
   <div data-chatgpt-search-unit-key="latest-turn:0:user" data-chatgpt-search-message-ids="latest-user-id"><h4 class="sr-only" data-conversation-role="user">You said:</h4><div data-user-message-bubble="true"><div data-search-result-target><div><div class="whitespace-pre-wrap" dir="auto">Rendered sent request</div></div></div></div><button>Copy request</button></div>
   <article data-chatgpt-search-unit-key="latest-turn:2:assistant">
    <h4 class="sr-only" data-conversation-role="assistant"><span>ChatGPT сказал:</span><span aria-hidden="true">ChatGPT</span></h4>
    <div data-markdown-text-style="assistant-message"><div class="markdown"><p>GOAL_COMPLETE</p></div></div>
    <button aria-label="Copy">Copy</button><button aria-label="Good response">Good response</button>
   </article>
  </article><form data-composer-body><textarea id="prompt-textarea">UNSENT PRIVATE DRAFT</textarea></form>
 </section></body></html>`);
 Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
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
  const normalTurn=latest.turn;
  latest.turn={status:'cancelled',items:[nativeUser,{type:'chatgpt-reasoning-group'}] as typeof normalTurn.items};
  assert.equal(inspectCompletedTurn(attempt.url).reasoningFailed,true);
  latest.turn={...latest.turn,status:'complete'};
  assert.equal(inspectCompletedTurn(attempt.url).reasoningFailed,false);
  latest.turn={status:'cancelled',items:[nativeUser,nativeAssistant]};
  assert.equal(inspectCompletedTurn(attempt.url).reasoningFailed,false);
  latest.turn=normalTurn;
  const historicalError=document.createElement('aside');
  historicalError.setAttribute('role','alert');historicalError.className='text-danger';
  historicalError.innerHTML='<span class="text-chatgpt-recovery">Historical failed request</span>';
  element.before(historicalError);
  assert.equal(inspectCompletedTurn(attempt.url).hasError,false,'a retained older error cannot block the latest healthy final answer');
  element.append(historicalError);
  assert.equal(inspectCompletedTurn(attempt.url).hasError,true,'a visible error inside the latest turn still blocks completion');
  historicalError.remove();
  const metadata=inspectCompletedTurn(attempt.url);
  for(const key of ['userText','userVisibleText','userSentAtMs','goalResponse','goalRawExact'])assert.equal(Object.hasOwn(metadata,key),false,'default snapshot remains metadata only');
  assert.deepEqual(inspectCompletedTurn(attempt.url,false),metadata);
  const goal=inspectCompletedTurn(attempt.url,true);
  assert.equal(goal.userText,nativeUser.message,'native sent text preserves whitespace and excludes the composer draft');
  assert.equal(goal.userSentAtMs,100002,'latest user timestamp is exposed even after the first turn');
  assert.equal(goal.firstUserSentAtMs,null,'first-turn allocation evidence is unchanged');
  assert.equal(goal.goalResponse,'GOAL_COMPLETE');assert.equal(goal.goalRawExact,true,'speaker heading and feedback are interface content');
  assert.equal(goal.userVisibleText,'Rendered sent request','sent body excludes speaker and copy controls');
  const summaryRendered=document.querySelector('[data-markdown-text-style="assistant-message"], .markdown')!;
  const savedSummaryHTML=summaryRendered.innerHTML;
  const savedSummaryContent=nativeAssistant.content;
  nativeAssistant.content='GOAL_BLOCKED';
  summaryRendered.innerHTML='<p>GOAL_BLOCKED</p>';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,true,'native blocked marker uses exact plain envelope');
  for(const html of ['<p>GOAL_BLOCKED не выдаю.</p>','<p><code>GOAL_BLOCKED</code></p>','<p>GOAL_BLOCKED</p><p>Reason</p>']) {
    summaryRendered.innerHTML=html;
    assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'discussion and formatting never block a Goal');
  }
  nativeAssistant.content='GOAL\\_COMPLETE\n\nИтог\\:\n\n\\- Вычислено 2+2 = 4.';
  summaryRendered.innerHTML='<p>GOAL_COMPLETE</p><p>Итог:</p><ul><li>Вычислено 2+2 = 4.</li></ul>';
  const summary=inspectCompletedTurn(attempt.url,true);
  assert.equal(summary.goalResponse,'GOAL_COMPLETE');
  assert.equal(summary.goalRawExact,true,'native escaped summary with separately rendered marker completes');
  summaryRendered.innerHTML='<p><code>GOAL_COMPLETE</code></p><p>Итог:</p><ul><li>Вычислено 2+2 = 4.</li></ul>';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'quoted code cannot complete a goal');
  const detailedBullets=[
    'Implemented the requested catalog and independent filters, verified the changes and merged '+
      '[catalog change](https://example.invalid/catalog/pull/42) and [registry change](https://example.invalid/registry/pull/57). '+
      'Every entry now appears by default and the two independent filters remain available through the options dialog.',
    'Completed the production validation chain with '+
      '[scan and progress publication](https://example.invalid/actions/runs/1001) followed by '+
      '[the deployed site verification](https://example.invalid/actions/runs/1002).\n'+
      '  Required checks and the production deployment completed successfully.',
    'Recorded the verification snapshot and its remaining coverage limits in the reviewed changes.\n\n'+
      '  The task is complete and its waiting automation was disabled.'
  ];
  assert.ok(detailedBullets[0].length>240,'regression fixture exceeds the old per-bullet limit');
  const detailedSummary='GOAL_COMPLETE\n\nИтог:\n\n'+detailedBullets.map(text=>'- '+text).join('\n\n');
  const summaryReference='::chatgpt-content-reference{index="0" source_message_id="latest-assistant-id"}';
  nativeAssistant.content=summaryReference;
  nativeAssistant.contentReferences=[{model_dil_v2:{fallbackMarkdown:detailedSummary.replace(/[_:\-]/g,'\\$&')}}];
  summaryRendered.innerHTML='<p>GOAL_COMPLETE</p><p>Итог:</p><ul>'+detailedBullets.map(text=>'<li>'+text+'</li>').join('')+'</ul>';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,true,
    'three long linked DIL summary bullets with wrapped lines and blank paragraphs complete the goal');
  assert.equal(inspectCompletedTurn(attempt.url,true).goalResponse,'GOAL_COMPLETE');
  summaryRendered.innerHTML='<p dir="auto"><span>GOAL_COMPLETE</span></p><p><span>Итог:</span></p><ul><li>Completed <a href="https://example.invalid/result">verification</a>.</li></ul>';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,true,'native paragraph renderer uses a neutral text-only span');
  for(const inner of ['<code>GOAL_COMPLETE</code>','<a href="https://example.invalid">GOAL_COMPLETE</a>','<strong>GOAL_COMPLETE</strong>']) {
    summaryRendered.innerHTML='<p><span>'+inner+'</span></p><p>Итог:</p><ul><li>Quoted only</li></ul>';
    assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'rich marker inside a neutral span does not declare completion');
  }
  summaryRendered.innerHTML='<p>GOAL_COMPLETE</p><p>Итог:</p><ul><li>Verified summary</li></ul>';
  for(const body of [detailedSummary.replace('GOAL_COMPLETE','`GOAL_COMPLETE`'),
    detailedSummary.replace('GOAL_COMPLETE','> GOAL_COMPLETE'),
    'Example:\n\n'+detailedSummary]) {
    nativeAssistant.contentReferences=[{model_dil_v2:{fallbackMarkdown:body}}];
    assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'quoted or embedded native marker does not declare completion');
  }
  nativeAssistant.contentReferences=[{model_dil_v2:{fallbackMarkdown:detailedSummary}}];
  summaryRendered.innerHTML='<blockquote><p>GOAL_COMPLETE</p></blockquote><p>Итог:</p><ul><li>Quoted only</li></ul>';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'a rendered quoted marker cannot corroborate completion');
  nativeAssistant.contentReferences=[];
  nativeAssistant.content=savedSummaryContent;
  summaryRendered.innerHTML=savedSummaryHTML;

  const userUnit=document.querySelector('[data-chatgpt-search-unit-key$=":user"]')!;
  const userBody=userUnit.querySelector('.whitespace-pre-wrap')!;
  nativeUser.message='  Read [Project](https://example.invalid/path) now  \nSecond\nline';
  userBody.innerHTML='<p>  Read <span data-rich-text-generated-autolink><a href="https://example.invalid/path">Project</a><span aria-hidden="true">Link preview label<svg></svg></span></span> now  </p><p>Second<br>line</p><span hidden>Hidden rich widget</span><button>Open link</button><span class="ProseMirror-widget">Widget</span><span data-testid="attachment-chip">Private attachment label</span>';
  Object.defineProperty(window,'getComputedStyle',{value:(node:Element)=>({
    display:node.classList.contains('css-hidden')?'none':node.classList.contains('contents-wrapper')?'contents':'block',
    visibility:node.classList.contains('css-invisible')?'hidden':'visible'
  }),configurable:true});
  userBody.insertAdjacentHTML('beforeend','<span class="css-hidden">CSS-only hidden label</span><span class="css-invisible">Invisible label</span>');
  userBody.querySelector('a')!.parentElement!.classList.add('contents-wrapper');
  const linked=inspectCompletedTurn(attempt.url,true);
  assert.equal(linked.userText,nativeUser.message,'native Markdown retains its destination URL');
  assert.equal(linked.userVisibleText,'  Read Project now  \nSecond\nline','sent rich link labels preserve display:contents text and exclude computed-hidden descendants using their mounted originals');
  userUnit.setAttribute('data-chatgpt-search-message-ids','different-native-user');
  assert.equal(inspectCompletedTurn(attempt.url,true).userVisibleText,null,'conflicting native message ID cannot prove visible text');
  userUnit.setAttribute('data-chatgpt-search-message-ids','latest-user-id different-native-user');
  assert.equal(inspectCompletedTurn(attempt.url,true).userVisibleText,null,'multiple native message IDs cannot prove one sent body');
  userUnit.setAttribute('data-chatgpt-search-unit-key','latest-turn:1:user');
  userUnit.setAttribute('data-chatgpt-search-message-ids','latest-user-id');
  assert.equal(inspectCompletedTurn(attempt.url,true).userVisibleText,linked.userVisibleText,'exact native message-ID metadata independently binds the sent body');
  userUnit.removeAttribute('data-chatgpt-search-message-ids');
  userUnit.setAttribute('data-chatgpt-search-unit-key','latest-turn:1:user');
  assert.equal(inspectCompletedTurn(attempt.url,true).userVisibleText,null,'unit position must identify the exact latest native user item');
  userUnit.setAttribute('data-chatgpt-search-unit-key','latest-turn:0:user');
  userBody.removeAttribute('class');
  assert.equal(inspectCompletedTurn(attempt.url,true).userVisibleText,null,'unknown body markup never falls back to whole-turn text');
  userBody.className='whitespace-pre-wrap';
  userBody.setAttribute('aria-hidden','true');
  assert.equal(inspectCompletedTurn(attempt.url,true).userVisibleText,null,'a hidden message body is not visible-text proof');
  userBody.removeAttribute('aria-hidden');
  const duplicateBody=document.createElement('div');duplicateBody.className='whitespace-pre-wrap';duplicateBody.setAttribute('dir','auto');duplicateBody.textContent='Other message body';userBody.parentElement!.append(duplicateBody);
  assert.equal(inspectCompletedTurn(attempt.url,true).userVisibleText,null,'multiple concrete user bodies are ambiguous');
  duplicateBody.remove();
  const rendered=document.querySelector('[data-markdown-text-style]')!;
  const reference='::chatgpt-content-reference{index="0" source_message_id="latest-assistant-id"}';
  nativeAssistant.content=reference;
  nativeAssistant.contentReferences=[{model_dil_v2:{fallbackMarkdown:'GOAL_COMPLETE'}}];
  const referenced=inspectCompletedTurn(attempt.url,true);
  assert.equal(referenced.goalResponse,'GOAL_COMPLETE','a whole native reference resolves to its complete fallback Markdown');
  assert.equal(referenced.goalRawExact,true,'plain exact rendered marker agrees with complete native fallback');
  const blockedHTML=rendered.innerHTML;
  nativeAssistant.contentReferences=[{model_dil_v2:{fallbackMarkdown:'GOAL\\_BLOCKED'}}];
  rendered.innerHTML='<p>GOAL_BLOCKED</p>';
  const blocked=inspectCompletedTurn(attempt.url,true);
  assert.equal(blocked.goalResponse,'GOAL_BLOCKED');assert.equal(blocked.goalRawExact,true);
  latest.turn.status='in_progress';nativeAssistant.completed=false;
  const blockedStreaming=inspectCompletedTurn(attempt.url,true);
  assert.equal(completedAttemptEvidence({...attempt,promptKey:blockedStreaming.promptKey},{...blockedStreaming,attemptId:attempt.id}),null,'streaming blocked marker cannot finish the current request');
  latest.turn.status='complete';nativeAssistant.completed=true;
  rendered.innerHTML=blockedHTML;
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
  rendered.innerHTML='<div class="markdown"><p>GOAL_COMPLETE</p></div>';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,true,'plain fallback marker accepts known native Markdown DIV wrappers');
  for(const tag of ['h1','h2','h3','h4','h5','h6','div','span']) {
   rendered.innerHTML=`<${tag}>GOAL_COMPLETE</${tag}>`;
   assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,`${tag} is not a plain paragraph in native catch-up`);
  }
  for(const tag of ['del','s','b','i','u','mark','small','sup','sub','unknown-rich-node']) {
   rendered.innerHTML=`<p><${tag}>GOAL_COMPLETE</${tag}></p>`;
   assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,`${tag} markup cannot complete native catch-up`);
  }
  rendered.innerHTML='<p><span>GOAL_COMPLETE</span></p>';
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,true,'neutral span native fallback marker is plain text');
  for(const content of ['<p>GOAL_COMPLETE<br></p>','<p>GOAL_COMPLETE</p><p></p>','<p>GOAL_COMPLETE<!--extra node--></p>']) {
   rendered.innerHTML=content;
   assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'only one text-only paragraph can complete native catch-up');
  }
  for(const content of ['<p><code>GOAL_COMPLETE</code></p>','<pre>GOAL_COMPLETE</pre>','<p><strong>GOAL_COMPLETE</strong></p>','<p>GOAL_COMPLETE</p><p>Still working</p>']) {
   rendered.innerHTML=content;assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'non-plain or additional rendered answer text cannot complete a goal');
  }
  const dil=JSON.parse(require('node:fs').readFileSync('tests/fixtures/goal-marker-dil.json','utf8')) as {messageId:string;html:string};
  const dilHTML=dil.html.replaceAll(dil.messageId,nativeAssistant.messageId);
  const assistantUnit=document.querySelector('[data-chatgpt-search-unit-key$=":assistant"]')!;
  assistantUnit.setAttribute('data-chatgpt-search-message-ids',nativeAssistant.messageId+' '+nativeAssistant.messageId);
  nativeAssistant.content='::chatgpt-content-reference{index="0"}';
  nativeAssistant.contentReferences=[{source_message_id:nativeAssistant.messageId,model_dil_v2:{fallbackMarkdown:'GOAL\\_COMPLETE'}}] as any;
  rendered.innerHTML=dilHTML;
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,true,'native exact fallback agrees with positively bound neutral DIL rendered run');
  for(const html of [dilHTML.replace('GOAL_COMPLETE','<strong>GOAL_COMPLETE</strong>'),
   dilHTML.replace('GOAL_COMPLETE','<del>GOAL_COMPLETE</del>'),dilHTML.replace('GOAL_COMPLETE','<code>GOAL_COMPLETE</code>'),
   dilHTML.replace('<p ','<h1 ').replace('</p>','</h1>'),dilHTML.replace('</p>','</p><p>More</p>'),
   dilHTML.replace('<div hidden=""></div>','<div hidden="">Hidden meaning</div>')]) {
    rendered.innerHTML=html;assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'rich or additional native DIL content is not the marker');
  }
  rendered.innerHTML=dilHTML;
  nativeAssistant.contentReferences=[{source_message_id:'other',model_dil_v2:{fallbackMarkdown:'GOAL\\_COMPLETE'}}] as any;
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'DIL fallback must bind the native assistant source ID');
  nativeAssistant.contentReferences=[{source_message_id:nativeAssistant.messageId,model_dil_v2:{fallbackMarkdown:'GOAL\\_COMPLETE'}}] as any;
  assistantUnit.setAttribute('data-chatgpt-search-message-ids','other');
  assert.equal(inspectCompletedTurn(attempt.url,true).goalRawExact,false,'native assistant ID conflicts cannot be ignored');
  assistantUnit.removeAttribute('data-chatgpt-search-message-ids');
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
