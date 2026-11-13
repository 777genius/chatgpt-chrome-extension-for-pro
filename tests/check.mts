import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import {setImmediate as nextTurn} from 'node:timers/promises';
const content = readFileSync('extension/memory-maintenance.js', 'utf8') + '\n' + readFileSync('extension/handoff-title.js', 'utf8') + '\n' +
  readFileSync('extension/content-script.js', 'utf8');
const worker = readFileSync('extension/service-worker.js', 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 220));
async function waitFor(predicate:()=>boolean) {
  const deadline=Date.now()+8000;
  while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(predicate(),'expected durable transition did not finish');
}
const alertHTML = (text: string) => `<aside role="alert" class="text-danger"><div aria-hidden="true">decorative</div><div>${text}</div><button>Повторить</button></aside>`;
const user = '<article data-testid="conversation-turn-0" data-turn="user">Question</article>';
const domContexts:ReturnType<typeof createContext>[]=[];
async function domCheck() {
  function setup(draft = '', hasComposer = true, confirmSend = true, newTyping = '', savedRetry: any = null, keepRecovery = false, duplicatePlan = false, readinessClockDelay = 0, recoveryWait: 'none'|'transient'|'permanent'|'hard'|'lost' = 'none', nativeConfirm = true) {
    const { document, window } = parseHTML(`<html><body><main>${user}</main>${hasComposer ? `<form><div id="prompt-textarea" contenteditable="true">${draft}</div><button data-testid="send-button" type="button">Send</button></form>` : ''}</body></html>`);
    Object.defineProperty(window.Node, 'DOCUMENT_POSITION_FOLLOWING', { value: 4, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { configurable: true, value() {
      return this.hidden || this.style.display === 'none' ? [] : [{width:240,height:32}];
    }});
    const messages: any[] = [], sends: string[] = [], logs: any[] = [], committedLogs:any[]=[];
    const draftStorage:Record<string,any>={};
    let failJournal = false;let stopCalls=0,stopChecks=0,delayedPlanMs=0;
    let now = 1000000, sequence = 0;
    const editor = document.querySelector('#prompt-textarea');
    const main = document.querySelector('main')!;
    const range = { selectNodeContents() {} };
    Object.assign(document, { createRange: () => range, execCommand: (_: any, __: any, text: string) => {
      if (!editor) return false;
      editor.textContent = text; return true;
    }});
    Object.assign(window, { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) });
    const clock = class extends Date { static now() { return now; } };
    const context = createContext({ document, window, Node: window.Node, Element: window.Element,
      URL, AbortController, crypto: globalThis.crypto, Event: window.Event, HTMLTextAreaElement: window.HTMLTextAreaElement,
      MutationObserver: window.MutationObserver, location: { pathname: '/c/example',href:'https://chatgpt.com/c/example' }, performance:{now:()=>now},
      Date: clock, setTimeout, clearTimeout, setInterval, clearInterval,
      chrome: { storage:{local:{get:async(keys:string|string[])=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,draftStorage[key]]))),set:async(value:Record<string,unknown>)=>Object.assign(draftStorage,structuredClone(value))}},runtime: {id:'test-extension',getManifest:()=>({version:'fixture'}),sendMessage:async(message:any)=>{
        if(message.type==='CHATGPT_RETRY_STATE')return {ok:true,state:savedRetry};
        if(message.type==='CHATGPT_COMPLETION_CHECKPOINT')return {ok:false};
        if(message.type==='CHATGPT_RETRY_CONFIRMATION')return {ok:nativeConfirm};
        if(message.type==='CHATGPT_RECONCILE_LEGACY_HANDOFF_STATUS')return {ok:true,changed:false};
        if(message.type==='CHATGPT_GOAL_RECOVER')return {ok:false};
        if(message.type==='CHATGPT_GOAL_CONTEXT')return {ok:true,text:''};
        if(message.type==='CHATGPT_RETRY_DRAFT_GET')return {ok:true,record:savedRetry?.fixtureDraft&&!logs.some(e=>e.kind==='draft.saved')?savedRetry.fixtureDraft:await runInContext('readRetryDraft(location.href)',context)};
        if(message.type==='CHATGPT_RETRY_DRAFT_CLAIM'){context.draftClaim=message;return runInContext('claimRetryDraft(location.href,draftClaim.operationId,draftClaim.savedSequence,{id:7,url:location.href})',context);}
        if(message.type==='CHATGPT_WAIT'){
          // Keep the user-visible recovery grace observable until advance(),
          // while retry/settling budgets use only this fixture's virtual clock.
          if(message.delayMs>=3000&&!logs.some(e=>e.kind==='retry.planned'))await new Promise(r=>setTimeout(r,message.delayMs));
          else {now+=message.delayMs;await nextTurn();}
          return {ok:true};
        }
        if(message.type==='CHATGPT_STOP_RECOVERY'){
          stopChecks++;
          if(recoveryWait==='hard')return {ok:false,stopped:false,reason:'Changed native prompt'};
          if(recoveryWait==='lost')return null;
          if(recoveryWait==='permanent'||recoveryWait==='transient'&&stopChecks===1){now+=recoveryWait==='permanent'?61000:15000;return {ok:false,stopped:false,retryable:true,reason:'Native idle proof pending'};}
          stopCalls++;assert.equal(editor!.textContent,draft,'stop must precede replacing the draft');editor!.textContent='';document.querySelector('[data-test-modern-stop]')?.remove();if(!keepRecovery)document.querySelector('[role=status]')?.remove();return {ok:true,stopped:true};}
        if(message.type==='CHATGPT_COMPOSER_CONTROL'){
          if(message.options.action==='send'){context.sendAuthorization={kind:'send.authorized',operationId:message.options.operationId,sourceUrl:context.location.href};await runInContext('appendJournal(sendAuthorization,{id:7,url:location.href})',context);document.querySelector('button[data-testid=send-button]')?.dispatchEvent(new window.Event('click'));return {ok:true,clicked:true};}
          return {ok:true,matches:true,ready:true};
        }
        if(message.type==='CHATGPT_LOG_EVENT'){logs.push(message.event);if(message.event.kind==='retry.planned'&&delayedPlanMs){const delay=delayedPlanMs;delayedPlanMs=0;await new Promise(resolve=>setTimeout(resolve,delay));}if(message.event.kind==='retry.readiness'&&message.event.phase==='settling')now+=readinessClockDelay;if(duplicatePlan&&message.event.kind==='retry.planned')return {ok:false,duplicate:true};if(failJournal)return {ok:false};context.journalEvent=message.event;const result=await runInContext('appendJournal(journalEvent,{id:7,url:location.href})',context);if(result?.ok)committedLogs.push(structuredClone(message.event));return result;}
        if(message.type==='CHATGPT_INSPECT_ERROR')return {ok:true,action:'retry'};
        if(message.type==='CHATGPT_HANDOFF_GET')return {ok:true,record:null};
        messages.push(message);
      },onMessage:{addListener(){}}}} });
    domContexts.push(context);
    document.querySelector('button[data-testid="send-button"]')?.addEventListener('click', () => {
      sends.push(editor!.textContent!);
      if (!confirmSend) { setTimeout(() => { now += 11000; }, 50); return; }
      editor!.textContent = newTyping;
      main.querySelectorAll(keepRecovery?'aside':'aside,[role=status]').forEach(a => a.remove());
      main.insertAdjacentHTML('beforeend', `<article data-testid="conversation-turn-${++sequence}" data-turn="user">доделай е2е</article>`);
      if(keepRecovery){const status=main.querySelector('[role=status]');if(status)main.append(status);}
      runInContext(`globalThis.__chatgptNotifierAttemptId = '${sequence}'; globalThis.__chatgptNotifierRequestStartedAt = ${now}`, context);
    });
    runInContext(readFileSync('extension/goal-policy.js','utf8'),context);
    runInContext(readFileSync('extension/journal-store.js','utf8'),context);
    runInContext(content, context);
    return { messages, sends, document, context, logs, committedLogs, delayNextPlan(ms:number){delayedPlanMs=ms;}, getStopCalls(){return stopCalls;},getStopChecks(){return stopChecks;}, breakJournal(){failJournal=true;},
      advance(ms: number) { now += ms; },
      async fail(text: string) {
        main.insertAdjacentHTML('beforeend', alertHTML(text));
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    };
  }
  const delayedReadiness = setup('Exact owner draft\n  Keep spaces',true,true,'',null,false,false,15000);
  await delayedReadiness.fail('Delivery timeout while native composer settles');
  await waitFor(()=>delayedReadiness.logs.some(e=>e.kind==='draft.restored'||e.kind==='retry.failed'));
  assert.deepEqual(delayedReadiness.sends,['доделай е2е'],'slow UI/journal readiness beyond 10s must still allow one bounded retry');
  assert.equal(delayedReadiness.logs.filter(e=>e.kind==='retry.send_intent').length,1);
  assert.equal(delayedReadiness.logs.filter(e=>e.kind==='retry.confirmed').length,1);
  assert.equal(delayedReadiness.document.querySelector('#prompt-textarea')!.textContent,'Exact owner draft\n  Keep spaces');
  const expiredReadiness = setup('Never send this owner draft',true,true,'',null,false,false,61000);
  await expiredReadiness.fail('Composer never became ready within the bounded deadline');
  await waitFor(()=>expiredReadiness.logs.some(e=>e.kind==='retry.failed')&&expiredReadiness.document.querySelector('#prompt-textarea')!.textContent==='Never send this owner draft');
  assert.equal(expiredReadiness.sends.length,0,'readiness after 60s must remain a zero-click failure');
  assert.equal(expiredReadiness.logs.some(e=>e.kind==='retry.send_intent'),false);
  assert.equal(expiredReadiness.logs.find(e=>e.kind==='retry.failed')?.clicked,false);
  assert.equal(expiredReadiness.document.querySelector('#prompt-textarea')!.textContent,'Never send this owner draft');
  for(const mode of ['transient','permanent','hard','lost'] as const) {
    const f=setup('Recovery owner draft',true,true,'',null,false,false,0,mode);
    f.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="status"><span class="text-chatgpt-recovery">Recovery surface</span></div>');
    await pause();f.advance(3500);
    await waitFor(()=>f.logs.some(e=>e.kind==='retry.finished'));
    if(mode==='transient') {
      assert.deepEqual(f.sends,['доделай е2е']);assert.equal(f.getStopChecks(),2);assert.equal(f.getStopCalls(),1,'an explicit no-click refusal may be retried, then Stop is clicked once');
      assert.equal(f.logs.filter(e=>e.kind==='retry.readiness'&&e.phase==='recovery-idle').length,1);
    } else {
      assert.equal(f.sends.length,0);assert.equal(f.getStopChecks(),1,'hard refusal, missing ACK or expired budget never replays a possible Stop');assert.equal(f.getStopCalls(),0);
      assert.equal(f.logs.some(e=>e.kind==='retry.send_intent'),false);
    }
    assert.equal(f.document.querySelector('#prompt-textarea')!.textContent,'Recovery owner draft');
  }
  if(process.argv[2]==='retry-deadline'){console.log('PASS: bounded slow retry readiness, one confirmed send, over-budget zero click and exact draft restoration');return;}
  const duplicate = setup('Keep this owner draft',true,true,'',null,false,true);
  await duplicate.fail('Failed request already owned by another tab');
  assert.equal(duplicate.sends.length,0);
  assert.equal(duplicate.document.querySelector('#prompt-textarea')!.textContent,'Keep this owner draft');
  assert.equal(duplicate.getStopCalls(),0);
  assert.equal(duplicate.logs.some(e=>e.kind==='draft.saved'||e.kind==='retry.failed'),false,'losing a shared claim must not overwrite draft metadata or block the winning retry');
  assert.equal(duplicate.logs.some(e=>e.kind==='retry.duplicate_suppressed'),true);
  assert.equal(duplicate.messages.length,0,'a duplicate loser must not paint an error or notify while another tab is recovering');
  const afterUpdate = setup('',true,true,'',{failures:[999900],lastPromptKey:'/c/example|conversation-turn-0',lastAttemptId:'old-observed-attempt',blocked:false});
  await afterUpdate.fail('Existing error after update');
  assert.equal(afterUpdate.sends.length,0,'reload must not repeat a previously observed prompt without a new request');
  assert.equal(afterUpdate.logs.filter(e=>e.kind==='error.detected').length,0);
  assert.equal(afterUpdate.messages.filter(m=>m.type==='CHATGPT_RESPONSE_ERROR').length,1,
    'an already-observed visible error must produce exactly one warning, got '+afterUpdate.messages.map(m=>m.type).join(', '));
  assert.match(afterUpdate.messages.find(m=>m.type==='CHATGPT_RESPONSE_ERROR')?.retryReason,/уже обрабатывался/);
  assert.equal(afterUpdate.logs.filter(e=>e.kind==='retry.suppressed').length,1);
  const unknownAfterUpdate=setup('',true,true,'',{failures:[],lastPromptKey:'/c/example|conversation-turn-0',lastAttemptId:'',blocked:true,reason:'Не удалось подтвердить отправку'});
  await unknownAfterUpdate.fail('Время ожидания доставки сообщения истекло. Попробуйте снова.');
  assert.equal(unknownAfterUpdate.sends.length,0,'an unknown previous send must not be repeated');
  assert.equal(unknownAfterUpdate.messages.filter(m=>m.type==='CHATGPT_RESPONSE_ERROR').length,1,
    'saved uncertainty still reports one warning and the actual stop reason');
  assert.match(unknownAfterUpdate.messages.find(m=>m.type==='CHATGPT_RESPONSE_ERROR')?.retryReason,/Не удалось подтвердить отправку/);
  assert.equal(unknownAfterUpdate.logs.filter(e=>e.kind==='retry.suppressed').length,1);
  unknownAfterUpdate.document.querySelector('aside')!.remove();await pause();
  await unknownAfterUpdate.fail('Delivery timed out. Please retry.');
  assert.equal(unknownAfterUpdate.messages.filter(m=>m.type==='CHATGPT_RESPONSE_ERROR').length,1,
    'rewording a suppressed error for the same prompt must not spam alerts');
  assert.equal(unknownAfterUpdate.logs.filter(e=>e.kind==='retry.planned').length,0);

  const restoredBlock=setup('',true,true,'',{failures:[],blocked:true,reason:'Saved sticky stop'});
  await restoredBlock.fail('New failed prompt');
  assert.equal(restoredBlock.sends.length,0,'sticky stop survives an extension update even outside the rolling window');
  assert.match(restoredBlock.messages[0].retryReason,/Saved sticky stop/);
  const extras=setup('',true,true,'',{failures:[],remainingRetries:2,blocked:false});
  await extras.fail('Extra one');await waitFor(()=>extras.logs.filter(e=>e.kind==='retry.finished').length===1);extras.advance(5000);
  await extras.fail('Extra two');await waitFor(()=>extras.logs.filter(e=>e.kind==='retry.finished').length===2);extras.advance(5000);
  await extras.fail('Extra budget exhausted');
  assert.equal(extras.sends.length,2,'explicit extra budget must allow exactly two sends');
  assert.match(extras.messages[0].retryReason,/Дополнительные автоповторы исчерпаны/);
  const run = setup();
  const settledRetry=async(text:string)=>{
    const start=run.logs.length;
    await run.fail(text);
    // Observe the exact operation's durable outcome, not a page timer. A
    // loaded runner or slow journal can outlive fail()'s observation interval.
    await waitFor(()=>{
      const planned=run.logs.slice(start).find(event=>event.kind==='retry.planned');
      return planned&&run.committedLogs.some(event=>event.kind==='retry.finished'&&event.operationId===planned.operationId)&&
        run.committedLogs.some(event=>event.kind==='retry.confirmed'&&event.operationId===planned.operationId);
    });
  };
  await settledRetry('Ошибка первая');
  assert.deepEqual(run.sends, ['доделай е2е']);
  assert.equal(run.messages.length, 0, 'first error retries silently');
  // Keep the five failures within 120s, including virtual worker readiness time.
  run.advance(25000);
  await settledRetry('Ошибка с другим текстом');
  assert.equal(run.sends.length, 2);
  assert.equal(run.messages.length, 0, 'second error retries silently');
  run.advance(25000);
  run.delayNextPlan(1200); // Deterministically exceed the former 1100ms assumption.
  await settledRetry('Третья ошибка');
  assert.equal(run.sends.length,3,'third error gets the third automatic retry');
  assert.equal(run.messages.length,0);
  run.advance(25000);
  await settledRetry('Четвёртая ошибка');
  assert.equal(run.sends.length,4,'fourth error gets the fourth automatic retry');
  assert.equal(run.messages.length,0);
  run.advance(25000);
  const fifthRequestStartedAt=run.context.__chatgptNotifierRequestStartedAt;
  await run.fail('Пятая ошибка');
  assert.equal(run.sends.length, 4, 'fifth error must not send');
  assert.equal(run.messages.length, 1, 'only threshold error notifies');
  assert.equal(run.messages[0].response, 'Пятая ошибка');
  assert.equal(run.messages[0].durationMs,run.logs.find(e=>e.kind==='error.detected'&&e.error==='Пятая ошибка').eventAt-fifthRequestStartedAt,'elapsed duration follows the virtual request and actual error observation');
  assert.match(run.messages[0].retryReason, /4 автоповтора за 2 минуты/);
  run.document.querySelector('aside div:not([aria-hidden])')!.textContent = 'Updated wording';
  await pause();
  assert.equal(run.messages.length, 1, 'one failed attempt is counted once even when error text changes');
  run.advance(150000);
  runInContext("globalThis.__chatgptNotifierAttemptId = 'manual-regenerate'", run.context);
  run.document.querySelector('aside')!.remove();
  await pause();
  await run.fail('Still stopped');
  assert.equal(run.sends.length, 4, 'limit remains stopped rather than restarting on a timer');

  assert.equal(run.logs.filter(e=>e.kind==='retry.confirmed').length,4);
  assert.equal(run.logs.filter(e=>e.kind==='retry.send_intent').length,4);
  assert.equal(run.logs.filter(e=>e.kind==='retry.confirmed')[0].operationId,run.logs.find(e=>e.kind==='retry.planned').operationId);
  assert.equal(run.logs.filter(e=>e.kind==='retry.confirmed')[0].attemptId,run.logs.find(e=>e.kind==='retry.planned').attemptId,'retry lifecycle remains bound to its failed request after a newer request starts');
  const oldTurn=setup('',true,true,'',null,false,false,0,'none',false);
  await oldTurn.fail('Repeated old message');
  await waitFor(()=>oldTurn.logs.some(e=>e.kind==='retry.failed'));
  assert.equal(oldTurn.sends.length,1,'the original guarded send remains one-shot');
  assert.equal(oldTurn.logs.filter(e=>e.kind==='retry.confirmed').length,0,'a changed DOM key alone cannot confirm an old identical message');
  assert.equal(oldTurn.logs.find(e=>e.kind==='retry.failed').clicked,true,'unknown delivery remains fenced');
  const noLog=setup('Draft');noLog.breakJournal();await noLog.fail('error');
  assert.equal(noLog.sends.length,0,'journal failure must prevent automatic send');
  assert.equal(noLog.document.querySelector('#prompt-textarea')!.textContent,'Draft');
  assert.match(noLog.messages[0].retryReason,/журнал/);
  const recovery=setup('Сохранить мой черновик');
  recovery.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="status"><span class="text-chatgpt-recovery">接続を回復しています</span></div>');
  const stop=recovery.document.createElement('button');stop.type='button';stop.setAttribute('data-test-modern-stop','');stop.innerHTML='<svg class="icon-primary-action"><path d="M4.5 5.75C4.5 test-stop-icon"></path></svg>';const body=recovery.document.querySelector('form')!;body.setAttribute('data-composer-body','');body.append(stop);
  await pause();assert.equal(recovery.sends.length,0,'transient recovery must not immediately retry');
  recovery.advance(3500);await waitFor(()=>recovery.logs.some(event=>event.kind==='draft.restored'));
  assert.deepEqual(recovery.sends,['доделай е2е']);assert.equal(recovery.getStopCalls(),1,'a stalled recovery must stop once before continuing');
  assert.equal(recovery.document.querySelector('#prompt-textarea')!.textContent,'Сохранить мой черновик');
  assert.ok(recovery.logs.some(e=>e.kind==='error.detected'&&e.error==='接続を回復しています'));
  const lingering=setup('',true,true,'',null,true);
  const lingeringStop=lingering.document.createElement('button');lingeringStop.type='button';lingeringStop.setAttribute('data-test-modern-stop','');lingeringStop.innerHTML=stop.innerHTML;const lingeringBody=lingering.document.querySelector('form')!;lingeringBody.setAttribute('data-composer-body','');lingeringBody.append(lingeringStop);
  lingering.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="status"><span class="text-chatgpt-recovery">Recovery</span></div>');
  await pause();lingering.advance(3500);await waitFor(()=>lingering.logs.some(event=>event.kind==='retry.confirmed'));
  assert.equal(lingering.sends.length,1);
  await new Promise(r=>setTimeout(r,700));
  assert.equal(lingering.logs.filter(e=>e.kind==='error.detected').length,1,'old recovery banner must get a new grace period for the new request');
  lingering.advance(10000);lingering.document.querySelector('[role=status]')!.setAttribute('class','still-mounted');
  await new Promise(r=>setTimeout(r,3300));
  assert.equal(lingering.logs.filter(e=>e.kind==='error.detected').length,1,'an unchanged inherited banner never becomes a new failure just because time passes');
  lingering.document.querySelector('[role=status]')!.remove();
  const recovered=setup();
  recovered.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="status"><span class="text-chatgpt-recovery">Recovery</span></div>');
  await pause();recovered.document.querySelector('[role=status]')!.remove();recovered.advance(3500);
  await new Promise(r=>setTimeout(r,3100));assert.equal(recovered.sends.length,0,'self-recovered connection must not send');
  console.log('PASS: structural recovery status, grace period, self-recovery cancellation, draft protection');
  const frozenTimers=setup('Draft survives background throttling');
  runInContext('setTimeout=()=>0',frozenTimers.context);
  await frozenTimers.fail('error in background');
  await waitFor(()=>frozenTimers.logs.some(e=>e.kind==='draft.restored'||e.kind==='retry.failed'));
  assert.deepEqual(frozenTimers.sends,['доделай е2е'],'error handling must not depend on page timers');
  assert.equal(frozenTimers.document.querySelector('#prompt-textarea')!.textContent,'Draft survives background throttling');
  console.log('PASS: continuation and draft restoration with page timers completely disabled');
  const rolling = setup();
  await rolling.fail('one'); rolling.advance(70000);
  await rolling.fail('two'); rolling.advance(70000);
  await rolling.fail('three');
  assert.equal(rolling.sends.length, 3, 'errors outside rolling two-minute window expire');
  assert.equal(rolling.messages.length, 0);

  const draftText = 'Мой черновик\nВторая строка  с  пробелами';
  const draft = setup(draftText);
  await draft.fail('error');
  assert.deepEqual(draft.sends, ['доделай е2е']);
  assert.equal(draft.document.querySelector('#prompt-textarea')!.textContent, draftText);
  assert.equal(draft.messages.length, 0);
  await draft.fail('second error');
  assert.equal(draft.sends.length, 2);
  assert.equal(draft.document.querySelector('#prompt-textarea')!.textContent, draftText);

  const concurrent = setup('Исходный черновик', true, true, 'Новый текст');
  await concurrent.fail('error');
  assert.equal(concurrent.document.querySelector('#prompt-textarea')!.textContent, 'Исходный черновик\n\nНовый текст');
  assert.deepEqual(concurrent.sends, ['доделай е2е']);

  const missing = setup('', false);
  await missing.fail('error');
  assert.equal(missing.sends.length, 0);
  assert.match(missing.messages[0].retryReason, /Не найдено поле/);

  const uncertain = setup('Черновик до неясной отправки', true, false);
  await uncertain.fail('error');
  await waitFor(()=>uncertain.sends.length===1);
  assert.equal(uncertain.logs.filter(e=>e.kind==='retry.confirmed').length,0,'uncertain send must never be logged as confirmed');
  assert.equal(uncertain.sends.length, 1, 'uncertain send is clicked exactly once');
  assert.match(uncertain.messages[0].retryReason, /подтвердить отправку/);
  assert.equal(uncertain.document.querySelector('#prompt-textarea')!.textContent, 'доделай е2е','uncertain send must not expose a draft to a potentially pending submission');
  assert.ok(uncertain.logs.some(e=>e.kind==='draft.saved'&&e.draft==='Черновик до неясной отправки'));
  assert.ok(uncertain.logs.some(e=>e.kind==='draft.restore_deferred'));

  const carried=setup('',true,true,'',{preparationRecovered:true,preparationDraftOperationId:'prior-no-click',preparationDraftSequence:12,
    fixtureDraft:{operationId:'prior-no-click',savedSequence:12,attemptId:'',phase:'not-clicked',draft:'Preserved synthetic draft'}});
  await carried.fail('Delivery timeout after a no-click recovery');
  await waitFor(()=>carried.sends.length===1);
  await waitFor(()=>carried.document.querySelector('#prompt-textarea')!.textContent==='Preserved synthetic draft');
  assert.deepEqual(carried.sends,['доделай е2е'],'carried backup is never submitted');
  const carriedRecovery=setup('Preserved synthetic draft',true,true,'',{preparationRecovered:true,preparationDraftOperationId:'prior-recovery',preparationDraftSequence:12,
    fixtureDraft:{operationId:'prior-recovery',savedSequence:12,attemptId:'',phase:'not-clicked',draft:'Preserved synthetic draft'}});
  carriedRecovery.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="status"><span class="text-chatgpt-recovery">Recovery</span></div>');
  await pause();carriedRecovery.advance(3500);
  await waitFor(()=>carriedRecovery.logs.some(e=>e.kind==='draft.restored'));
  assert.deepEqual(carriedRecovery.sends,['доделай е2е']);
  assert.equal(carriedRecovery.document.querySelector('#prompt-textarea')!.textContent,'Preserved synthetic draft','carried recovery never doubles or submits the same owner draft');
  const historical = setup();
  historical.document.querySelector('main')!.innerHTML = `<article data-testid="conversation-turn-old" data-turn="assistant">${alertHTML('Old')}</article>${user}<article data-testid="conversation-turn-2" data-turn="assistant"><div class="markdown">${alertHTML('Example')}</div></article>`;
  await pause();
  assert.equal(historical.sends.length, 0);
  assert.equal(historical.messages.length, 0);
  runInContext(content, historical.context);
  await pause();
  assert.equal(historical.sends.length, 0);
  console.log('PASS: four retries silent, fifth stops/notifies, explicit extra budget, stale recovery across attempts, rolling window, sticky stop, changed error text dedupe, timing, draft protection, missing composer, historical/quoted errors, reinjection');
}
async function workerCheck() {
  const callbacks: Record<string, any> = {};
  const event = (name: string) => ({ addListener: (fn: any) => { callbacks[name] = fn; } });
  const notifications: any[] = [], injections: any[] = [];
  let soundCalls = 0;
  let activeTab={id:7,url:'https://chatgpt.com/c/example'};
  let handoffProof:any=null,nativeGoalProof:any=null;
  let missingWatcher=false;const requestSignals:any[]=[];
  const storage: Record<string, any> = {};
  const chrome = {
    storage: { local: { get: async (key: string | string[] | null) => key === null ? {...storage} : Object.fromEntries((Array.isArray(key)?key:[key]).map(name=>[name,storage[name]])), set: async (entries: any) => {Object.assign(storage, entries);} } },
    runtime: { id:'test-extension',onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
      getManifest: () => ({version:'1.2.0'}), getURL: (url: string) => `chrome-extension://test-extension/${url}`, getContexts: async () => [{}], sendMessage: async () => { if (++soundCalls === 1) throw new Error('Could not establish connection. Receiving end does not exist.'); } },
    webRequest: { onBeforeRequest: event('before'), onCompleted: event('complete'), onErrorOccurred:event('requestError') },
    tabs: { query: async () => [activeTab], get:async()=>activeTab,onRemoved: event('removed'), sendMessage: async (tabId:number,message:any) => {requestSignals.push({tabId,...message});if(missingWatcher){missingWatcher=false;throw new Error('Receiving end does not exist');}if(message.type==='CHATGPT_GOAL_DISPATCH')return {ok:true};} },
    scripting: { executeScript: async (args: any) => { injections.push(args); return [{result:args.func?.name==='inspectHandoffAcceptance'?handoffProof:args.func?.name==='inspectCompletedTurn'&&nativeGoalProof?nativeGoalProof:{ok:true,clicked:true}}]; } },
    notifications: { create: async (id: string, options: any) => { notifications.push(options); return id; }, onClicked: event('clicked') }
  };
  const workerContext = createContext({ chrome, console, URL, crypto:globalThis.crypto, setTimeout, clearTimeout });
  Object.assign(workerContext, {importScripts: (name: string) => runInContext(readFileSync(`extension/${name}`, 'utf8'), workerContext)});
  runInContext(worker, workerContext);
  callbacks.installed(); await pause();
  assert.equal(injections[0].target.tabId, 7, 'update must inject into existing tabs without navigation');
  const sender = { tab: { id: 7, url: 'https://chatgpt.com/c/example' } };
  const error = { type: 'CHATGPT_RESPONSE_ERROR', sessionTitle: 'My chat - ChatGPT', response: 'Network failed', durationMs: 125000, fingerprint: 'error|prompt|Network failed' };
  callbacks.message(error, sender); await pause();
  await waitFor(()=>soundCalls>=2&&notifications.length>=1);
  assert.equal(notifications[0].title, '❌ My chat');
  assert.equal(notifications[0].iconUrl,'icons/status-error.png');
  assert.equal(soundCalls,2,'offscreen listener startup race retries without losing notification');
  assert.equal(notifications[0].message, 'Network failed');
  assert.equal(notifications[0].contextMessage, 'Ошибка через 2 мин 5 с');
  callbacks.message(error, sender); await pause();
  assert.equal(notifications.length, 2, 'new attempt must not be suppressed by service-worker dedupe');
  await runInContext("manualRequestReceiptsByTab.set(7,{startedAt:123,receipt:statusReceipt(),url:'https://chatgpt.com/c/example'})",workerContext);
  const success = { attemptId:'123',completionStartedAt:123,type: 'CHATGPT_RESPONSE_COMPLETE', sessionTitle: 'My chat', response: 'Done', durationMs: 3661000, completionKey: 'prompt|assistant' };
  callbacks.message(success, sender); callbacks.message(success, sender); await pause();
  assert.equal(notifications.length, 3, 'success deduplication must remain intact');
  assert.equal(notifications[2].title, 'My chat');
  assert.equal(notifications[2].iconUrl,'icons/status-success.png');
  assert.equal(notifications[2].contextMessage, 'Ответ за 1 ч 1 мин 1 с');
  callbacks.message({ ...success, completionKey: 'unknown', durationMs: null }, sender); await pause();
  assert.equal(notifications[3].contextMessage, '', 'unknown duration leaves subtitle empty');
  // Goal intermediate responses keep status accounting but emit neither OS notice nor sound.
  const quietGoalKey='chatgpt-goal:'+sender.tab.url;
  storage[quietGoalKey]={schema:1,id:'quiet-goal',url:sender.tab.url,phase:'waiting',goal:'Synthetic notification goal',
    rules:'',continuations:0,maxContinuations:2,deadlineAt:Date.now()+60000,expectedPromptKey:'quiet-prompt',operation:null};
  const quietNoticeCount=notifications.length,quietSoundCount=soundCalls;
  const quietAnswer={...success,goalPromptKey:'quiet-prompt',goalNativeVerified:true,goalRawExact:false,
    goalNativeUserId:'quiet-user',completionKey:'quiet-prompt|answer',response:'Still working'};
  callbacks.message(quietAnswer,sender);await pause();
  assert.equal(notifications.length,quietNoticeCount,'unfinished Goal is silent');
  assert.equal(soundCalls,quietSoundCount,'unfinished Goal has no completion sound');
  assert.ok(!storage['chatgpt-status:'+sender.tab.url].notifications.some((n:any)=>n.state==='pending'),'silent Goal leaves no pending OS notification ticket');
  storage[quietGoalKey]={...storage[quietGoalKey],phase:'waiting',operation:null,lastCompletionKey:null,expectedPromptKey:'budget-prompt',continuations:2};
  callbacks.message({...quietAnswer,goalPromptKey:'budget-prompt',completionKey:'budget-prompt|answer'},sender);await pause();
  assert.equal(storage[quietGoalKey].phase,'stopped');
  assert.equal(notifications.length,quietNoticeCount,'budget exhaustion must not emit a false success notice');
  storage[quietGoalKey]={...storage[quietGoalKey],phase:'waiting',operation:null,lastCompletionKey:null,expectedPromptKey:'final-prompt',continuations:0};
  nativeGoalProof={ok:true,isLatest:true,isReadOnly:false,generating:false,hasError:false,turnStatus:'complete',assistantCompleted:true,assistantPhase:'final_answer',userId:'quiet-user',promptKey:'final-prompt',assistantKey:'answer',goalRawExact:true,goalResponse:'GOAL_COMPLETE'};
  callbacks.message({...quietAnswer,goalPromptKey:'final-prompt',completionKey:'final-prompt|answer',response:'GOAL_COMPLETE',goalRawExact:true},sender);await pause();
  assert.equal(storage[quietGoalKey].phase,'completed');
  assert.equal(notifications.length,quietNoticeCount+1,'completed Goal notifies exactly once');
  assert.ok(soundCalls>quietSoundCount,'completed Goal plays its sound');
  delete storage[quietGoalKey];nativeGoalProof=null;
  callbacks.before({ tabId: 8, method: 'POST', timeStamp: 123456, url: 'https://chatgpt.com/backend-api/f/conversation' }); await pause();
  assert.equal(injections.at(-1).target.tabId, 8);
  assert.equal(injections.at(-1).args[0], 123456);
  const tabWorld: any = {};
  runInContext(`(${injections.at(-1).func.toString()})(...${JSON.stringify(injections.at(-1).args)})`, createContext(tabWorld));
  assert.equal(tabWorld.__chatgptNotifierRequestStartedAt, 123456);
  const beforeSteer=injections.length;
  callbacks.before({tabId:8,method:'POST',timeStamp:123999,requestId:'steer-test',documentUrl:'https://chatgpt.com/c/example',url:'https://chatgpt.com/backend-api/f/steer_turn'});await pause();
  assert.equal(injections.length,beforeSteer+1,'a live watcher receives request start without reloading script files');
  assert.equal(injections.at(-1).args[0],123999);
  callbacks.before({tabId:8,method:'POST',timeStamp:124000,url:'https://chatgpt.com/backend-api/f/conversation/prepare'});await pause();
  assert.equal(injections.length,beforeSteer+1,'preparation must not count as a submitted message');
  assert.ok(requestSignals.some(m=>m.type==='CHATGPT_CONVERSATION_REQUEST_STARTED'&&m.startedAt===123999));
  const beforeMissing=injections.length;missingWatcher=true;
  callbacks.before({tabId:8,method:'POST',timeStamp:125000,url:'https://chatgpt.com/backend-api/f/conversation'});await pause();
  assert.equal(injections.length,beforeMissing+2,'a missing receiver still gets timing plus one fallback installation');
  assert.ok(injections.at(-1).files.includes('status-indicator.js'));
  assert.equal(requestSignals.filter(m=>m.type==='CHATGPT_CONVERSATION_REQUEST_STARTED'&&m.startedAt===125000).length,2,'start is redelivered only after the missing receiver is installed');
  assert.ok(notifications.every(n => !/click to return/i.test(n.contextMessage)));
  const record={reasoningEffort:'max',reasoningModel:'gpt-6-thinking',id:'handoff-test',sourceUrl:'https://chatgpt.com/c/source',sourceTitle:'Original name',text:'complete history'};
  Object.assign(workerContext,{record});
  const begun=await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_BEGIN',record},7)",workerContext);
  assert.equal(begun.record.stage,'navigating');
  assert.equal(begun.record.naming.title,'Original name (1)');
  assert.equal((await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_BEGIN',record},7)",workerContext)).ok,false);
  await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'preparing'},7)",workerContext);
  await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'sending'},7)",workerContext);
  await assert.rejects(runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'preparing'},7)",workerContext));
  await assert.rejects(runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'sent',targetUrl:'https://chatgpt.com/c/local-chatgpt%3Afixture-id'},7)",workerContext));
  await assert.rejects(runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'sent',targetUrl:record.sourceUrl},7)",workerContext));
  await assert.rejects(runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'sent',targetUrl:'https://chatgpt.com/c/target'},7)",workerContext));
  await runInContext("handleHandoffMessage({type:'HANDOFF_CLICK_RECEIPT',id:record.id,receipt:{operationId:record.id,submittedText:'complete history',clickedAt:123}},7)",workerContext);
  handoffProof={accepted:true,targetUrl:'https://chatgpt.com/c/target',messageId:'accepted-message'};
  activeTab={id:7,url:'https://chatgpt.com/c/target'};
  await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_RECONCILE',id:record.id},7)",workerContext);
  assert.equal(storage['chatgpt-handoff:7'].text,'complete history');
  const sendGuard=(options:any)=>new Promise<any>(resolve=>callbacks.message({type:'CHATGPT_COMPOSER_CONTROL',options},sender,resolve));
  const injectBefore=injections.length;
  assert.equal((await sendGuard({action:'send',text:'User draft',url:sender.tab.url})).ok,false);
  assert.equal(injections.length,injectBefore,'unlogged draft must not reach the page');
  storage['chatgpt-retry-message']='Finish the remaining checks.';
  await runInContext("appendJournal({kind:'retry.send_intent',operationId:'only-once',text:'Finish the remaining checks.',promptKey:'/c/example|user-turn'}, {id:7,url:'https://chatgpt.com/c/example'})",workerContext);
  assert.equal((await sendGuard({action:'send',text:'User draft',operationId:'only-once',url:sender.tab.url})).ok,false);
  assert.equal(injections.length,injectBefore,'even a logged operation cannot substitute a user draft');
  const options={action:'send',text:'Finish the remaining checks.',operationId:'only-once',url:sender.tab.url};
  storage['chatgpt-retry-message']='New preference';
  assert.equal((await sendGuard(options)).ok,false,'changing settings invalidates the old retry text');
  storage['chatgpt-retry-message']=options.text;
  assert.equal((await sendGuard(options)).clicked,true);
  assert.equal((await sendGuard(options)).ok,false,'one operation may dispatch only once');
  assert.equal(injections.length,injectBefore+1);
  // Goal E2E through the real worker message router, journal grants, native
  // composer protection and exact native-final completion handling.
  // No Chrome/browser access or network calls are used.
  await runInContext("appendJournal({kind:'retry.confirmed',operationId:'only-once'}, {id:7,url:'https://chatgpt.com/c/example'})",workerContext);
  activeTab={id:7,url:'https://chatgpt.com/c/example'};
  const goalPopup={id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')};
  const goalControl=(payload:any,origin:any=goalPopup)=>new Promise<any>(resolve=>
    callbacks.message({type:'CHATGPT_GOAL_CONTROL',expectedTabId:7,
      expectedUrl:'https://chatgpt.com/c/example',...payload},origin,resolve));
  assert.equal((await goalControl({action:'start',goal:'Verify CI and merge safely',
    rules:'Native answer must finish',maxContinuations:2,maxMinutes:30},{...goalPopup,id:'another-extension'})).ok,false);
  const begunGoal=await goalControl({action:'start',goal:'Verify CI and merge safely',
    rules:'Native answer must finish',maxContinuations:2,maxMinutes:30});
  assert.equal(begunGoal.ok,true);
  const goalUrl='https://chatgpt.com/c/example';
  const goalKey='chatgpt-goal:'+goalUrl;
  let goal=storage[goalKey];
  assert.equal(goal.phase,'preparing');
  assert.equal(requestSignals.filter(m=>m.type==='CHATGPT_GOAL_DISPATCH'&&m.goalId!=='quiet-goal').length,1);
  const goalText=goal.operation.text,goalOperation=goal.operation.id,goalId=goal.id;
  assert.ok(goalText.includes('GOAL_COMPLETE')&&goalText.includes('Verify CI and merge safely'));
  const goalSender={tab:{id:7,url:goalUrl}};
  const goalCall=(type:string,payload:any)=>new Promise<any>(resolve=>
    callbacks.message({type,url:goalUrl,goalId,operationId:goalOperation,...payload},goalSender,resolve));
  assert.equal((await goalCall('CHATGPT_GOAL_CHECK',{})).ok,true);
  assert.equal((await sendGuard({action:'send',text:goalText,url:goalUrl,operationId:goalOperation})).ok,false,
    'a reserved Goal without intent cannot bypass journal authorization');
  assert.equal((await goalCall('CHATGPT_GOAL_INTENT',{text:goalText,baselineKey:'/c/example|previous-user'})).ok,true);
  assert.equal((await sendGuard({action:'send',text:'User draft',url:goalUrl,operationId:goalOperation})).ok,false,
    'Goal authorization cannot send user-draft substitution');
  assert.equal((await sendGuard({action:'send',text:goalText,url:goalUrl,operationId:goalOperation})).clicked,true);
  assert.equal((await sendGuard({action:'send',text:goalText,url:goalUrl,operationId:goalOperation})).ok,false,
    'Goal has one persisted click grant even after a repeated worker message');
  assert.equal((await goalCall('CHATGPT_GOAL_STATUS',{status:'clicked'})).ok,true);
  const goalRequestAt=Date.now();
  callbacks.before({tabId:7,method:'POST',timeStamp:goalRequestAt,requestId:'goal-native-request',documentUrl:goalUrl,url:'https://chatgpt.com/backend-api/f/conversation'});await pause();
  nativeGoalProof={ok:true,url:goalUrl,isLatest:true,isReadOnly:false,userId:'goal-native-user',userSentAtMs:goalRequestAt,
    userText:goalText,userVisibleText:'Collapsed text… Show more',promptKey:'/c/example|goal-user-1'};
  assert.equal((await goalCall('CHATGPT_GOAL_STATUS',{status:'confirmed',requestId:'goal-native-request',startedAt:goalRequestAt})).ok,true);
  nativeGoalProof=null;
  goal=storage[goalKey];assert.equal(goal.phase,'waiting');
  const goalCompletion={...success,requestId:'goal-native-request',attemptId:String(goalRequestAt),completionStartedAt:goalRequestAt,response:'GOAL_COMPLETE',completionKey:'/c/example|goal-user-1|goal-assistant-1',
    goalPromptKey:'/c/example|goal-user-1',goalNativeUserId:'goal-native-user',goalNativeVerified:true,goalRawExact:true};
  nativeGoalProof={ok:true,isLatest:true,isReadOnly:false,generating:false,hasError:false,turnStatus:'complete',assistantCompleted:true,assistantPhase:'final_answer',userId:'goal-native-user',promptKey:'/c/example|goal-user-1',assistantKey:'goal-assistant-1',goalRawExact:true,goalResponse:'GOAL_COMPLETE'};
  callbacks.message(goalCompletion,goalSender);await pause();
  goal=storage[goalKey];
  assert.equal(goal.phase,'completed','only the native-final, entire marker completes the Goal');
  assert.equal(requestSignals.filter(m=>m.type==='CHATGPT_GOAL_DISPATCH'&&m.goalId!=='quiet-goal').length,1,
    'exact marker cannot schedule a second continuation');
  callbacks.message({...goalCompletion,completionKey:'/c/example|goal-user-1|goal-assistant-2',
    response:'GOAL_COMPLETE is a word',goalRawExact:false},goalSender);
  await pause();
  assert.equal(requestSignals.filter(m=>m.type==='CHATGPT_GOAL_DISPATCH'&&m.goalId!=='quiet-goal').length,1,
    'duplicate or later completion cannot restart Goal');
  console.log('PASS: Goal popup -> journal -> native send gate -> confirmed answer -> exact marker');

  console.log('PASS: worker forbids user drafts, enforces persisted exact command and one-use send');
  console.log('PASS: durable handoff state, source deduplication, no resend after sending');
  console.log('PASS: error title/body, repeat attempts, success deduplication, existing-tab activation, request-start activation');

  const recoveries:any[]=[];
  Object.assign(workerContext,{recoveries});
  runInContext('renameSavedHandoff=async(tabId,id,options)=>{recoveries.push({tabId,id,options});return {ok:true,title:"Original name (1)"}}',workerContext);
  const popupSender={id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')};
  const titleMessage=(message:any,origin:any=popupSender)=>new Promise<any>(resolve=>callbacks.message(message,origin,resolve));
  const legacy={...storage['chatgpt-handoff:7'],targetUrl:'https://chatgpt.com/c/local-chatgpt%3Alegacy-alias',
    titleStatus:'failed',titleReason:'Открыт другой чат; переименование отменено'};
  activeTab={id:7,url:'https://chatgpt.com/c/target'};
  storage['chatgpt-handoff:7']=legacy;
  const info=await titleMessage({type:'CHATGPT_HANDOFF_TITLE_INFO'});
  assert.equal(info.available,true);assert.equal(info.desiredTitle,'Original name (1)');
  assert.equal(recoveries.length,0,'showing the saved title never starts recovery');
  const request={...info,type:'CHATGPT_HANDOFF_RENAME_RECOVER'};
  for(const origin of [sender,{...popupSender,id:'other-extension'},{...popupSender,url:chrome.runtime.getURL('journal.html')}]) {
    assert.equal((await titleMessage({type:'CHATGPT_HANDOFF_TITLE_INFO'},origin)).ok,false);
    assert.equal((await titleMessage(request,origin)).ok,false,'only the exact own popup may authorize legacy recovery');
  }
  assert.equal(recoveries.length,0);
  assert.equal((await titleMessage({...request,desiredTitle:'Substituted title'})).ok,false);
  activeTab={id:8,url:'https://chatgpt.com/c/other'};
  assert.equal((await titleMessage(request)).ok,false);assert.equal(recoveries.length,0,'changing active tab invalidates the shown destination');
  activeTab={id:7,url:'https://chatgpt.com/c/target'};
  assert.equal((await titleMessage(request)).ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(recoveries)),[{tabId:7,id:'handoff-test',options:{recoverTemporaryTarget:true}}]);
  for(const changed of [
    {...legacy,previousTitle:undefined},{...legacy,titleSaveStartedAt:undefined},
    {...legacy,stage:'sending'},{...legacy,titleStatus:'saving'},{...legacy,titleStatus:'confirmed'},
    {...legacy,titleReason:'Server timeout'},{...legacy,targetUrl:'https://chatgpt.com/c/permanent'},
    {...legacy,naming:{...legacy.naming,title:'Forged title'}}
  ]) {
    storage['chatgpt-handoff:7']=changed;
    assert.equal((await titleMessage({type:'CHATGPT_HANDOFF_TITLE_INFO'})).available,false);
    assert.equal((await titleMessage(request)).ok,false);
  }
  assert.equal(recoveries.length,1,'unknown save outcomes and nonlegacy records never enter recovery');
  console.log('PASS: explicit own-popup-only legacy title recovery, current-tab/title binding and unknown-save refusal');
}
async function popupRecoveryCheck() {
  const {document,window}=parseHTML(readFileSync('extension/popup.html','utf8'));
  const messages:any[]=[];
  let finishRecovery:(result:any)=>void=()=>{};
  const info={ok:true,available:true,operationId:'legacy-op',tabId:7,targetUrl:'https://chatgpt.com/c/target',desiredTitle:'Saved title (2)'};
  const goalUrl='https://chatgpt.com/c/popup-fixture';
  const goalPhases:Record<string,string>={start:'preparing',pause:'paused',resume:'preparing',stop:'stopped'};
  const preferences:Record<string,unknown>={};
  const ctx=createContext({document,chrome:{storage:{local:{get:async()=>preferences,set:async(values:Record<string,unknown>)=>Object.assign(preferences,values)}},runtime:{sendMessage:async(message:any)=>{
    messages.push(message);
    if(message.type==='CHATGPT_HANDOFF_TITLE_INFO')return info;
    if(message.type==='CHATGPT_HANDOFF_RENAME_RECOVER')return new Promise(resolve=>{finishRecovery=resolve;});
    if(message.type==='CHATGPT_GOAL_CONTROL') {
      if(message.action==='get')return {ok:true,tabId:7,url:goalUrl,record:null};
      return {ok:true,record:{id:'popup-goal',phase:goalPhases[message.action],
        goal:'Finalize popup goal',rules:'',maxContinuations:2,maxMinutes:15,
        continuations:0,deadlineAt:Date.now()+60_000,operation:null}};
    }
    return {ok:true};
  }},tabs:{create(){}}}});
  runInContext(readFileSync('extension/goal-policy.js','utf8'),ctx);
  runInContext(readFileSync('extension/popup.js','utf8'),ctx);
  await waitFor(()=>(document.getElementById('retry-save') as HTMLButtonElement).disabled===false);
  const retryInput=document.getElementById('retry-message') as HTMLTextAreaElement;
  assert.equal(retryInput.value,'доделай е2е');
  retryInput.value='  Finish the remaining checks.  ';
  document.getElementById('retry-form')!.dispatchEvent(new window.Event('submit',{cancelable:true}));
  await waitFor(()=>preferences['chatgpt-retry-message']==='Finish the remaining checks.');

  await Promise.resolve();await Promise.resolve();
  assert.equal(document.getElementById('title-recovery')!.hidden,false);
  assert.equal(document.getElementById('desired-title')!.textContent,'Saved title (2)');
  assert.deepEqual(messages.map(item=>item.type).sort(),
    ['CHATGPT_GOAL_CONTROL','CHATGPT_HANDOFF_TITLE_INFO'].sort(),
    'opening the popup only reads Goal state and recovery information');
  assert.equal(messages.find(item=>item.type==='CHATGPT_GOAL_CONTROL')?.action,'get');
  await waitFor(()=>(document.getElementById('goal-start') as HTMLButtonElement).disabled===false);
  (document.getElementById('goal-text') as HTMLTextAreaElement).value='Finalize popup goal';
  const actions:[string,string,string|null][]=[
    ['start','goal-start','goal-pause'],['pause','goal-pause','goal-resume'],
    ['resume','goal-resume','goal-stop'],['stop','goal-stop',null]
  ];
  for(const [action,id,nextId] of actions) {
    const control=document.getElementById(id) as HTMLButtonElement;
    assert.equal(control.disabled,false,action+' control must be available');
    control.dispatchEvent(new window.Event('click'));
    await waitFor(()=>messages.some(item=>item.type==='CHATGPT_GOAL_CONTROL'&&item.action===action));
    const sent=messages.filter(item=>item.type==='CHATGPT_GOAL_CONTROL'&&item.action===action);
    assert.equal(sent.length,1,action+' must dispatch once');
    assert.equal(sent[0].expectedTabId,7);
    assert.equal(sent[0].expectedUrl,goalUrl,'actions remain bound to the initial chat');
    if(action==='start')assert.equal(sent[0].goal,'Finalize popup goal');
    if(nextId)await waitFor(()=>(document.getElementById(nextId) as HTMLButtonElement).disabled===false);
    // The worker receives the message before popup's async continuation paints
    // the saved result. Wait for the actual UI state, including terminal Stop.
    if(action==='stop')await waitFor(()=>/Stopped/.test(document.getElementById('goal-status')!.textContent||''));
  }
  assert.match(document.getElementById('goal-status')!.textContent||'',/Stopped/);
  const button=document.getElementById('recover-title')!;
  button.dispatchEvent(new window.Event('click'));
  button.dispatchEvent(new window.Event('click'));
  const recoverRequests=messages.filter(item=>item.type==='CHATGPT_HANDOFF_RENAME_RECOVER');
  assert.equal(recoverRequests.length,1,'explicit duplicate clicks issue one recovery request');
  assert.equal(recoverRequests[0].desiredTitle,'Saved title (2)');
  assert.equal(recoverRequests[0].targetUrl,info.targetUrl);
  finishRecovery({ok:true});await pause();
  assert.equal(document.getElementById('title-recovery')!.hidden,true);
  assert.equal(document.getElementById('status')!.textContent,'Chat title restored.');
  console.log('PASS: popup previews exact saved title and waits for an explicit one-use recovery click');
}
async function notificationStatusCheck() {
  const a='https://chatgpt.com/c/chat-a',b='https://chatgpt.com/c/chat-b';
  const storage:Record<string,any>={};
  const tabs:Record<number,any>={7:{id:7,url:a,active:false,windowId:1},8:{id:8,url:b,active:false,windowId:1},9:{id:9,url:a,active:false,windowId:1}};
  let focused=true,deferCreates=false,focusEffects=0;
  const created=new Set<string>(),cleared:string[]=[],pending:{id:string;resolve:(id:string)=>void}[]=[];
  const notices:{id:string;options:any}[]=[],statusMessages:any[]=[];
  let gate:Promise<void>|null=null;
  let queryGate:Promise<void>|null=null;
  let beforeWindowRead:(()=>void)|null=null;
  let requestSequence=2000;
  const flush=()=>new Promise(resolve=>setTimeout(resolve,20));
  function boot() {
    const callbacks:Record<string,any>={};
    const event=(name:string)=>({addListener:(fn:any)=>{callbacks[name]=fn;}});
    const chrome={
      storage:{local:{get:async(key:string|string[]|null)=>structuredClone(key===null?storage:Object.fromEntries((Array.isArray(key)?key:[key]).map(name=>[name,storage[name]]))),set:async(value:any)=>Object.assign(storage,structuredClone(value))}},
      runtime:{id:'test-extension',onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup'),getManifest:()=>({version:'test'}),getURL:(path:string)=>`chrome-extension://test-extension/${path}`,getContexts:async()=>[{}],sendMessage:async()=>{}},
      webRequest:{onBeforeRequest:event('before'),onCompleted:event('complete'),onErrorOccurred:event('error')},
      tabs:{query:async()=>{const wait=queryGate;queryGate=null;if(wait)await wait;return Object.values(tabs);},get:async(id:number)=>{const wait=gate;gate=null;if(wait)await wait;return {...tabs[id]};},
        sendMessage:async(id:number,message:any)=>{statusMessages.push({id,...message});},onRemoved:event('removed'),onUpdated:event('updated'),onActivated:event('activated'),update:async()=>{focusEffects++;}},
      windows:{get:async()=>{const hook=beforeWindowRead;beforeWindowRead=null;hook?.();return {focused};},onFocusChanged:event('focused'),update:async()=>{focusEffects++;}},
      scripting:{executeScript:async()=>[{result:{ok:true}}]},
      notifications:{create:async(id:string,options:any)=>{
        notices.push({id,options});
        if(deferCreates)return new Promise<string>(resolve=>pending.push({id,resolve:(result)=>{created.add(id);resolve(result);}}));
        created.add(id);return id;
      },clear:async(id:string)=>{cleared.push(id);return created.delete(id);},onClicked:event('clicked'),onClosed:event('closed')}
    };
    const ctx=createContext({chrome,console,URL,setTimeout,clearTimeout,Date:class extends Date{static now(){return 123456;}}});
    Object.assign(ctx,{importScripts:(name:string)=>runInContext(readFileSync(`extension/${name}`,'utf8'),ctx)});
    runInContext(worker,ctx);
    const sender=(tabId=7)=>({frameId:0,tab:{...tabs[tabId]}});
    const request=(type:string,url=tabs[7].url,origin=sender(),extra:any={})=>new Promise<any>(resolve=>callbacks.message({type,url,...extra},origin,resolve));
    const startRequest=(url=tabs[7].url)=>{
      const startedAt=++requestSequence;
      callbacks.before({tabId:7,method:'POST',timeStamp:startedAt,documentUrl:url,url:'https://chatgpt.com/backend-api/f/conversation'});
      return startedAt;
    };
    return {callbacks,sender,
      emit:async(tabId:number,key:string,isError=true)=>{ctx.fixtureTabId=tabId;const existing=runInContext('manualRequestReceiptsByTab.get(fixtureTabId)',ctx);const startedAt=existing?.startedAt??++requestSequence;if(!isError&&!existing){ctx.fixtureTabId=tabId;ctx.fixtureStartedAt=startedAt;ctx.fixtureUrl=tabs[tabId].url;runInContext('manualRequestReceiptsByTab.set(fixtureTabId,{startedAt:fixtureStartedAt,receipt:statusReceipt(),url:fixtureUrl})',ctx);}callbacks.message({attemptId:String(startedAt),completionStartedAt:startedAt,type:isError?'CHATGPT_RESPONSE_ERROR':'CHATGPT_RESPONSE_COMPLETE',url:tabs[tabId].url,sessionTitle:'Title',response:'Result',completionKey:key,fingerprint:key},sender(tabId));await flush();},
      warning:async(tabId:number)=>{callbacks.message({type:'CHATGPT_OPERATION_WARNING',url:tabs[tabId].url,sessionTitle:'Title',response:'Synthetic handoff metadata warning',warningKind:'handoff',operationId:'synthetic-handoff'},sender(tabId));await flush();},
      broadcast:(view:any)=>{ctx.externalView=view;return runInContext('broadcastChatStatus(externalView)',ctx) as Promise<void>;},
      request,startRequest,manual:(url=tabs[7].url)=>request('CHATGPT_MANUAL_SEND',url,sender(),{startedAt:startRequest(url)})};
  }
  let h=boot();await flush();
  await h.emit(7,'a-1');await h.emit(7,'a-2');await h.emit(8,'b-1');
  const aIds=notices.slice(0,2).map(n=>n.id),bId=notices[2].id;
  assert.equal(new Set(aIds).size,2,'multiple alerts in one chat have distinct durable IDs');
  const oldRevision=(await h.request('CHATGPT_STATUS_GET',a)).revision;
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true,'a background result is unread and passive status GET cannot acknowledge it');
  tabs[7].active=false;
  await h.request('CHATGPT_PAGE_RETURNED',a);assert.equal(cleared.length,0,'an inactive tab cannot clear notifications');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true);
  tabs[7].active=true;focused=false;
  await h.request('CHATGPT_PAGE_RETURNED',a);assert.equal(cleared.length,0,'an unfocused window cannot clear notifications');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true);
  focused=true;
  h=boot();await flush();
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.kind,'error','tab state survives worker restart');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true,'unread state survives worker restart');
  await h.request('CHATGPT_PAGE_RETURNED',a);
  assert.ok(aIds.every(id=>!created.has(id)),'a visit clears every persisted notification for that chat');
  assert.ok(created.has(bId),'a matching visit leaves another chat notification alone');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.kind,'error','focus does not reset the tab indicator');
  const seen=(await h.request('CHATGPT_STATUS_GET',a));
  assert.equal(seen.status.unread,false);assert.equal(seen.revision,oldRevision+1,'the visit removes only the badge with a new revision');
  assert.equal((await h.request('CHATGPT_STATUS_GET',b,h.sender(8))).status.unread,true,'reading A never acknowledges B');
  await flush();
  assert.ok([7,9].every(id=>statusMessages.some(message=>message.id===id&&message.url===a&&message.status?.unread===false&&message.status.kind==='error')),'a real visit broadcasts the seen color to every matching tab');
  h=boot();await flush();
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,false,'seen state survives another worker restart');
  const staleSender=h.sender();tabs[7].url=b;
  assert.equal((await h.request('CHATGPT_PAGE_RETURNED',a,staleSender)).ok,false,'a route-changed sender cannot clear its old chat');
  assert.ok(created.has(bId));
  tabs[7].url=a;
  const reset=await h.manual(a);
  await flush();
  assert.equal(reset.status.kind,'loading');assert.ok(reset.revision>oldRevision);
  assert.ok(statusMessages.some(message=>message.type==='CHATGPT_STATUS_CHANGED'&&message.url===a&&message.status?.kind==='loading'));
  assert.equal(focusEffects,0,'notification retirement never activates a tab or focuses a window');
  assert.equal((await h.request('CHATGPT_GENERATION_STOPPED',a,h.sender(),{startedAt:reset.status.eventAt+1})).status.kind,'loading','a stale stop cannot cancel another request');
  const stopped=await h.request('CHATGPT_GENERATION_STOPPED',a,h.sender(),{startedAt:reset.status.eventAt});
  assert.equal(stopped.status,null,'a confirmed manual stop retires its own loader');
  const autoStart=h.startRequest(a);await flush();
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.kind,'loading','a real automatic request also starts the loader');
  await h.emit(7,'completed-after-loading',false);
  assert.equal((await h.request('CHATGPT_GENERATION_STOPPED',a,h.sender(),{startedAt:autoStart})).status.kind,'success','a late stop cannot erase a completed result');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,false,'a result verified in the active focused tab is already seen');


  deferCreates=true;
  tabs[7].active=false;
  await h.emit(7,'pending-old');
  const old=pending.shift()!;
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true);
  tabs[7].active=true;
  await h.request('CHATGPT_PAGE_RETURNED',a);
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,false,'visit acknowledges the result even before OS creation resolves');
  tabs[7].active=false;
  h.startRequest(a);
  await h.emit(7,'pending-new',false);
  const fresh=pending.shift()!;
  old.resolve(old.id);fresh.resolve(fresh.id);await flush();
  assert.equal(created.has(old.id),false,'a return before create resolves clears its eventual notification');
  assert.equal(created.has(fresh.id),true,'a later generation is not cleared by the earlier return');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.kind,'success');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true,'late creation of the viewed result cannot acknowledge the newer one');
  tabs[7].active=true;
  deferCreates=false;
  let release:()=>void=()=>{};
  gate=new Promise<void>(resolve=>{release=resolve;});
  const visit=h.request('CHATGPT_PAGE_RETURNED',a);
  tabs[7].active=false;
  h.startRequest(a);
  await h.emit(7,'after-return',false);
  const afterReturn=notices.at(-1)!.id;
  tabs[7].active=true;
  release();await visit;
  assert.ok(created.has(afterReturn),'async focus verification does not swallow a later event');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true,'an older delayed visit cannot acknowledge a later background terminal result');
  gate=new Promise<void>(resolve=>{release=resolve;});
  const manual=h.manual(a);
  await h.emit(7,'after-manual',false);
  const afterManual=notices.at(-1)!.id;
  release();await manual;
  assert.ok(created.has(afterManual));
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.kind,'success','a newer result survives an older manual reset');
  tabs[7].active=false;
  const fastStartedAt=h.startRequest(a);
  await h.emit(7,'fast-before-manual-message',false);
  const fast=notices.at(-1)!.id;
  assert.equal((await h.request('CHATGPT_MANUAL_SEND',a,h.sender(),{startedAt:fastStartedAt+1})).ok,false);
  const lateReset=await h.request('CHATGPT_MANUAL_SEND',a,h.sender(),{startedAt:fastStartedAt});
  assert.equal(lateReset.status.kind,'success','a fast result before delayed MANUAL_SEND survives the earlier request fence');
  assert.equal(lateReset.status.unread,true,'an earlier manual request cannot acknowledge its later background result');
  assert.ok(created.has(fast));
  assert.equal((await h.request('CHATGPT_MANUAL_SEND',a,h.sender(),{startedAt:fastStartedAt})).ok,false,'one captured request cannot be replayed as a later reset');
  tabs[7].active=true;h.callbacks.activated({tabId:7});await flush();
  assert.equal(created.has(afterManual),false,'native tab activation clears a visible chat');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.kind,'success');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,false,'native tab activation removes the unread dot without resetting success');
  focused=false;await h.emit(7,'window-return');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true);
  h.callbacks.focused(1);await flush();assert.ok(created.has(notices.at(-1)!.id));
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,true,'unfocused Chrome cannot mark a result viewed');
  focused=true;h.callbacks.focused(1);await flush();assert.equal(created.has(notices.at(-1)!.id),false);
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,false,'window focus removes only unread state');
  await h.emit(7,'closed-live');
  const closed=notices.at(-1)!.id,revisionBeforeClose=(await h.request('CHATGPT_STATUS_GET',a)).revision;
  const journalBefore=JSON.stringify(Object.fromEntries(Object.entries(storage).filter(([key])=>key.startsWith('chatgpt-journal:event:'))));
  created.delete(closed);h.callbacks.closed(closed,true);await flush();
  assert.ok(!storage[`chatgpt-status:${a}`].notifications.some((item:any)=>item.id===closed));
  assert.ok(storage[`chatgpt-status:${b}`].notifications.some((item:any)=>item.id===bId));
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.kind,'error');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).revision,revisionBeforeClose);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(storage).filter(([key])=>key.startsWith('chatgpt-journal:event:')))),journalBefore,'OS closure does not rewrite the journal');
  deferCreates=true;await h.emit(7,'closed-before-create-reply');
  const pendingClose=pending.shift()!;
  created.add(pendingClose.id);created.delete(pendingClose.id);h.callbacks.closed(pendingClose.id,true);await flush();
  assert.equal(storage[`chatgpt-status:${a}`].notifications.find((item:any)=>item.id===pendingClose.id).closed,true,'an unresolved create retains a closed tombstone');
  pendingClose.resolve(pendingClose.id);await flush();
  assert.equal(created.has(pendingClose.id),false,'a late create reply cannot resurrect a closed notification');
  assert.ok(!storage[`chatgpt-status:${a}`].notifications.some((item:any)=>item.id===pendingClose.id));
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.kind,'error');deferCreates=false;
  await h.emit(7,'window-check-route');
  const switched=notices.at(-1)!.id;
  beforeWindowRead=()=>{tabs[7].url=b;};
  await h.request('CHATGPT_PAGE_RETURNED',a);
  assert.ok(created.has(switched),'a route change while window focus is checked must not clear the earlier chat');
  tabs[7].url=a;
  const emitting=h.emit(7,'captured-source');tabs[7].url=b;await emitting;
  const captured=notices.at(-1)!.id;
  assert.ok(storage[`chatgpt-status:${a}`].notifications.some((item:any)=>item.id===captured),'an async create keeps its captured source chat');
  assert.ok(!storage[`chatgpt-status:${b}`].notifications.some((item:any)=>item.id===captured));
  h.callbacks.updated(7,{url:b},{...tabs[7]});await flush();
  assert.ok(created.has(captured),'a route change clears the visited chat, never the previous source');
  assert.equal(created.has(bId),false);
  assert.equal((await h.request('CHATGPT_STATUS_GET',b)).status.unread,false,'SPA visit acknowledges its current chat');
  assert.equal(storage[`chatgpt-status:${a}`].status.unread,true,'SPA visit cannot acknowledge the previous chat');
  await h.callbacks.clicked(captured);
  assert.equal(focusEffects,0,'clicking an old alert never focuses an unrelated chat now occupying that tab');
  tabs[7].url=a;tabs[7].active=false;
  const oldView=await h.request('CHATGPT_STATUS_GET',a);
  const beforeBroadcast=statusMessages.length;
  queryGate=new Promise<void>(resolve=>{release=resolve;});
  const oldBroadcast=h.broadcast(oldView);
  const loadingStart=h.startRequest(a);await flush();
  const loadingView=await h.request('CHATGPT_STATUS_GET',a);
  assert.equal(loadingView.status.kind,'loading');
  release();await oldBroadcast;
  assert.equal(statusMessages.slice(beforeBroadcast).some(message=>message.type==='CHATGPT_STATUS_CHANGED'&&message.url===a&&message.revision===oldView.revision),false,'a stale terminal broadcast cannot retire the newer loader subscription');
  const beforeTick=statusMessages.filter(message=>message.type==='CHATGPT_STATUS_TICK').length;
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.ok(statusMessages.filter(message=>message.type==='CHATGPT_STATUS_TICK').length>beforeTick,'the newer loader keeps its clock after an older query finishes');
  await h.warning(7);
  const afterWarning=await h.request('CHATGPT_STATUS_GET',a);
  assert.equal(afterWarning.status.kind,'loading');assert.equal(afterWarning.revision,loadingView.revision,'handoff warnings never overwrite an actual running request');
  assert.equal(notices.at(-1)!.options.iconUrl,'icons/icon128.png','metadata warnings use a neutral notification icon');
  assert.ok(Object.values(storage).some((row:any)=>row?.kind==='operation.warning'&&row.warningKind==='handoff'));
  await h.emit(7,'genuine-response-failed');
  const realFailure=await h.request('CHATGPT_STATUS_GET',a);
  assert.equal(realFailure.status.kind,'error');assert.equal(realFailure.status.unread,true,'a genuine response error remains red and unread');
  await h.warning(7);
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).revision,realFailure.revision,'operational metadata cannot replace or acknowledge a real terminal error');
  assert.equal((await h.request('CHATGPT_GENERATION_STOPPED',a,h.sender(),{startedAt:loadingStart})).status.kind,'error');
  tabs[9].active=true;
  await h.emit(7,'same-chat-visible-in-another-tab');
  assert.equal((await h.request('CHATGPT_STATUS_GET',a)).status.unread,false,'an already visible duplicate tab views its chat result even when the reporting tab is in the background');
  assert.ok(created.has(notices.at(-1)!.id),'foreground acknowledgement does not change existing OS dismissal behavior');
  console.log('PASS: durable per-chat status and all notification IDs, restart, active/focused route guards, pending-create/generation races, manual-only status reset and no focus stealing');
}
async function statusMigrationCheck() {
  const url=(name:string)=>`https://chatgpt.com/c/legacy-${name}`;
  const eventKey=(sequence:number)=>`chatgpt-journal:event:${String(sequence).padStart(12,'0')}`;
  const statusKey=(name:string)=>`chatgpt-status:${url(name)}`;
  const storage:Record<string,any>={},rows:any[]=[];
  const push=(row:any)=>{const sequence=rows.length+1;const value={schema:1,sequence,recordedAt:1000,...row};rows.push(value);storage[eventKey(sequence)]=value;};
  const notice=(tabId:number,name:string,response:string,isError=true)=>push({kind:isError?'notification.requested':'response.complete',sourceUrl:url(name),tabId,title:`${name} - ChatGPT`,response});
  const result=(tabId:number,name:string,id:string,message:string,isError=true)=>push({kind:'notification.result',sourceUrl:url(name),tabId,notificationId:id,notification:'fulfilled',isError,title:`${isError?'❌ ':''}${name}`,message});
  const a1='chatgpt-prompt-bound:7:legacy-a-1',a2='chatgpt-prompt-bound:7:legacy-a-2',b='chatgpt-prompt-bound:8:legacy-b';
  const bodyMismatch='chatgpt-prompt-bound:9:unmatched-body',urlMismatch='chatgpt-prompt-bound:10:unmatched-url',unknown='chatgpt-prompt-bound:99:unknown',delayed='chatgpt-prompt-bound:20:delayed-a';
  notice(7,'a','First alert');result(7,'a',a1,'First alert');
  notice(8,'b','Completed',false);result(8,'b',b,'Completed',false);
  notice(9,'c','Captured error');result(9,'c',bodyMismatch,'Another error');
  notice(10,'d','Error with captured URL');
  push({kind:'notification.result',sourceUrl:'',tabId:10,notificationId:urlMismatch,notification:'fulfilled',isError:true,title:'❌ d',message:'Error with captured URL'});
  notice(11,'e','Enter alone');push({kind:'retry.manual_reset',sourceUrl:url('e'),tabId:11,eventAt:2000});
  notice(12,'f','Manual request');push({kind:'retry.manual_reset',sourceUrl:url('f'),tabId:12,eventAt:2000});
  push({kind:'request.started',sourceUrl:url('f'),tabId:12,eventAt:2500,automatic:false});
  notice(13,'g','Automatic request');push({kind:'retry.manual_reset',sourceUrl:url('g'),tabId:13,eventAt:2000});
  push({kind:'request.started',sourceUrl:url('g'),tabId:13,eventAt:2500,automatic:true});
  notice(14,'h','Expired intent');push({kind:'retry.manual_reset',sourceUrl:url('h'),tabId:14,eventAt:2000});
  push({kind:'request.started',sourceUrl:url('h'),tabId:14,eventAt:14000,automatic:false});
  notice(15,'i','Different destination');push({kind:'retry.manual_reset',sourceUrl:url('i'),tabId:15,eventAt:2000});
  push({kind:'request.started',sourceUrl:url('another'),tabId:15,eventAt:2500,automatic:false});
  notice(16,'k','Older than existing status');
  push({kind:'notification.requested',sourceUrl:url('spa-a'),tabId:20,title:'Same - ChatGPT',response:'Identical response'});
  push({kind:'tab.updated',sourceUrl:url('spa-b'),observedTabUrl:url('spa-b'),tabId:20,changes:{url:url('spa-b')}});
  push({kind:'notification.requested',sourceUrl:url('spa-b'),tabId:20,title:'Same - ChatGPT',response:'Identical response'});
  push({kind:'notification.result',sourceUrl:url('spa-b'),tabId:20,notificationId:delayed,notification:'fulfilled',isError:true,title:'❌ Same',message:'Identical response'});
  while(rows.length<125)push({kind:'handoff.navigating',sourceUrl:url('private'),text:'Private synthetic history\n'.repeat(100)});
  notice(7,'a','Latest alert');result(7,'a',a2,'Latest alert');
  storage['chatgpt-journal:meta']={sequence:rows.length,retrySchema:1,retryByChat:{}};
  const existing={url:url('k'),revision:999,sequence:999,returnedThrough:0,status:{kind:'success',eventAt:9000,sequence:999},notifications:[]};
  storage[statusKey('k')]=structuredClone(existing);
  const immutable=structuredClone(rows),active=new Set([a1,a2,b,bodyMismatch,urlMismatch,unknown,delayed]);
  const reads:(string|string[]|null)[]=[],writes:Record<string,any>[]=[],cleared:string[]=[];
  let getAllCalls=0,createCalls=0;
  function boot() {
    const callbacks:Record<string,any>={};
    const event=(name:string)=>({addListener:(fn:any)=>{callbacks[name]=fn;}});
    const tab={id:7,url:url('a'),active:true,windowId:1};
    const chrome={
      storage:{local:{get:async(key:string|string[]|null)=>{reads.push(key);assert.notEqual(key,null,'migration must never load all storage');return structuredClone(Object.fromEntries((Array.isArray(key)?key:[key as string]).map(name=>[name,storage[name]])));},
        set:async(value:Record<string,any>)=>{writes.push(structuredClone(value));Object.assign(storage,structuredClone(value));}}},
      runtime:{id:'test-extension',onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup'),getManifest:()=>({version:'test'}),getURL:(path:string)=>path,getContexts:async()=>[{}],sendMessage:async()=>{}},
      webRequest:{onBeforeRequest:event('before'),onCompleted:event('complete'),onErrorOccurred:event('error')},
      tabs:{get:async()=>tab,query:async()=>[tab],sendMessage:async()=>{},onRemoved:event('removed')},windows:{get:async()=>({focused:true})},
      notifications:{getAll:async()=>{getAllCalls++;return Object.fromEntries(Array.from(active,id=>[id,{}]));},clear:async(id:string)=>{cleared.push(id);return active.delete(id);},create:async()=>{createCalls++;throw new Error('Migration must not renotify');},onClicked:event('clicked')}
    };
    const ctx=createContext({chrome,console,URL,setTimeout,clearTimeout});
    Object.assign(ctx,{importScripts:(name:string)=>runInContext(readFileSync(`extension/${name}`,'utf8'),ctx)});
    runInContext(worker,ctx);
    return {ctx,tab,visit:()=>new Promise<any>(resolve=>callbacks.message({type:'CHATGPT_PAGE_RETURNED',url:tab.url},{frameId:0,tab},resolve))};
  }
  let h=boot();await pause();
  const first=runInContext(`readChatStatus(${JSON.stringify(url('a'))})`,h.ctx);
  const second=runInContext(`readChatStatus(${JSON.stringify(url('b'))})`,h.ctx);
  const live=runInContext(`reserveChatNotification(${JSON.stringify(url('a'))},7,'success',9000,statusReceipt())`,h.ctx);
  assert.equal((await first).status.kind,'error');assert.equal((await second).status.kind,'success');
  const reservation=await live;
  Object.assign(h.ctx,{ticket:reservation.ticket});await runInContext('completeChatNotification(ticket,false)',h.ctx);
  assert.equal(storage[statusKey('a')].status.kind,'success','a live update queued during migration cannot be overwritten by its seed');
  assert.equal(storage[statusKey('a')].notifications.length,2,'all proven active legacy IDs are imported');
  assert.equal(storage[statusKey('c')].notifications.length,0);assert.equal(storage[statusKey('d')].notifications.length,0);
  assert.equal(storage[statusKey('spa-a')].status.kind,'error');assert.equal(storage[statusKey('spa-b')].status.kind,'error');
  assert.equal(storage[statusKey('spa-b')].notifications.length,0,'a delayed legacy result cannot borrow the later SPA chat identity even with identical title/body');
  assert.equal(storage[statusKey('e')].status.kind,'error','an Enter reset without a request preserves the indicator');
  assert.equal(storage[statusKey('e')].status.unread,false,'legacy results have no invented unread history');
  assert.equal(storage[statusKey('f')].status,null,'a matching actual manual request clears the seed');
  for(const name of ['g','h','i'])assert.equal(storage[statusKey(name)].status.kind,'error');
  assert.deepEqual(storage[statusKey('k')],existing,'existing live records are never replaced');
  const migrated=writes.filter(value=>value['chatgpt-status:migration']);
  assert.equal(migrated.length,1,'concurrent effects share one migration');
  assert.equal(migrated[0]['chatgpt-status:migration'].schema,1);
  assert.ok(migrated[0][statusKey('a')]&&migrated[0][statusKey('b')],'seeds and marker commit in one write');
  assert.ok(!Object.hasOwn(migrated[0],statusKey('k')));
  assert.equal(getAllCalls,1);assert.equal(createCalls,0);assert.equal(cleared.length,0,'migration itself only binds existing notifications');
  assert.ok(reads.some(value=>Array.isArray(value)&&value.length===50));
  assert.ok(reads.every(value=>!Array.isArray(value)||value.length<=50),'journal and status reads are bounded');
  await h.visit();
  assert.ok(!active.has(a1)&&!active.has(a2),'a genuine visit clears every proven imported notification for its chat');
  assert.ok(active.has(b),'another chat retains its notification');
  assert.ok(active.has(bodyMismatch)&&active.has(urlMismatch)&&active.has(unknown),'uncertain IDs remain untracked and untouched');
  assert.equal(storage[statusKey('a')].status.kind,'success','a visit does not clear imported or newer status');
  h.tab.url=url('spa-b');await h.visit();assert.ok(active.has(delayed),'visiting B never clears the delayed alert from A');
  for(let index=0;index<immutable.length;index++)assert.deepEqual(storage[eventKey(index+1)],immutable[index],'immutable journal rows never change');
  const batchReads=reads.filter(value=>Array.isArray(value)).length;
  h=boot();await pause();await runInContext(`readChatStatus(${JSON.stringify(url('a'))})`,h.ctx);
  assert.equal(getAllCalls,1);assert.equal(reads.filter(value=>Array.isArray(value)).length,batchReads,'restart sees the durable migration marker and does not rescan');
  console.log('PASS: one atomic bounded journal status migration, exact active legacy notification binding, manual-request proof, existing state protection, live race and immutable history');
}
if(process.argv[2]!=='worker') {
 try {await domCheck();}
 finally {for(const context of domContexts)runInContext('globalThis.__chatgptNotifierDispose?.()',context);}
}
if(process.argv[2]!=='retry-deadline'){
await workerCheck();
await popupRecoveryCheck();
await notificationStatusCheck();
await statusMigrationCheck();
}
