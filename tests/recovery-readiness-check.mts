import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

const source=['memory-maintenance.js','handoff-title.js','completion-state.js','content-script.js'].map(name=>readFileSync(`extension/${name}`,'utf8')).join('\n');
type Mode='delayed'|'timeout'|'manual-edit'|'generation-resumed'|'missing-stop'|'selector-miss'|'assistant-idle';
type Message=Record<string,any>;
const originalDraft='Owner draft\n  exact whitespace';

async function check(mode:Mode) {
  const {document,window}=parseHTML('<html><head><title>Recovery fixture</title></head><body><main><article data-testid="conversation-turn-source" data-turn="user">Request</article><article data-testid="conversation-turn-partial" data-turn="assistant"><div class="markdown">Partial answer before interrupted connection</div></article></main><form data-composer-body><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button" type="button" disabled>Send</button><button data-testid="stop-button" type="button">Stop</button></form></body></html>');
  Object.defineProperty(window.Node,'DOCUMENT_POSITION_FOLLOWING',{value:4,configurable:true});
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{width:240,height:32}],configurable:true});
  Object.assign(document,{visibilityState:'hidden',createRange:()=>({selectNodeContents(){}}),execCommand:(_command:string,_show:boolean,text:string)=>{editor.textContent=text;return true;}});
  Object.assign(window,{getSelection:()=>({removeAllRanges(){},addRange(){}})});
  const editor=document.querySelector('#prompt-textarea')!;editor.textContent=originalDraft;
  const button=document.querySelector('[data-testid="send-button"]')! as HTMLButtonElement;
  const logs:Message[]=[],notifications:Message[]=[],sends:string[]=[];
  const draftStorage:Record<string,any>={};
  const intervals=new Set<()=>void>();
  let time=1000000,stoppedAt=0,sendAt=0,stops=0,edited=false,resumed=false,nativeInspects=0;
  let receiver:((message:Message)=>void)|undefined;
  const context=createContext({URL,document,window,Node:window.Node,Element:window.Element,Event:window.Event,
    MutationObserver:window.MutationObserver,HTMLTextAreaElement:window.HTMLTextAreaElement,AbortController,crypto:globalThis.crypto,
    location:{href:'https://chatgpt.com/c/recovery-fixture',pathname:'/c/recovery-fixture'},
    Date:class extends Date{static now(){return time;}},performance:{now:()=>time},
    // Page timers remain disabled: every readiness wait must use the worker.
    setTimeout:()=>0,clearTimeout(){},setInterval:(fn:()=>void)=>{intervals.add(fn);return fn;},clearInterval:(fn:()=>void)=>{intervals.delete(fn);},
    chrome:{storage:{local:{get:async(keys:string|string[])=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,draftStorage[key]]))),set:async(value:Record<string,unknown>)=>Object.assign(draftStorage,structuredClone(value))}},runtime:{id:'test-extension',getManifest:()=>({version:'fixture'}),onMessage:{addListener:(fn:(message:Message)=>void)=>{receiver=fn;},removeListener(){}},sendMessage:async(message:Message)=>{
      if(message.type==='CHATGPT_RETRY_STATE')return {ok:true,state:null};
      if(message.type==='CHATGPT_RETRY_CONFIRMATION')return {ok:true};
      if(message.type==='CHATGPT_RETRY_DRAFT_GET')return {ok:true,record:await runInContext('readRetryDraft(location.href)',context)};
      if(message.type==='CHATGPT_RETRY_DRAFT_CLAIM'){context.draftClaim=message;return runInContext('claimRetryDraft(location.href,draftClaim.operationId,draftClaim.savedSequence,{id:7,url:location.href})',context);}
      if(message.type==='CHATGPT_HANDOFF_GET')return {ok:true,record:null};
      if(message.type==='CHATGPT_LOG_EVENT'){logs.push(message.event);context.journalEvent=message.event;return runInContext('appendJournal(journalEvent,{id:7,url:location.href})',context);}
      if(message.type==='CHATGPT_INSPECT_ERROR')return {ok:true,action:'retry',recoveryBinding:mode==='assistant-idle'?{kind:'assistant-only',url:'https://chatgpt.com/c/recovery-fixture',entryId:'conversation-turn-partial',assistantId:'assistant-id',userId:null}:null};
      if(message.type==='CHATGPT_STOP_RECOVERY'){
        stops++;assert.equal(editor.textContent,originalDraft,'native stop must precede changing the owner draft');
        if(mode==='missing-stop')return {ok:false,stopped:false,reason:'Нативная кнопка остановки не найдена; автопродолжение отменено'};
        if(mode==='assistant-idle'){assert.equal(message.recoveryBinding?.assistantId,'assistant-id');stoppedAt=time;return {ok:true,stopped:false,idle:true,proof:'native-voice-idle'};}
        stoppedAt=time;editor.textContent='';document.querySelector('[data-testid="stop-button"]')!.remove();document.querySelector('[role="status"]')!.remove();
        return {ok:true,stopped:true};
      }
      if(message.type==='CHATGPT_WAIT'){
        time+=message.delayMs;
        if(stoppedAt&&time-stoppedAt>=12000&&mode!=='timeout')button.disabled=false;
        if(stoppedAt&&time-stoppedAt>=15000&&mode==='manual-edit'&&!edited){edited=true;editor.textContent='Owner edit during readiness';}
        if(stoppedAt&&time-stoppedAt>=15000&&mode==='generation-resumed'&&!resumed){resumed=true;const stop=document.createElement('button');stop.setAttribute('data-testid','stop-button');document.querySelector('form')!.append(stop);}
        for(const fn of [...intervals])fn();
        await new Promise<void>(resolve=>setImmediate(resolve));
        return {ok:true};
      }
      if(message.type==='CHATGPT_COMPOSER_CONTROL'){
        if(message.options.action==='inspect'){
          nativeInspects++;return {ok:true,matches:editor.textContent===message.options.text,ready:stoppedAt&&time-stoppedAt>=18000};
        }
        assert.equal(message.options.text,'доделай е2е');assert.equal(editor.textContent,'доделай е2е');assert.equal(button.disabled,false);
        assert.ok(time-stoppedAt>=18000,'native model readiness must be checked after DOM button readiness');
        assert.equal(logs.filter(event=>event.kind==='retry.send_intent').length,1,'one durable intent precedes the single guarded send');
        context.authorization={kind:'send.authorized',operationId:message.options.operationId,sourceUrl:context.location.href};
        await runInContext('appendJournal(authorization,{id:7,url:location.href})',context);
        sends.push(editor.textContent);sendAt=time;editor.textContent='';
        const turn=document.createElement('article');turn.setAttribute('data-testid','conversation-turn-retry');turn.setAttribute('data-turn','user');turn.textContent='доделай е2е';document.querySelector('main')!.append(turn);
        context.__chatgptNotifierAttemptId='retry-request';return {ok:true,clicked:true};
      }
      if(['CHATGPT_RESPONSE_COMPLETE','CHATGPT_RESPONSE_ERROR'].includes(message.type))notifications.push(message);
      return {ok:true};
    }}}});
  if(mode==='missing-stop'||mode==='assistant-idle')document.querySelector('[data-testid=stop-button]')!.remove();
  if(mode==='assistant-idle')document.querySelector('[data-turn=user]')!.remove();
  if(mode==='selector-miss'){const original=document.querySelectorAll.bind(document);document.querySelectorAll=((selector:string)=>selector.includes('fruitjuice-stop-button')?[]:original(selector)) as typeof document.querySelectorAll;}
  runInContext(readFileSync('extension/journal-store.js','utf8'),context);
  runInContext(readFileSync('extension/goal-policy.js','utf8'),context);
  runInContext(source,context);
  // A watcher for the original interrupted request must be retired when its
  // recovery error is observed, even though its partial answer remains mounted.
  receiver?.({type:'CHATGPT_CONVERSATION_REQUEST_COMPLETED'});
  const recovery=document.createElement('div');recovery.setAttribute('role','status');recovery.innerHTML='<span class="text-chatgpt-recovery">Recovery status</span>';document.querySelector('main')!.append(recovery);
  for(let i=0;i<1000&&!logs.some(event=>event.kind==='draft.restored');i++)await new Promise<void>(resolve=>setImmediate(resolve));
  context.__chatgptNotifierDispose();
  assert.equal(stops,1);assert.equal(notifications.filter(item=>item.type==='CHATGPT_RESPONSE_COMPLETE').length,0,'stopping recovery must not announce the existing partial answer as success');
  if(mode==='missing-stop'){
    assert.equal(sends.length,0);assert.equal(editor.textContent,originalDraft);
    assert.ok(notifications.some(item=>item.type==='CHATGPT_RESPONSE_ERROR'&&item.retryReason?.includes('Нативная кнопка остановки не найдена')));
    assert.equal(logs.filter(event=>event.kind==='retry.send_intent').length,0);
    return;
  }
  assert.ok(logs.some(event=>event.kind==='retry.readiness'&&event.timeoutMs===60000),'a successful recovery stop grants one bounded 60-second readiness budget');
  if(mode==='delayed'||mode==='selector-miss'||mode==='assistant-idle'){
    assert.deepEqual(sends,['доделай е2е']);assert.ok(sendAt-stoppedAt>10000);assert.ok(nativeInspects>1);
    assert.ok(logs.some(event=>event.kind==='retry.readiness'&&event.phase==='send-button'));
    assert.ok(logs.some(event=>event.kind==='retry.readiness'&&event.phase==='native-ready'));
    assert.ok(logs.some(event=>event.kind==='retry.confirmed'));assert.equal(notifications.length,0);
    assert.equal(editor.textContent,originalDraft);
  }else if(mode==='timeout'){
    assert.equal(sends.length,0);assert.equal(logs.filter(event=>event.kind==='retry.send_intent').length,0);
    const failure=logs.filter(event=>event.kind==='retry.failed');assert.equal(failure.length,1);assert.equal(failure[0].clicked,false);assert.equal(failure[0].phase,'send-button');
    assert.ok(time-stoppedAt>=60000&&time-stoppedAt<61000);assert.equal(notifications.filter(item=>item.type==='CHATGPT_RESPONSE_ERROR').length,1);assert.equal(editor.textContent,originalDraft);
  }else{
    assert.equal(sends.length,0);assert.equal(logs.filter(event=>event.kind==='retry.send_intent').length,0);assert.equal(logs.filter(event=>event.kind==='retry.failed').length,0);
    assert.ok(logs.some(event=>event.kind==='retry.readiness_cancelled'&&event.reason===(mode==='manual-edit'?'editor-changed':'generation-resumed')));
    assert.equal(notifications.length,0);
    assert.equal(editor.textContent,mode==='manual-edit'?`${originalDraft}\n\nOwner edit during readiness`:originalDraft);
  }
}

for(const mode of ['delayed','timeout','manual-edit','generation-resumed','missing-stop','selector-miss','assistant-idle'] as const)await check(mode);
console.log('PASS: hidden recovery readiness beyond 10s, native model settling, one intent/click, bounded 60s failure, manual edit/generation cancellation, draft preservation and no partial-answer success');
