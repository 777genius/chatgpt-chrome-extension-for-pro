import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

// Actual dispatch, serialization, insertion and native verification functions.
// Only browser transport and the editor's asynchronous normalization are fake.
const source=readFileSync('extension/content-script.js','utf8');
function section(from:string,to:string) {
  const start=source.indexOf(from),end=source.indexOf(to,start);
  assert.ok(start>=0&&end>start,'production dispatch helpers are present');
  return source.slice(start,end);
}
const editorFunctions=section('  function rawEditorText(editor) {','  async function restoreDraft(');
const dispatchFunctions=section('  async function sleepUntilNextCheck() {','  function reasoningEffort() {');
const url='https://chatgpt.com/c/goal-dispatch-fixture';
const text='First synthetic goal paragraph.\n\nSecond synthetic paragraph.';
const ownerEdit='  Owner edit\n\nKeep exact spacing  ';
async function fixture(mode:'normalize'|'owner-edit'|'native-mismatch') {
  const {document,window}=parseHTML('<html><body><main><article data-turn="user" data-testid="user-1">Seed fixture</article></main><form><div id="prompt-textarea" contenteditable="true"><p><br class="ProseMirror-trailingBreak"></p></div></form></body></html>');
  const editor=document.querySelector<HTMLElement>('#prompt-textarea')!;
  let now=1000000,normalizePending=false,clicks=0,phase='reserved';
  const events:string[]=[],statuses:any[]=[],nativeChecks:any[]=[];
  let insertedBeforeTick='';
  const context=createContext({URL,document,window,Node:window.Node,Event:window.Event,
    HTMLTextAreaElement:window.HTMLTextAreaElement,
    Date:class extends Date {static now(){return now;}},performance:{now:()=>now},
    location:{href:url,pathname:'/c/goal-dispatch-fixture'},
    __chatgptNotifierAttemptId:'seed-attempt',manualSendIntent:{fixture:'old manual intent'},
    goalDispatchBusy:true,replacingDraft:false,pendingDrafts:new Map(),handoffBusy:false,handoffRecord:null,
    runtimeAvailable:()=>true,isGenerating:()=>false,currentErrors:()=>[],
    isElementVisible:()=>true,composer:()=>editor,
    normalize:(value:unknown)=>String(value||'').replace(/\s+/g,' ').trim(),
    latestPromptSnapshot:()=>({promptKey:'/c/goal-dispatch-fixture|'+document.querySelector('article:last-child')!.getAttribute('data-testid')}),
    turnNodes:()=>Array.from(document.querySelectorAll('article')),
    roleOf:(turn:HTMLElement)=>turn.getAttribute('data-turn'),
    rememberCompletionSendIntent:()=>{events.push('completion-intent');},
    audit:async()=>({ok:true}),
    runtimeMessage:async(message:any)=>{
      if(message.type==='CHATGPT_GOAL_CHECK')return {ok:phase==='reserved'};
      if(message.type==='CHATGPT_WAIT') {
        events.push('wait');now+=message.delayMs;
        if(normalizePending) {
          normalizePending=false;
          if(mode==='owner-edit')editor.textContent=ownerEdit;
          else editor.querySelectorAll('br').forEach(node=>node.classList.add('ProseMirror-trailingBreak'));
        }
        return {ok:true};
      }
      if(message.type==='CHATGPT_GOAL_INTENT') {
        events.push('persisted-intent');assert.equal(phase,'reserved');phase='intent';
        assert.equal(message.text,text);assert.equal(message.baselineKey,'/c/goal-dispatch-fixture|user-1');
        return {ok:true};
      }
      if(message.type==='CHATGPT_COMPOSER_CONTROL') {
        const raw=runInContext('rawEditorText(composer())',context);
        if(message.options.action==='inspect') {
          events.push('native-inspect');nativeChecks.push({raw,at:now});
          return {ok:true,matches:raw===message.options.text&&mode!=='native-mismatch',ready:true};
        }
        events.push('native-send');assert.equal(phase,'intent');
        assert.equal(raw,text,'the native click is still gated on exact settled text');
        assert.equal(context.manualSendIntent,null,'Goal does not inherit a manual request intent');
        assert.equal(message.options.operationId,'dispatch-operation');clicks++;
        editor.textContent='';
        const user=document.createElement('article');user.setAttribute('data-turn','user');
        user.setAttribute('data-testid','user-2');user.textContent=text;document.querySelector('main')!.append(user);
        context.__chatgptNotifierAttemptId='goal-attempt';
        return {ok:true,clicked:true};
      }
      if(message.type==='CHATGPT_GOAL_STATUS') {
        statuses.push(structuredClone(message));events.push('status-'+message.status);
        if(message.status==='confirmed')phase='waiting';
        if(message.status==='blocked')phase='blocked';
        return {ok:true};
      }
      throw Error('Unexpected dispatch transport '+message.type);
    }
  });
  Object.assign(document,{createRange:()=>({selectNodeContents(){}}),execCommand:(_action:string,_ui:boolean,value:string)=>{
    editor.replaceChildren();
    for(const line of value.split('\n')) {
      const paragraph=document.createElement('p');
      if(line)paragraph.textContent=line;else paragraph.append(document.createElement('br'));
      editor.append(paragraph);
    }
    normalizePending=Boolean(value);
    if(value)insertedBeforeTick=runInContext('rawEditorText(composer())',context);
    return true;
  }});
  Object.assign(window,{getSelection:()=>({removeAllRanges(){},addRange(){}})});
  runInContext(readFileSync('extension/handoff-title.js','utf8')+'\n'+editorFunctions+'\n'+dispatchFunctions,context);
  context.dispatchMessage={url,operationId:'dispatch-operation',goalId:'dispatch-goal',text};
  await runInContext('dispatchGoal(dispatchMessage)',context);
  assert.notEqual(insertedBeforeTick,text,'fixture reproduces the temporary blank-paragraph newline mismatch');
  assert.equal(context.goalDispatchBusy,false,'dispatch always releases its local busy state');
  return {context,editor,clicks,phase,events,statuses,nativeChecks};
}

{
  const env=await fixture('normalize');
  assert.equal(env.clicks,1,'a settled multi-paragraph insertion receives one click');
  assert.equal(env.phase,'waiting');
  assert.deepEqual(env.statuses.map(status=>status.status),['clicked','confirmed']);
  assert.equal(env.statuses.at(-1).newPromptKey,'/c/goal-dispatch-fixture|user-2');
  assert.ok(env.nativeChecks.length>=3,'the existing exact native stability verification still runs');
  assert.ok(env.nativeChecks.at(-1).at-env.nativeChecks[0].at>=500);
  assert.ok(env.nativeChecks.every(check=>check.raw===text));
  assert.ok(env.events.indexOf('wait')<env.events.indexOf('native-inspect'));
  assert.ok(env.events.indexOf('persisted-intent')<env.events.indexOf('native-send'));
}
{
  const env=await fixture('owner-edit');
  assert.equal(env.clicks,0,'a concurrent user edit during settling cancels Goal');
  assert.equal(env.phase,'blocked');
  assert.equal(env.editor.textContent,ownerEdit,'preserve the exact concurrent owner draft');
  assert.equal(env.events.includes('persisted-intent'),false);
  assert.equal(env.nativeChecks.length,0,'strict DOM equality rejects the changed draft before native preparation');
}
{
  const env=await fixture('native-mismatch');
  assert.equal(env.clicks,0,'settled DOM alone never bypasses native editor verification');
  assert.equal(env.phase,'blocked');
  assert.equal(env.events.includes('persisted-intent'),false);
  assert.ok(env.nativeChecks.length>1);
}

console.log('Goal dispatch: transient paragraph normalization, strict native verification and concurrent draft priority passed.');
