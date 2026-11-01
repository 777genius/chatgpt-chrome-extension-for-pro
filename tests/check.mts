import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
const content = readFileSync('extension/memory-maintenance.js', 'utf8') + '\n' +
  readFileSync('extension/content-script.js', 'utf8');
const worker = readFileSync('extension/service-worker.js', 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 220));
const alertHTML = (text: string) => `<aside role="alert" class="text-danger"><div aria-hidden="true">decorative</div><div>${text}</div><button>Повторить</button></aside>`;
const user = '<article data-testid="conversation-turn-0" data-turn="user">Question</article>';
async function domCheck() {
  function setup(draft = '', hasComposer = true, confirmSend = true, newTyping = '', savedRetry: any = null, keepRecovery = false) {
    const { document, window } = parseHTML(`<html><body><main>${user}</main>${hasComposer ? `<form><div id="prompt-textarea" contenteditable="true">${draft}</div><button data-testid="send-button" type="button">Send</button></form>` : ''}</body></html>`);
    Object.defineProperty(window.Node, 'DOCUMENT_POSITION_FOLLOWING', { value: 4, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { configurable: true, value() {
      return this.hidden || this.style.display === 'none' ? [] : [{}];
    }});
    const messages: any[] = [], sends: string[] = [], logs: any[] = [];
    let failJournal = false;let stopCalls=0;
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
      MutationObserver: window.MutationObserver, location: { pathname: '/c/example',href:'https://chatgpt.com/c/example' }, performance,
      Date: clock, setTimeout, clearTimeout, setInterval, clearInterval,
      chrome: { runtime: { id: 'test-extension', sendMessage: async (message: any) => { if(message.type==='CHATGPT_RETRY_STATE')return {ok:true,state:savedRetry}; if(message.type==='CHATGPT_WAIT'){await new Promise(r=>setTimeout(r,message.delayMs));return {ok:true};} if(message.type === 'CHATGPT_STOP_RECOVERY'){stopCalls++;assert.equal(editor!.textContent,'Сохранить мой черновик','stop must precede replacing the draft');editor!.textContent='';document.querySelector('[data-test-modern-stop]')?.remove();if(!keepRecovery)document.querySelector('[role=status]')?.remove();return {ok:true,stopped:true};} if(message.type === 'CHATGPT_COMPOSER_CONTROL'){if(message.options.action==='send'){document.querySelector('button[data-testid=send-button]')?.dispatchEvent(new window.Event('click'));return {ok:true,clicked:true};}return {ok:true,matches:true,ready:true};} if(message.type === 'CHATGPT_LOG_EVENT') {logs.push(message.event);return {ok:!failJournal};} if(message.type === 'CHATGPT_INSPECT_ERROR') return {ok:true,action:'retry'}; if(message.type === 'CHATGPT_HANDOFF_GET') return {ok:true,record:null}; messages.push(message); }, onMessage: { addListener() {} } } } });
    document.querySelector('button[data-testid="send-button"]')?.addEventListener('click', () => {
      sends.push(editor!.textContent!);
      if (!confirmSend) { setTimeout(() => { now += 11000; }, 50); return; }
      editor!.textContent = newTyping;
      main.querySelectorAll(keepRecovery?'aside':'aside,[role=status]').forEach(a => a.remove());
      main.insertAdjacentHTML('beforeend', `<article data-testid="conversation-turn-${++sequence}" data-turn="user">доделай е2е</article>`);
      if(keepRecovery){const status=main.querySelector('[role=status]');if(status)main.append(status);}
      runInContext(`globalThis.__chatgptNotifierAttemptId = '${sequence}'; globalThis.__chatgptNotifierRequestStartedAt = ${now}`, context);
    });
    runInContext(content, context);
    return { messages, sends, document, context, logs, getStopCalls(){return stopCalls;}, breakJournal(){failJournal=true;},
      advance(ms: number) { now += ms; },
      async fail(text: string) {
        main.insertAdjacentHTML('beforeend', alertHTML(text));
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    };
  }
  const afterUpdate = setup('',true,true,'',{failures:[999900],lastPromptKey:'/c/example|conversation-turn-0',lastAttemptId:'old-observed-attempt',blocked:false});
  await afterUpdate.fail('Existing error after update');
  assert.equal(afterUpdate.sends.length,0,'reload must not repeat a previously observed prompt without a new request');
  assert.equal(afterUpdate.logs.filter(e=>e.kind==='error.detected').length,0);
  const restoredBlock=setup('',true,true,'',{failures:[],blocked:true,reason:'Saved sticky stop'});
  await restoredBlock.fail('New failed prompt');
  assert.equal(restoredBlock.sends.length,0,'sticky stop survives an extension update even outside the rolling window');
  assert.match(restoredBlock.messages[0].retryReason,/Saved sticky stop/);
  const extras=setup('',true,true,'',{failures:[],remainingRetries:2,blocked:false});
  await extras.fail('Extra one');extras.advance(5000);
  await extras.fail('Extra two');extras.advance(5000);
  await extras.fail('Extra budget exhausted');
  assert.equal(extras.sends.length,2,'explicit extra budget must allow exactly two sends');
  assert.match(extras.messages[0].retryReason,/Дополнительные автоповторы исчерпаны/);
  const run = setup();
  await run.fail('Ошибка первая');
  assert.deepEqual(run.sends, ['доделай е2е']);
  assert.equal(run.messages.length, 0, 'first error retries silently');
  run.advance(30000);
  await run.fail('Ошибка с другим текстом');
  assert.equal(run.sends.length, 2);
  assert.equal(run.messages.length, 0, 'second error retries silently');
  run.advance(30000);
  await run.fail('Третья ошибка');
  assert.equal(run.sends.length,3,'third error gets the third automatic retry');
  assert.equal(run.messages.length,0);
  run.advance(30000);
  await run.fail('Четвёртая ошибка');
  assert.equal(run.sends.length, 3, 'fourth error must not send');
  assert.equal(run.messages.length, 1, 'only threshold error notifies');
  assert.equal(run.messages[0].response, 'Четвёртая ошибка');
  assert.equal(run.messages[0].durationMs, 30000);
  assert.match(run.messages[0].retryReason, /3 автоповтора за 2 минуты/);
  run.document.querySelector('aside div:not([aria-hidden])')!.textContent = 'Updated wording';
  await pause();
  assert.equal(run.messages.length, 1, 'one failed attempt is counted once even when error text changes');
  run.advance(150000);
  runInContext("globalThis.__chatgptNotifierAttemptId = 'manual-regenerate'", run.context);
  run.document.querySelector('aside')!.remove();
  await pause();
  await run.fail('Still stopped');
  assert.equal(run.sends.length, 3, 'limit remains stopped rather than restarting on a timer');

  assert.equal(run.logs.filter(e=>e.kind==='retry.confirmed').length,3);
  assert.equal(run.logs.filter(e=>e.kind==='retry.send_intent').length,3);
  assert.equal(run.logs.filter(e=>e.kind==='retry.confirmed')[0].operationId,run.logs.find(e=>e.kind==='retry.planned').operationId);
  const noLog=setup('Draft');noLog.breakJournal();await noLog.fail('error');
  assert.equal(noLog.sends.length,0,'journal failure must prevent automatic send');
  assert.equal(noLog.document.querySelector('#prompt-textarea')!.textContent,'Draft');
  assert.match(noLog.messages[0].retryReason,/журнал/);
  const recovery=setup('Сохранить мой черновик');
  recovery.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="status"><span class="text-chatgpt-recovery">接続を回復しています</span></div>');
  const stop=recovery.document.createElement('button');stop.type='button';stop.setAttribute('data-test-modern-stop','');stop.innerHTML='<svg class="icon-primary-action"><path d="M4.5 5.75C4.5 test-stop-icon"></path></svg>';const body=recovery.document.querySelector('form')!;body.setAttribute('data-composer-body','');body.append(stop);
  await pause();assert.equal(recovery.sends.length,0,'transient recovery must not immediately retry');
  recovery.advance(3500);await new Promise(r=>setTimeout(r,3700));
  assert.deepEqual(recovery.sends,['доделай е2е']);assert.equal(recovery.getStopCalls(),1,'a stalled recovery must stop once before continuing');
  assert.equal(recovery.document.querySelector('#prompt-textarea')!.textContent,'Сохранить мой черновик');
  assert.ok(recovery.logs.some(e=>e.kind==='error.detected'&&e.error==='接続を回復しています'));
  const lingering=setup('',true,true,'',null,true);
  lingering.document.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="status"><span class="text-chatgpt-recovery">Recovery</span></div>');
  await pause();lingering.advance(3500);await new Promise(r=>setTimeout(r,3700));
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
  await pause();
  assert.equal(uncertain.logs.filter(e=>e.kind==='retry.confirmed').length,0,'uncertain send must never be logged as confirmed');
  assert.equal(uncertain.sends.length, 1, 'uncertain send is clicked exactly once');
  assert.match(uncertain.messages[0].retryReason, /подтвердить отправку/);
  assert.equal(uncertain.document.querySelector('#prompt-textarea')!.textContent, 'доделай е2е','uncertain send must not expose a draft to a potentially pending submission');
  assert.ok(uncertain.logs.some(e=>e.kind==='draft.saved'&&e.draft==='Черновик до неясной отправки'));
  assert.ok(uncertain.logs.some(e=>e.kind==='draft.restore_deferred'));

  const historical = setup();
  historical.document.querySelector('main')!.innerHTML = `<article data-testid="conversation-turn-old" data-turn="assistant">${alertHTML('Old')}</article>${user}<article data-testid="conversation-turn-2" data-turn="assistant"><div class="markdown">${alertHTML('Example')}</div></article>`;
  await pause();
  assert.equal(historical.sends.length, 0);
  assert.equal(historical.messages.length, 0);
  runInContext(content, historical.context);
  await pause();
  assert.equal(historical.sends.length, 0);
  console.log('PASS: three retries silent, fourth stops/notifies, explicit extra budget, stale recovery across attempts, rolling window, sticky stop, changed error text dedupe, timing, draft protection, missing composer, historical/quoted errors, reinjection');
}
async function workerCheck() {
  const callbacks: Record<string, any> = {};
  const event = (name: string) => ({ addListener: (fn: any) => { callbacks[name] = fn; } });
  const notifications: any[] = [], injections: any[] = [];
  let soundCalls = 0;
  const storage: Record<string, any> = {};
  const chrome = {
    storage: { local: { get: async (key: string | null) => key === null ? {...storage} : ({ [key]: storage[key] }), set: async (entries: any) => {Object.assign(storage, entries);} } },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
      getManifest: () => ({version:'1.2.0'}), getURL: (url: string) => url, getContexts: async () => [{}], sendMessage: async () => { if (++soundCalls === 1) throw new Error('Could not establish connection. Receiving end does not exist.'); } },
    webRequest: { onBeforeRequest: event('before'), onCompleted: event('complete'), onErrorOccurred:event('requestError') },
    tabs: { query: async () => [{id: 7}], onRemoved: event('removed'), sendMessage: async () => {} },
    scripting: { executeScript: async (args: any) => { injections.push(args); return [{result:{ok:true,clicked:true}}]; } },
    notifications: { create: async (id: string, options: any) => { notifications.push(options); return id; }, onClicked: event('clicked') }
  };
  const workerContext = createContext({ chrome, console, URL, setTimeout, clearTimeout });
  Object.assign(workerContext, {importScripts: (name: string) => runInContext(readFileSync(`extension/${name}`, 'utf8'), workerContext)});
  runInContext(worker, workerContext);
  callbacks.installed(); await pause();
  assert.equal(injections[0].target.tabId, 7, 'update must inject into existing tabs without navigation');
  const sender = { tab: { id: 7, url: 'https://chatgpt.com/c/example' } };
  const error = { type: 'CHATGPT_RESPONSE_ERROR', sessionTitle: 'My chat - ChatGPT', response: 'Network failed', durationMs: 125000, fingerprint: 'error|prompt|Network failed' };
  callbacks.message(error, sender); await pause();
  assert.equal(notifications[0].title, '❌ My chat');
  assert.equal(soundCalls,2,'offscreen listener startup race retries without losing notification');
  assert.equal(notifications[0].message, 'Network failed');
  assert.equal(notifications[0].contextMessage, 'Ошибка через 2 мин 5 с');
  callbacks.message(error, sender); await pause();
  assert.equal(notifications.length, 2, 'new attempt must not be suppressed by service-worker dedupe');
  const success = { type: 'CHATGPT_RESPONSE_COMPLETE', sessionTitle: 'My chat', response: 'Done', durationMs: 3661000, completionKey: 'prompt|assistant' };
  callbacks.message(success, sender); callbacks.message(success, sender); await pause();
  assert.equal(notifications.length, 3, 'success deduplication must remain intact');
  assert.equal(notifications[2].title, 'My chat');
  assert.equal(notifications[2].contextMessage, 'Ответ за 1 ч 1 мин 1 с');
  callbacks.message({ ...success, completionKey: 'unknown', durationMs: null }, sender); await pause();
  assert.equal(notifications[3].contextMessage, '', 'unknown duration leaves subtitle empty');
  callbacks.before({ tabId: 8, method: 'POST', timeStamp: 123456, url: 'https://chatgpt.com/backend-api/f/conversation' }); await pause();
  assert.equal(injections.at(-1).target.tabId, 8);
  assert.equal(injections.at(-2).args[0], 123456);
  const tabWorld: any = {};
  runInContext(`(${injections.at(-2).func.toString()})(123456)`, createContext(tabWorld));
  assert.equal(tabWorld.__chatgptNotifierRequestStartedAt, 123456);
  const beforeSteer=injections.length;
  callbacks.before({tabId:8,method:'POST',timeStamp:123999,requestId:'steer-test',documentUrl:'https://chatgpt.com/c/example',url:'https://chatgpt.com/backend-api/f/steer_turn'});await pause();
  assert.equal(injections.length,beforeSteer+2,'steering sends must arm timing and attempt observation');
  assert.equal(injections.at(-2).args[0],123999);
  callbacks.before({tabId:8,method:'POST',timeStamp:124000,url:'https://chatgpt.com/backend-api/f/conversation/prepare'});await pause();
  assert.equal(injections.length,beforeSteer+2,'preparation must not count as a submitted message');
  assert.ok(notifications.every(n => !/click to return/i.test(n.contextMessage)));
  const record={id:'handoff-test',sourceUrl:'https://chatgpt.com/c/source',sourceTitle:'Original name',text:'complete history'};
  Object.assign(workerContext,{record});
  const begun=await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_BEGIN',record},7)",workerContext);
  assert.equal(begun.record.stage,'navigating');
  assert.equal(begun.record.naming.title,'Original name (1)');
  assert.equal((await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_BEGIN',record},7)",workerContext)).ok,false);
  await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'preparing'},7)",workerContext);
  await runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'sending'},7)",workerContext);
  await assert.rejects(runInContext("handleHandoffMessage({type:'CHATGPT_HANDOFF_UPDATE',id:record.id,stage:'preparing'},7)",workerContext));
  assert.equal(storage['chatgpt-handoff:7'].text,'complete history');
  const sendGuard=(options:any)=>new Promise<any>(resolve=>callbacks.message({type:'CHATGPT_COMPOSER_CONTROL',options},sender,resolve));
  const injectBefore=injections.length;
  assert.equal((await sendGuard({action:'send',text:'User draft',url:sender.tab.url})).ok,false);
  assert.equal(injections.length,injectBefore,'unlogged draft must not reach the page');
  await runInContext("appendJournal({kind:'retry.send_intent',operationId:'only-once'}, {id:7})",workerContext);
  assert.equal((await sendGuard({action:'send',text:'User draft',operationId:'only-once',url:sender.tab.url})).ok,false);
  assert.equal(injections.length,injectBefore,'even a logged operation cannot substitute a user draft');
  const options={action:'send',text:'доделай е2е',operationId:'only-once',url:sender.tab.url};
  assert.equal((await sendGuard(options)).clicked,true);
  assert.equal((await sendGuard(options)).ok,false,'one operation may dispatch only once');
  assert.equal(injections.length,injectBefore+1);
  console.log('PASS: worker forbids user drafts, enforces persisted exact command and one-use send');
  console.log('PASS: durable handoff state, source deduplication, no resend after sending');
  console.log('PASS: error title/body, repeat attempts, success deduplication, existing-tab activation, request-start activation');
}
if(process.argv[2]!=='worker') await domCheck();
await workerCheck();
