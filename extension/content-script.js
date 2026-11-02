'use strict';

(() => {
  const SCRIPT_VERSION = '1.6.1';
  if (globalThis.__chatgptNotifierVersion === SCRIPT_VERSION && globalThis.__chatgptNotifierAlive?.()) return;
  globalThis.__chatgptNotifierDispose?.();
  globalThis.__chatgptNotifierVersion = SCRIPT_VERSION;
  let contextAlive = true;
  let statusIndicator = null;
  let deferredTaskObserver = null;
  let deferredObservedStart = 0;
  let manualSendIntent = null;
  let completionSendIntent = null;
  let completionAttempt = null;
  let goalDispatchBusy = false;
  let goalDispatchQueue = Promise.resolve();
  let completionRecoveryTimer = null;
  let returnedPageUrl = '';
  const listeners = new AbortController();
  const answerWaitSlot = ChatGPTNotifierMemory.createLatestTaskSlot();
  const recoveryFirstSeen = new Map();
  let visibleErrors = new Set();
  let errorScanTimer = null;
  let errorObserver = null;
  function runtimeAvailable() {
    try { return contextAlive && Boolean(chrome.runtime?.id); } catch { return false; }
  }
  function stopContext() {
    contextAlive = false;
    statusIndicator?.dispose();
    deferredTaskObserver?.dispose();
    if(completionRecoveryTimer!==null)clearTimeout(completionRecoveryTimer);
    manualSendIntent = null;
    listeners.abort();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
    answerWaitSlot.cancel();
    errorObserver?.disconnect();
    errorObserver = null;
    recoveryFirstSeen.clear();
    visibleErrors.clear();
    errorScanTimer = null;
  }
  globalThis.__chatgptNotifierDispose = stopContext;
  globalThis.__chatgptNotifierAlive = runtimeAvailable;
  async function runtimeMessage(message) {
    if (!runtimeAvailable()) { stopContext(); return null; }
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) {
      if (!runtimeAvailable() || /context invalidated/i.test(String(error?.message))) stopContext();
      return null;
    }
  }

  async function audit(kind, details = {}, required = false) {
    const result = await runtimeMessage({ type: 'CHATGPT_LOG_EVENT', event: {
      kind, eventAt: Date.now(), sourceUrl: location.href, title: document.title,
      attemptId: globalThis.__chatgptNotifierAttemptId || '', ...details
    } });
    if (required && !result?.ok) throw new Error('Не удалось записать журнал; автоматическая отправка остановлена');
    return result;
  }
  void audit('watcher.started');
  if (!runtimeAvailable()) return;

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const FINAL_TURN_WAIT_MS = 30000;
  const ANSWER_CHECK_THROTTLE_MS = 150;
  const STREAM_SETTLE_MS = 900;
  const STREAM_POLL_MS = 500;
  const GENERATION_HARD_CAP_MS = 600000;
  const STOP_BUTTON_SELECTOR =
    'button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"], [data-composer-body] button[type="button"]:has(svg.icon-primary-action path[d^="M4.5 5.75C4.5"])';
  let watchToken = 0;
  let lastSentFingerprint = '';
  let suppressUntilEpoch = 0;

  function pageIsActive() {
    try {
      return document.visibilityState === 'visible' && document.hasFocus();
    } catch {
      return document.visibilityState === 'visible';
    }
  }

  // Store the start in the tab's isolated world, so worker suspension does
  // not lose timing. Existing in-flight requests have no known start.
  function consumeDuration() {
    const startedAt = globalThis.__chatgptNotifierRequestStartedAt;
    globalThis.__chatgptNotifierRequestStartedAt = null;
    return Number.isFinite(startedAt) && startedAt > 0 && startedAt <= Date.now()
      ? Date.now() - startedAt : null;
  }

  statusIndicator=globalThis.ChatGPTStatusIndicator?.create({document,getUrl:()=>location.href,
    load:url=>runtimeMessage({type:'CHATGPT_STATUS_GET',url,generating:isGenerating(),startedAt:Number(globalThis.__chatgptNotifierAttemptId)||null,requestId:globalThis.__chatgptNotifierRequestId||null}),alive:runtimeAvailable})||null;


  function notifyPageReturned(event) {
    if((event&&event.isTrusted===false)||!pageIsActive()||returnedPageUrl===location.href)return;
    const url=location.href;
    returnedPageUrl=url;
    runtimeMessage({type:'CHATGPT_PAGE_RETURNED',url}).then(result=>{if(!result?.ok&&returnedPageUrl===url)returnedPageUrl='';});
  }

  window.addEventListener('focus', event=>{returnedPageUrl='';void statusIndicator?.refresh();deferredTaskObserver?.refresh();notifyPageReturned(event);}, { capture: true, signal: listeners.signal });
  window.addEventListener('blur',()=>{returnedPageUrl='';},{capture:true,signal:listeners.signal});
  document.addEventListener('visibilitychange', event => {
    returnedPageUrl='';
    if (document.visibilityState === 'visible') {void statusIndicator?.refresh();deferredTaskObserver?.refresh();notifyPageReturned(event);}
  }, { capture: true, signal: listeners.signal });
  document.addEventListener('pointerdown', notifyPageReturned, { capture: true, passive: true, signal: listeners.signal });
  document.addEventListener('keydown', notifyPageReturned, { capture: true, passive: true, signal: listeners.signal });

  function pageRoot() {
    return document.querySelector('[data-app-shell-active-page="true"]') || document;
  }

  function turnNodes() {
    try {
      const turns = Array.from(pageRoot().querySelectorAll('[data-testid^="conversation-turn-"]'));
      if (turns.length > 0) return turns;
      return Array.from(pageRoot().querySelectorAll('[data-chatgpt-search-unit-key*="fallback-turn-"]'));
    } catch {
      return [];
    }
  }

  function roleOf(turn) {
    if (!turn) return '';
    try {
      const key = turn.getAttribute('data-chatgpt-search-unit-key') || '';
      const direct = normalize(
        turn.getAttribute('data-turn') ||
        turn.getAttribute('data-message-author-role') ||
        turn.getAttribute('data-conversation-role') ||
        (key.match(/:(user|assistant)$/) || [])[1] || ''
      ).toLowerCase();
      if (direct === 'user' || direct === 'assistant') return direct;
      if (turn.querySelector('[data-message-author-role="user"], [data-conversation-role="user"]')) return 'user';
      if (turn.querySelector('[data-message-author-role="assistant"], [data-conversation-role="assistant"]')) return 'assistant';
    } catch {}
    return '';
  }

  function assistantGoalMarker(turn) {
    if(!turn)return false;
    const roleNode=turn.matches?.('[data-message-author-role="assistant"]')?turn:
      turn.querySelector('[data-message-author-role="assistant"]')||turn;
    const rendered=roleNode.querySelector('[data-markdown-text-style="assistant-message"], .markdown, [class*="prose"], [data-message-content]');
    // Only one entire plain response. Code fences, formatting, other text
    // or tool cards cannot accidentally satisfy the completion protocol.
    return !!rendered&&rendered.textContent==='GOAL_COMPLETE'&&
      roleNode.textContent==='GOAL_COMPLETE'&&
      !roleNode.querySelector('code,pre,strong,em,a,blockquote,ul,ol,table,button,svg,img');
  }

  function assistantText(turn) {
    if (!turn) return '';
    try {
      const roleNode = turn.matches?.('[data-message-author-role="assistant"]')
        ? turn
        : turn.querySelector('[data-message-author-role="assistant"]') || turn;
      const rendered = roleNode.querySelector(
        '[data-markdown-text-style="assistant-message"], .markdown, [class*="prose"], [data-message-content]'
      );
      return normalize(
        rendered
          ? (rendered.textContent || rendered.innerText || '')
          : (roleNode.textContent || roleNode.innerText || '')
      );
    } catch {
      return '';
    }
  }

  function latestPromptSnapshot() {
    const turns = turnNodes();
    let latestUserIndex = -1;
    for (let i = 0; i < turns.length; i += 1) {
      if (roleOf(turns[i]) === 'user') latestUserIndex = i;
    }
    if (latestUserIndex < 0) return null;

    let assistantIndex = -1;
    let response = '';
    for (let i = latestUserIndex + 1; i < turns.length; i += 1) {
      if (roleOf(turns[i]) !== 'assistant') continue;
      const text = assistantText(turns[i]);
      if (!text) continue;
      assistantIndex = i;
      response = text;
    }

    const userTurn = turns[latestUserIndex];
    const promptKey = [
      location.pathname,
      userTurn?.getAttribute('data-testid') ||
      userTurn?.getAttribute('data-chatgpt-search-unit-key') ||
      `user-${latestUserIndex}`
    ].join('|');

    if (!response || assistantIndex < 0) {
      return { promptKey, assistantKey: '', response: '',goalMarkerExact:false };
    }

    const assistantTurn = turns[assistantIndex];
    return {
      promptKey,
      assistantKey:
        assistantTurn?.getAttribute('data-testid') ||
        assistantTurn?.getAttribute('data-chatgpt-search-unit-key') ||
        `assistant-${assistantIndex}`,
      response,goalMarkerExact:assistantGoalMarker(assistantTurn)
    };
  }

  function answerBoundToLatestPrompt() {
    return latestPromptSnapshot()?.response || '';
  }

  function conversationObserverRoot() {
    const turns = turnNodes();
    const latestTurn = turns[turns.length - 1];
    if (latestTurn) {
      const main = latestTurn.closest?.('main');
      if (main) return main;
      if (latestTurn.parentElement) return latestTurn.parentElement;
    }
    return document.querySelector('main') || document.body || document.documentElement;
  }

  function isElementVisible(node) {
    if (!node) return false;
    try {
      // A stop button kept mounted but display:none must not count as
      // "generating", otherwise completion would never be detected.
      return typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
    } catch {
      return true;
    }
  }

  // Match the error component, not localized wording. Never interpret an
  // example inside an answer or an error belonging to an older turn as live UI.
  const ERROR_SELECTOR = 'aside[role="alert"].text-danger, [role="status"]:has(.text-chatgpt-recovery)';
  const RECOVERY_GRACE_MS = 3000;
  const RETRY_TEXT = 'доделай е2е';
  const RETRY_WINDOW_MS = 120000;
  const retryStates = new Map();
  let retryRestoredPath = '';
  let retryRestoreTask = null;
  let retryTask = Promise.resolve();
  const pendingDrafts = new Map();
  let draftRestoreBusy = false;
  let draftRestorePath = '';
  let replacingDraft = false;
  let stoppingRecovery = false;

  function retryState() {
    const key = location.pathname;
    if (!retryStates.has(key)) retryStates.set(key, { failures: [], blocked: false, lastAttempt: '', reason: '' });
    return retryStates.get(key);
  }

  function retryStateReady() {
    const path=location.pathname;
    if(retryRestoredPath===path)return true;
    if(retryRestoreTask)return false;
    const url=location.href;
    retryRestoreTask=runtimeMessage({type:'CHATGPT_RETRY_STATE',url}).then(result=>{
      if(!runtimeAvailable()||location.pathname!==path)return;
      if(!retryStates.has(path)) {
        const saved=result?.ok&&result.state;
        retryStates.set(path,{failures:(saved?.failures||[]).filter(at=>Date.now()-at<=RETRY_WINDOW_MS),
          blocked:result?.ok!==true||Boolean(saved?.blocked),reason:saved?.reason||(result?.ok?'':'Не удалось восстановить журнал повторов'),
          lastAttempt:saved?.lastPromptKey?`${saved.lastPromptKey}|${saved.lastAttemptId||''}`:'',
          restoredPromptKey:saved?.lastPromptKey||'',terminalHandled:Boolean(saved?.terminal),remainingRetries:saved?.remainingRetries});
      }
      retryRestoredPath=path;
    }).finally(()=>{
      retryRestoreTask=null;
      if(runtimeAvailable())scheduleErrorCheck();
    });
    return false;
  }

  function notifyError(error, retryReason = '') {
    runtimeMessage({
      type: 'CHATGPT_RESPONSE_ERROR', ...error, url:error.sourceUrl||location.href, retryReason
    }).catch(() => {});
  }
  function notifyOperationWarning(error,retryReason='',warningKind='handoff') {
    void runtimeMessage({type:'CHATGPT_OPERATION_WARNING',...error,url:error.sourceUrl||location.href,retryReason,
      warningKind,operationId:handoffRecord?.id||''});
  }

  function composer() {
    return Array.from(pageRoot().querySelectorAll('#prompt-textarea[contenteditable="true"], textarea#prompt-textarea, [data-composer-markdown][contenteditable="true"]')).find(isElementVisible) || null;
  }

  function editorText(editor) {
    return normalize(editor.value === undefined ? editor.textContent : editor.value);
  }

  function rawEditorText(editor) {
    if (editor.value !== undefined) return editor.value;
    if (!editor.querySelector('p, div, br, li')) return editor.textContent || '';
    // innerText adds layout-only newlines around rich URL widgets. Read the
    // editor's paragraph structure instead, preserving the actual message.
    const copy = editor.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"], .ProseMirror-widget, svg, button').forEach((node) => node.remove());
    function text(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.tagName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
      const separator = ['UL', 'OL'].includes(node.tagName) ? '\n' : '';
      return Array.from(node.childNodes).map(text).join(separator);
    }
    return Array.from(copy.childNodes).map(text).join('\n');
  }

  function replaceEditorText(editor, text) {
    editor.focus();
    if (editor.value !== undefined) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Поле сообщения недоступно');
      setter.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, text)) throw new Error('Не удалось вставить сообщение');
    }
  }

  function composerHasAttachments(editor) {
    const form=editor.closest('form, [data-composer-body]')||editor.parentElement;
    return Boolean(form?.querySelector('[data-testid*="attachment"], [data-testid="file-upload-progress"]')||form?.querySelector('[data-composer-attachments]')?.children.length);
  }

  async function restoreDraft(operationId = null, startup = false) {
    if(draftRestoreBusy)return;
    const path = location.pathname;
    if(startup&&draftRestorePath===path)return;
    const url=location.href;
    const localDraft=pendingDrafts.get(path);
    if(!startup&&!localDraft)return;
    const editor = composer();
    if (!editor || !isElementVisible(editor)) return;
    if(startup)draftRestorePath=path;
    if(composerHasAttachments(editor))return;
    const current = rawEditorText(editor);
    if(startup&&current!==''&&current!==RETRY_TEXT)return;
    draftRestoreBusy=true;
    try {
      const result=await runtimeMessage({type:'CHATGPT_RETRY_DRAFT_GET',url});
      const record=result?.ok&&result.record;
      if(!record||operationId&&record.operationId!==operationId||localDraft&&record.draft!==localDraft)return;
      // A saved backup alone does not prove automation changed the editor.
      // Unknown sends stay parked even when their retry text is still visible.
      if(!['saved','intent','not-clicked','confirmed'].includes(record.phase)||record.claimedAt){if(localDraft)pendingDrafts.delete(path);return;}
      if(startup&&!record.replacementProven&&!record.stopProven&&current!==RETRY_TEXT)return;
      if(!runtimeAvailable()||location.pathname!==path||composer()!==editor||rawEditorText(editor)!==current||composerHasAttachments(editor))return;
      const claim=await runtimeMessage({type:'CHATGPT_RETRY_DRAFT_CLAIM',url,operationId:record.operationId,savedSequence:record.savedSequence});
      if(!claim?.claimed) {if(localDraft)pendingDrafts.delete(path);return;}
      pendingDrafts.delete(path);
      // The durable claim precedes insertion. A crash or concurrent edit here
      // keeps the journal copy and cannot insert the old draft a second time.
      if(!runtimeAvailable()||location.pathname!==path||composer()!==editor||rawEditorText(editor)!==current||composerHasAttachments(editor))return;
      const draft=claim.record?.draft;
      if(typeof draft!=='string'||draft!==record.draft)return;
      const restored=current===draft?draft:current===''||current===RETRY_TEXT?draft:`${draft}\n\n${current}`;
      if(current!==restored)replaceEditorText(editor,restored);
      pendingDrafts.delete(path);
      void audit('draft.restored',{operationId:record.operationId,draftChars:draft.length,restoredChars:restored.length});
    } finally {draftRestoreBusy=false;}
  }

  function sendButton() {
    return Array.from(pageRoot().querySelectorAll('button[data-testid="send-button"], button#composer-submit-button, [data-composer-body] button[type="submit"]')).find(isElementVisible) || null;
  }

  async function sleepUntilNextCheck() {
    const result = await runtimeMessage({type:'CHATGPT_WAIT',delayMs:250});
    if (!result?.ok) throw new Error('Ожидание расширения недоступно');
  }

  async function inspectComposer(text, action = 'inspect', extra = {}) {
    return runtimeMessage({type:'CHATGPT_COMPOSER_CONTROL',options:{action,text,url:location.href,...extra}});
  }

  async function waitForExactComposer(text, stillCurrent) {
    const deadline = Date.now() + 10000;
    let stableSince = 0;
    let lastState=null;
    while (Date.now() < deadline) {
      if (!stillCurrent()) throw new Error('Чат или содержимое поля изменились');
      const state = await inspectComposer(text);
      lastState=state;
      if (state?.ok && state.matches && state.ready) {
        if (!stableSince) stableSince = performance.now();
        if (performance.now() - stableSince >= 500) return;
      } else stableSince = 0;
      await sleepUntilNextCheck();
    }
    await audit('composer.verification_failed',{expectedChars:text.length,matches:lastState?.matches,
      plainMatches:lastState?.plainMatches,promptMatches:lastState?.promptMatches,ready:lastState?.ready,
      promptChars:lastState?.promptChars,reason:lastState?.reason});
    throw new Error('Редактор ChatGPT не подтвердил точный текст для отправки');
  }

  // Dedicated Goal coordinator calls this once per persisted operation. The
  // only actual click is still controlChatComposer in MAIN, behind the worker's
  // consumed, journaled authorization. No draft is replaced by automation.
  async function dispatchGoal(message) {
    const url=message.url,operationId=message.operationId,text=message.text,id=message.goalId;
    const sameChat=()=>runtimeAvailable()&&ChatGPTHandoffTitle.chatUrl(location.href)===url;
    const status=(value,extra={})=>runtimeMessage({type:'CHATGPT_GOAL_STATUS',url,goalId:id,
      operationId,status:value,...extra});
    let editor=null,inserted=false,clicked=false,intentRequested=false;
    try {
      if(!sameChat()||typeof text!=='string'||!text||!id||!operationId)throw Error('Goal изменил чат или операцию');
      let grant=await runtimeMessage({type:'CHATGPT_GOAL_CHECK',url,goalId:id,operationId});
      if(!grant?.ok)return; // stale redelivery must never block the current operation
      if(isGenerating()||replacingDraft||pendingDrafts.has(location.pathname)||
          handoffBusy||['sending','awaiting-confirmation','preparing','navigating'].includes(handoffRecord?.stage)||
          currentErrors().length)throw Error('Чат занят или другой механизм восстановления активен');
      editor=composer();
      if(!editor||!isElementVisible(editor))throw Error('Поле сообщения недоступно');
      if(composerHasAttachments(editor)||rawEditorText(editor)!=='')
        throw Error('Черновик или вложение пользователя имеют приоритет; Goal остановлен без изменения ввода');
      const baselineKey=latestPromptSnapshot()?.promptKey||'';
      const baselineAttempt=globalThis.__chatgptNotifierAttemptId||'';
      if(!sameChat()||composer()!==editor||isGenerating())throw Error('Чат изменён до подготовки');
      replaceEditorText(editor,text);
      inserted=true;
      await waitForExactComposer(text,()=>sameChat()&&composer()===editor&&
        rawEditorText(editor)===text&&!isGenerating()&&!composerHasAttachments(editor));
      grant=await runtimeMessage({type:'CHATGPT_GOAL_CHECK',url,goalId:id,operationId});
      if(!grant?.ok||!sameChat()||composer()!==editor||rawEditorText(editor)!==text||
          composerHasAttachments(editor)||isGenerating())throw Error('Goal отменён до клика');
      intentRequested=true;
      const intent=await runtimeMessage({type:'CHATGPT_GOAL_INTENT',url,goalId:id,
        operationId,text,baselineKey});
      if(!intent?.ok)throw Error(intent?.error||'Не удалось сохранить разрешение Goal');
      if(!sameChat()||composer()!==editor||rawEditorText(editor)!==text||
          composerHasAttachments(editor)||isGenerating())throw Error('Чат изменился после разрешения Goal');
      // Treat a lost click acknowledgement as an UNKNOWN outcome.
      rememberCompletionSendIntent();
      clicked=true;
      const sent=await inspectComposer(text,'send',{operationId});
      if(sent?.ok===false&&!sent.unknown)clicked=false;
      if(!sent?.ok||!sent.clicked)throw Error(sent?.reason||'Нет подтверждения единственного клика');
      if(!(await status('clicked'))?.ok)throw Error('Не удалось зафиксировать результат клика');
      const deadline=Date.now()+15000;
      while(Date.now()<deadline) {
        if(!sameChat())throw Error('Чат изменился при подтверждении отправки');
        const freshKey=latestPromptSnapshot()?.promptKey||'';
        const latestUser=turnNodes().filter(turn=>roleOf(turn)==='user').at(-1);
        const rawUser=latestUser?.querySelector('[data-message-author-role="user"]')?.textContent||
          latestUser?.textContent||'';
        if(freshKey&&freshKey!==baselineKey&&normalize(rawUser)===normalize(text)&&
            (globalThis.__chatgptNotifierAttemptId||'')!==baselineAttempt&&
            composer()===editor&&rawEditorText(editor)==='') {
          const result=await status('confirmed',{newPromptKey:freshKey});
          if(!result?.ok)throw Error(result?.error||'Goal не подтвердил новое сообщение');
          return;
        }
        await sleepUntilNextCheck();
      }
      throw Error('Не подтверждено новое сообщение с точным текстом Goal');
    } catch(error) {
      const reason=(clicked?'Неизвестный исход клика: ':'Отправка отменена: ')+String(error?.message||error);
      const stillReserved=await runtimeMessage({type:'CHATGPT_GOAL_CHECK',url,goalId:id,operationId});
      if(clicked||intentRequested||stillReserved?.ok)await status('blocked',{reason});
      if(!clicked&&inserted&&sameChat()&&composer()===editor&&rawEditorText(editor)===text&&
          !composerHasAttachments(editor)&&!isGenerating()) {
        try {replaceEditorText(editor,'');}catch{}
      }
      void audit('goal.dispatch_failed',{operationId,sourceUrl:url,reason});
    } finally {
      goalDispatchBusy=false;
    }
  }

  async function ensureMaxReasoning(operationId) {
    const url = location.href;
    const trigger = () => Array.from(pageRoot().querySelectorAll('[data-composer-navigation-target="reasoning"][data-selected-reasoning-effort]')).find(isElementVisible);
    const first = trigger();
    if (!first) throw new Error('Не найден переключатель уровня рассуждения');
    const previous = first.getAttribute('data-selected-reasoning-effort');
    if (previous !== 'max') {
      first.click();
      try {
        for (let i = 0; i < 6 && trigger()?.getAttribute('data-selected-reasoning-effort') !== 'max'; i += 1) {
          if (location.href !== url) throw new Error('Открыт другой чат');
          const slider = await waitHandoff(() => Array.from(document.querySelectorAll('[data-reasoning-slider="true"]')).find(isElementVisible));
          slider.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true,cancelable:true}));
          await sleepUntilNextCheck();
        }
      } finally {
        const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(isElementVisible);
        menu?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));
      }
    }
    if (location.href !== url || trigger()?.getAttribute('data-selected-reasoning-effort') !== 'max') throw new Error('Уровень «Очень высокий» не подтверждён; отправка остановлена');
    await audit('reasoning.selected',{operationId,previous,selected:'max'},true);
  }

  async function retryAfterError(error, attempt, path, promptKey, state, requestId) {
    manualSendIntent = null;
    const operationId = crypto.randomUUID();
    const sourceUrl = new URL(path, 'https://chatgpt.com').href;
    const logRetry = (kind, details = {}, required = false) => audit(kind, {operationId, sourceUrl, title:error.sessionTitle, ...details}, required);
    let clicked = false;
    let confirmed = false;
    const expectedToken = watchToken;
    let insertedEditor = null;
    let replaced = false;
    let recoveryStopped = false;
    let recoveryDraft = null;
    let readinessPhase = 'planned';
    const readiness = async (phase,details={}) => {
      if(readinessPhase===phase)return;
      readinessPhase=phase;
      await logRetry('retry.readiness',{phase,...details});
    };
    const stillCurrent = () => runtimeAvailable() && watchToken === expectedToken && location.pathname === path && retryState() === state && !state.blocked &&
      (globalThis.__chatgptNotifierAttemptId || '') === attempt &&
      (globalThis.__chatgptNotifierRequestId||null)===requestId &&
      (!error.recovery || recoveryStopped || currentErrors().some(node=>node.querySelector('.text-chatgpt-recovery'))) &&
      (latestPromptSnapshot()?.promptKey || path) === promptKey;
    try {
      await logRetry('retry.planned', {operationId,text:RETRY_TEXT,error:error.response,
        failureCount:state.failures.length,windowMs:RETRY_WINDOW_MS,promptKey},true);
      if (error.recovery && isGenerating()) {
        if (!stillCurrent()) return;
        const beforeStop = composer();
        recoveryDraft = beforeStop ? rawEditorText(beforeStop) : null;
        if (recoveryDraft) await logRetry('draft.saved',{operationId,draft:recoveryDraft,draftChars:recoveryDraft.length,phase:'before-recovery-stop'},true);
        if (!stillCurrent() || (beforeStop && rawEditorText(beforeStop) !== recoveryDraft)) return;
        const alert = currentErrors().find(node=>node.querySelector('.text-chatgpt-recovery'));
        let result;
        stoppingRecovery = true;
        suppressUntilEpoch = Date.now() + 1500;
        try {
          result = await runtimeMessage({type:'CHATGPT_STOP_RECOVERY',operationId,url:sourceUrl,
            alertIndex:Array.from(document.querySelectorAll(ERROR_SELECTOR)).indexOf(alert)});
        } finally { stoppingRecovery = false; }
        if (!result?.ok) throw new Error(result?.reason || 'Не удалось остановить зависшее ожидание');
        recoveryStopped = Boolean(result.stopped);
      }
      // The native stop can clear its banner before the composer becomes
      // writable. Share one bounded budget across stop settling, button and
      // actual editor readiness; never extend it after another failed check.
      const readinessMs=recoveryStopped?60000:10000;
      const deadline = Date.now() + readinessMs;
      await readiness('generation-idle',{timeoutMs:readinessMs,deadlineAt:deadline,recoveryStopped});
      while (isGenerating()) {
        if (!stillCurrent()) return;
        if (Date.now() >= deadline) throw new Error('Чат всё ещё занят');
        await sleepUntilNextCheck();
      }
      if (!stillCurrent()) return;
      const editor = composer();
      if (!editor || !isElementVisible(editor)) throw new Error('Не найдено поле сообщения');
      const form = editor.closest('form, [data-composer-body]') || editor.parentElement;
      if (form?.querySelector('[data-testid*="attachment"], [data-testid="file-upload-progress"]') || form?.querySelector('[data-composer-attachments]')?.children.length) {
        throw new Error('В поле есть вложение');
      }
      insertedEditor = editor;
      const visibleDraft = rawEditorText(editor);
      const draft = recoveryDraft && visibleDraft !== recoveryDraft
        ? (visibleDraft ? `${recoveryDraft}\n\n${visibleDraft}` : recoveryDraft) : visibleDraft;
      if (draft) {
        await logRetry('draft.saved',{operationId,draftChars:draft.length,draft},true);
        if (!stillCurrent() || rawEditorText(editor) !== visibleDraft) return;
        pendingDrafts.set(path, draft);
      }
      replaced = true;
      replacingDraft = true;
      replaceEditorText(editor, RETRY_TEXT);
      if(draft)await logRetry('draft.replaced',{operationId},true);
      let stableSince=0;
      while(Date.now()<deadline) {
        if (!stillCurrent()) return;
        if(composer()!==editor||rawEditorText(editor)!==RETRY_TEXT||isGenerating()) {
          await logRetry('retry.readiness_cancelled',{phase:readinessPhase,reason:isGenerating()?'generation-resumed':'editor-changed'});
          return;
        }
        const button=sendButton();
        const buttonReady=button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true';
        const native=buttonReady?await inspectComposer(RETRY_TEXT):null;
        if(!stillCurrent())return;
        if(Date.now()>=deadline)break;
        if(composer()!==editor||rawEditorText(editor)!==RETRY_TEXT||isGenerating()) {
          await logRetry('retry.readiness_cancelled',{phase:readinessPhase,reason:isGenerating()?'generation-resumed':'editor-changed'});
          return;
        }
        if(buttonReady&&native?.ok&&native.matches&&native.ready) {
          if(!stableSince)stableSince=performance.now();
          await readiness('settling');
          if(performance.now()-stableSince>=500) {await readiness('ready');break;}
        } else {
          stableSince=0;
          await readiness(!buttonReady?'send-button':native?.ok&&native.matches?'native-ready':'native-text',
            {matches:native?.matches,ready:native?.ready,reason:native?.reason});
        }
        await sleepUntilNextCheck();
      }
      if(readinessPhase!=='ready')throw new Error(readinessPhase==='send-button'?'Кнопка отправки недоступна':'Редактор ChatGPT не подтвердил готовность точного текста для отправки');
      if(Date.now()>=deadline)throw new Error('Истекло время подготовки автопродолжения');
      if (!stillCurrent() || composer()!==editor || rawEditorText(editor)!==RETRY_TEXT || isGenerating()) return;
      // Exactly one click. An uncertain send is never automatically repeated.
      await logRetry('retry.send_intent',{operationId,text:RETRY_TEXT,promptKey},true);
      if (!stillCurrent() || Date.now()>=deadline || composer()!==editor || rawEditorText(editor)!==RETRY_TEXT || isGenerating()) return;
      if (!runtimeAvailable()) return;
      rememberCompletionSendIntent();
      clicked = true; // A lost reply may still mean the page received the click.
      const sent = await inspectComposer(RETRY_TEXT,'send',{operationId});
      if (sent?.ok === false&&!sent.unknown) clicked = false;
      if (!sent?.ok || !sent.clicked) throw new Error(sent?.reason || 'Безопасная отправка не подтверждена');
      void logRetry('retry.clicked',{operationId,text:RETRY_TEXT});
      const confirmationDeadline = Date.now() + 10000;
      while (Date.now() < confirmationDeadline) {
        if (!runtimeAvailable()) return;
        if (location.pathname !== path) return;
        const currentEditor = composer();
        if ((latestPromptSnapshot()?.promptKey || path) !== promptKey &&
            (globalThis.__chatgptNotifierAttemptId || '') !== attempt &&
            currentEditor && editorText(currentEditor) !== RETRY_TEXT) {
          confirmed = true;
          await logRetry('retry.confirmed',{operationId,text:RETRY_TEXT,
            confirmation:'new-user-turn-and-cleared-composer',newPromptKey:latestPromptSnapshot()?.promptKey},true);
          return;
        }
        await sleepUntilNextCheck();
      }
      throw new Error('Не удалось подтвердить отправку');
    } catch (cause) {
      await logRetry('retry.failed',{operationId,clicked,confirmed,phase:readinessPhase,error:String(cause.message || cause)});
      state.blocked = true;
      state.reason = `Автопродолжение остановлено: ${cause.message}`;
      notifyError(error, state.reason);
    } finally {
      if (!clicked) {
        void logRetry('retry.cancelled',{operationId,reason:'Отправка не выполнялась'});
        if(recoveryStopped&&!isGenerating())void runtimeMessage({type:'CHATGPT_GENERATION_STOPPED',url:sourceUrl,startedAt:Number(attempt),requestId});
      }
      else if (!confirmed && !state.blocked) void logRetry('retry.failed',{operationId,clicked:true,confirmed:false,reason:'Контекст чата изменился; результат отправки неизвестен'});
      replacingDraft = false;
      if (replaced && runtimeAvailable() && location.pathname === path) {
        try {
          if (pendingDrafts.has(path)) {
            if (!clicked || (globalThis.__chatgptNotifierAttemptId || '') !== attempt) await restoreDraft(operationId);
            else {
              pendingDrafts.delete(path);
              void logRetry('draft.restore_deferred',{operationId,reason:'Нет подтверждения начала запроса; черновик сохранён в журнале'});
              notifyError(error,'Черновик сохранён в журнале; автоматическое восстановление остановлено до подтверждения отправки');
            }
          }
          else if (!clicked && insertedEditor && editorText(insertedEditor) === RETRY_TEXT) {
            replaceEditorText(insertedEditor, '');
          }
        } catch (cause) {
          void logRetry('draft.restore_failed',{operationId,error:String(cause.message || cause)});
          state.blocked = true;
          state.reason = 'Не удалось восстановить черновик; копия сохранена до восстановления поля';
          notifyError(error, state.reason);
        }
      }
    }
  }

  function handleError(error, promptKey) {
    const state = retryState();
    const attempt = globalThis.__chatgptNotifierAttemptId || '';
    const requestId=globalThis.__chatgptNotifierRequestId||null;
    const attemptKey = `${promptKey}|${requestId||attempt}`;
    // Rewording/remounting one error does not count as another failed request.
    if (state.lastAttempt === attemptKey) return;
    state.lastAttempt = attemptKey;
    const now = Date.now();
    state.failures = state.failures.filter((at) => now - at <= RETRY_WINDOW_MS);
    state.failures.push(now);
    if (state.blocked || state.failures.length >= 5 || state.remainingRetries===0) {
      state.blocked = true;
      state.reason ||= state.remainingRetries===0?'Дополнительные автоповторы исчерпаны':'Автопродолжение остановлено: 4 автоповтора за 2 минуты';
      void audit('retry.blocked',{reason:state.reason,failureCount:state.failures.length,windowMs:RETRY_WINDOW_MS,error:error.response});
      notifyError(error, state.reason);
      return;
    }
    if(state.remainingRetries!=null)state.remainingRetries--;
    const path = location.pathname;
    retryTask = retryTask.then(() => retryAfterError(error, attempt, path, promptKey, state, requestId));
  }

  function rememberCompletionSendIntent() {
    completionSendIntent={path:location.pathname,at:Date.now(),baselineKey:latestPromptSnapshot()?.promptKey||''};
    void runtimeMessage({type:'CHATGPT_COMPLETION_CHECKPOINT',action:'intent',url:location.href,at:completionSendIntent.at,baselineKey:completionSendIntent.baselineKey});
  }

  function rememberManualStatusIntent() {
    const button=sendButton();
    if(!button||button.disabled||button.getAttribute('aria-disabled')==='true')return;
    rememberCompletionSendIntent();
    manualSendIntent={url:ChatGPTHandoffTitle.chatUrl(location.href),at:Date.now(),attempt:globalThis.__chatgptNotifierAttemptId||'',requestId:globalThis.__chatgptNotifierRequestId||null};
  }
  function confirmManualStatusIntent(startedAt,requestId) {
    const intent=manualSendIntent;
    if(!intent)return;
    if(!intent.url||ChatGPTHandoffTitle.chatUrl(location.href)!==intent.url){manualSendIntent=null;return;}
    // Bound the actual send time, not delivery of the worker's confirmation.
    if(!Number.isFinite(startedAt)||startedAt<intent.at)return;
    if(startedAt-intent.at>10000){manualSendIntent=null;return;}
    if(requestId?requestId===intent.requestId:String(startedAt)===intent.attempt)return;
    manualSendIntent=null;
    runtimeMessage({type:'CHATGPT_MANUAL_SEND',url:intent.url,eventAt:intent.at,startedAt,requestId:requestId||null}).then(result=>{if(result?.ok)statusIndicator?.accept(result);});
  }

  // Reset the indicator only after a trusted send intent produces a request.
  // Enter configured as a newline and automated retries do not acknowledge it.
  document.addEventListener('click', (event) => {
    if (event.isTrusted && event.target instanceof Element &&
        event.target.closest('button[data-testid="send-button"], button#composer-submit-button, [data-composer-body] button[type="submit"]')) {
      retryStates.delete(location.pathname);
      void runtimeMessage({type:'CHATGPT_GOAL_MANUAL',url:location.href});
      rememberManualStatusIntent();
      void audit('retry.manual_reset',{input:'send-button'});
    }
  }, { capture: true, signal: listeners.signal });
  document.addEventListener('keydown', (event) => {
    if (event.isTrusted && event.key === 'Enter' && !event.shiftKey && !event.isComposing &&
        event.target instanceof Element && event.target.closest('#prompt-textarea, [data-composer-markdown]')) {
      retryStates.delete(location.pathname);
      void runtimeMessage({type:'CHATGPT_GOAL_MANUAL',url:location.href});
      rememberManualStatusIntent();
      void audit('retry.manual_reset',{input:'enter'});
    }
  }, { capture: true, signal: listeners.signal });

  let handoffRecord = null;
  let handoffBusy = false;
  let handoffReconcileBusy = false;
  let handoffLastCheckAt = -Infinity;
  let handoffCheckScheduled = false;
  let handoffFinishBusy = false;

  function handoffText(messages, errorText, sourceUrl) {
    const history = messages.map((item, index) =>
      `--- Сообщение ${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'ChatGPT'} ---\n${item.text}`
    ).join('\n\n');
    return `Передача задачи из предыдущего чата: ${sourceUrl}\n\nНиже последние два сообщения пользователя и два ответа ChatGPT в исходном хронологическом порядке. Это история предыдущей работы, а не подтверждение её выполнения.\n\n${history}\n\n--- Причина передачи ---\nВот такая ошибка у другого агента: ${errorText}\nПоэтому задачу передаём тебе. Продолжи с учётом этой истории, проверь актуальное состояние и доделай задачу end-to-end.`;
  }

  async function updateHandoff(stage, extra = {}) {
    const result = await runtimeMessage({ type: 'CHATGPT_HANDOFF_UPDATE', id: handoffRecord.id, stage, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить этап передачи');
    handoffRecord = result.record;
    return result;
  }

  async function finishSentHandoff() {
    const record=handoffRecord;
    if(handoffFinishBusy||record?.stage!=='sent'||ChatGPTHandoffTitle.chatUrl(location.href)!==ChatGPTHandoffTitle.chatUrl(record.targetUrl))return;
    handoffFinishBusy=true;
    try {
      const editor=composer();
      if(record.draft&&!record.draftRestoreClaimedAt&&editor&&isElementVisible(editor)) {
        // Claim the restoration before its effect. A restart cannot insert an
        // old draft a second time after the owner has already used it.
        const claim=await runtimeMessage({type:'CHATGPT_HANDOFF_DRAFT_CLAIM',id:record.id});
        if(claim?.ok)handoffRecord=claim.record;
        if(claim?.claimed&&ChatGPTHandoffTitle.chatUrl(location.href)===ChatGPTHandoffTitle.chatUrl(record.targetUrl)&&
            composer()===editor&&rawEditorText(editor)==='') {
          replaceEditorText(editor,record.draft);
          void audit('draft.restored',{operationId:record.id,draftChars:record.draft.length,restoredChars:record.draft.length});
        }
      }
      void renameHandoff();
    } finally {handoffFinishBusy=false;}
  }

  async function reconcileHandoff() {
    if(handoffReconcileBusy||!['sending','awaiting-confirmation'].includes(handoffRecord?.stage))return handoffRecord?.stage==='sent';
    if(performance.now()-handoffLastCheckAt<2000)return false;
    handoffLastCheckAt=performance.now();
    handoffReconcileBusy=true;
    try {
      const result=await runtimeMessage({type:'CHATGPT_HANDOFF_RECONCILE',id:handoffRecord.id});
      if(result?.ok&&result.record?.id===handoffRecord?.id)handoffRecord=result.record;
      if(handoffRecord?.stage==='sent') {await finishSentHandoff();return true;}
      return false;
    } finally {handoffReconcileBusy=false;}
  }

  function scheduleHandoffCheck() {
    if(handoffCheckScheduled||!['sending','awaiting-confirmation'].includes(handoffRecord?.stage))return;
    handoffCheckScheduled=true;
    void runtimeMessage({type:'CHATGPT_WAIT',delayMs:Math.max(250,Math.ceil(2000-(performance.now()-handoffLastCheckAt)))}).then(async result=>{
      handoffCheckScheduled=false;
      if(result?.ok&&runtimeAvailable()) {
        try {await reconcileHandoff();}catch{}
      }
    });
  }

  async function awaitHandoffConfirmation(reason) {
    if(handoffRecord?.stage==='awaiting-confirmation'&&handoffRecord.awaitingNotifiedAt)return;
    const result=await updateHandoff('awaiting-confirmation',{reason});
    if(result.notifyAwaiting)notifyOperationWarning({sessionTitle:document.title,response:'Передача ожидает подтверждения нового чата. Повторная отправка отключена; история и черновик сохранены в расширении.'},'Ожидание подтверждения отправки');
  }

  window.addEventListener('focus',scheduleHandoffCheck,{signal:listeners.signal});
  window.addEventListener('popstate',scheduleHandoffCheck,{signal:listeners.signal});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')scheduleHandoffCheck();},{signal:listeners.signal});

  async function waitHandoff(check, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!runtimeAvailable()) throw new Error('Расширение обновлено');
      const result = await check();
      if (result) return result;
      await sleepUntilNextCheck();
    }
    throw new Error('Не удалось дождаться готовности нового чата');
  }

  async function submitHandoff() {
    manualSendIntent = null;
    if (handoffBusy || !handoffRecord || !['navigating', 'preparing'].includes(handoffRecord.stage)) return;
    if (location.href === handoffRecord.sourceUrl) return;
    handoffBusy = true;
    let clicked = false;
    try {
      const record = handoffRecord;
      let lastAttachmentStatus = '';
      const editor = await waitHandoff(() => {
        const node = composer();
        return node && isElementVisible(node) && turnNodes().length === 0 && !isGenerating() ? node : null;
      });
      const initialPath = location.pathname;
      const existing = rawEditorText(editor);
      // The built-in new-chat action can seed the last prompt. Anything else
      // may be a new draft and must not be silently overwritten.
      if (normalize(existing) && existing !== record.lastUserText && existing !== record.draft && existing !== record.prompt) {
        throw new Error('В новом чате уже есть другой черновик');
      }
      await updateHandoff('preparing', { targetUrl: location.href });
      await ensureMaxReasoning(record.id);
      if (record.asFile) {
        const input = Array.from(pageRoot().querySelectorAll('input[type="file"]')).find((node) => !node.accept || /text|\.txt/.test(node.accept));
        if (!input) throw new Error('Не найдено поле для текстового файла');
        const existingFile = await runtimeMessage({ type: 'CHATGPT_INSPECT_ATTACHMENT', fileName: record.fileName });
        if (existingFile?.status === 'missing') {
          const transfer = new DataTransfer();
          transfer.items.add(new File([record.text], record.fileName, { type: 'text/plain' }));
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await waitHandoff(async () => {
          if (location.pathname !== initialPath) throw new Error('Открыт другой чат');
          const file = await runtimeMessage({ type: 'CHATGPT_INSPECT_ATTACHMENT', fileName: record.fileName });
          if (file?.status !== lastAttachmentStatus) {
            lastAttachmentStatus = file?.status || 'unknown';
            await audit('attachment.status',{operationId:record.id,fileName:record.fileName,status:lastAttachmentStatus});
          }
          if (file?.status === 'error') throw new Error('Ошибка загрузки файла истории');
          return file?.ok && file.status === 'ready';
        }, 60000);
      }
      replaceEditorText(editor, record.prompt);
      let exactSince = 0;
      const button = await waitHandoff(() => {
        if (location.pathname !== initialPath) throw new Error('Открыт другой чат');
        const node = sendButton();
        if (rawEditorText(editor) !== record.prompt || !node || node.disabled || node.getAttribute('aria-disabled') === 'true') {
          exactSince = 0;
          return null;
        }
        // ProseMirror rebuilds link widgets asynchronously after insertion.
        // Wait for an exact stable value rather than failing on that repaint.
        if (!exactSince) exactSince = performance.now();
        return performance.now() - exactSince >= 300 ? node : null;
      });
      await waitForExactComposer(record.prompt, () => location.pathname === initialPath && rawEditorText(composer() || editor) === record.prompt);
      // Journal first: a reload/crash after this point must never resend.
      await updateHandoff('sending', { targetUrl: location.href });
      if (location.pathname !== initialPath || rawEditorText(editor) !== record.prompt) throw new Error('Содержимое нового чата изменилось перед отправкой');
      if (!runtimeAvailable()) return;
      rememberCompletionSendIntent();
      clicked = true;
      const sent = await inspectComposer(record.prompt,'send',{operationId:record.id,requireMax:true,fileName:record.asFile?record.fileName:null});
      if (sent?.ok === false&&!sent.unknown) clicked = false;
      if (!sent?.ok || !sent.clicked) throw new Error(sent?.reason || 'Безопасная отправка истории не подтверждена');
      void audit('handoff.clicked',{operationId:record.id,sourceUrl:record.sourceUrl,targetUrl:location.href});
      await waitHandoff(reconcileHandoff,60000);
    } catch (cause) {
      if(handoffRecord?.stage==='sent')return;
      if(clicked) {
        try {await awaitHandoffConfirmation(String(cause.message||cause));}catch{}
      } else {
        try { await updateHandoff('failed', { reason: String(cause.message || cause) }); } catch {}
        notifyOperationWarning({ sessionTitle: document.title, response: `Передача в новый чат остановлена: ${cause.message}. Копия истории сохранена в расширении.` },'Историю можно скачать из меню расширения');
      }
    } finally {
      handoffBusy = false;
    }
  }

  async function beginHandoff(error, info, alert) {
    if (handoffBusy) return;
    const sourceUrl = location.href;
    if (!/\/c\/[^/]+/.test(location.pathname) || info.incomplete || !info.messages?.length) {
      throw new Error('Не удалось получить полные последние сообщения; исходный чат сохранён');
    }
    if (handoffRecord && handoffRecord.sourceUrl !== sourceUrl && Date.now() - handoffRecord.createdAt < RETRY_WINDOW_MS) {
      throw new Error('Новый чат тоже завершился ошибкой; повторная передача остановлена');
    }
    const goalContext=await runtimeMessage({type:'CHATGPT_GOAL_CONTEXT',url:sourceUrl});
    if(!goalContext?.ok)throw Error('Не удалось сохранить контекст Goal перед переносом чата');
    const text=handoffText(info.messages,error.response,sourceUrl)+(goalContext.text?'\n\n'+goalContext.text:'');
    const asFile = text.length > 12000;
    const fileName = `chat-handoff-${Date.now()}.txt`;
    const prompt = asFile ? `Прочитай приложенный файл ${fileName}: там два последних сообщения пользователя и два ответа ChatGPT в исходном порядке.\n\nВот такая ошибка у другого агента: ${error.response}\nПоэтому задачу передаём тебе. Проверь актуальное состояние и доделай её end-to-end.` : text;
    const record = {
      id: crypto.randomUUID(), createdAt: Date.now(), sourceUrl, sourceTitle:document.title, text, prompt, asFile, fileName,
      draft: composer() ? rawEditorText(composer()) : '',
      lastUserText: info.messages.filter((item) => item.role === 'user').at(-1)?.text || ''
    };
    const result = await runtimeMessage({ type: 'CHATGPT_HANDOFF_BEGIN', record });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить передачу');
    handoffRecord = result.record;
    const button = alert.querySelector('button');
    if (!button || button.disabled) throw new Error('Кнопка нового чата недоступна');
    if (location.href !== sourceUrl || !alert.isConnected) throw new Error('Исходный чат изменился; переход отменён');
    // Use the real page action to preserve its mode/model behavior.
    if (!runtimeAvailable()) return;
    button.click();
    await waitHandoff(() => location.href !== sourceUrl);
    await submitHandoff();
  }

  function notifySuppressedError(error,state,promptKey,attemptId) {
    const reason=state.blocked
      ? state.reason||'Автоповтор остановлен сохранённым запретом отправки'
      : 'Запрос уже обрабатывался до обновления расширения; повторная отправка не выполняется';
    const key=`${attemptId}|${promptKey}|${reason}`;
    if(state.lastSuppressedNotice===key)return;
    state.lastSuppressedNotice=key;
    void audit('retry.suppressed',{reason,promptKey,attemptId,error:error.response,blocked:Boolean(state.blocked)});
    notifyError(error,reason);
  }

  async function routeError(error, promptKey, alert) {
    const sourcePath = location.pathname;
    const attemptId = globalThis.__chatgptNotifierAttemptId || '';
    const requestId=globalThis.__chatgptNotifierRequestId||null;
    error={...error,requestId,attemptId};
    // A pre-existing error already observed before an extension update is not
    // a new failed request. A real/manual request gets a new attempt or prompt.
    if(!attemptId&&retryState().restoredPromptKey===promptKey){
      notifySuppressedError(error,retryState(),promptKey,attemptId);
      return;
    }
    let info;
    try {
      info = await runtimeMessage({ type: 'CHATGPT_INSPECT_ERROR',
        alertIndex: Array.from(document.querySelectorAll(ERROR_SELECTOR)).indexOf(alert), captureHistory: true });
    } catch {}
    if (location.pathname !== sourcePath || (globalThis.__chatgptNotifierAttemptId || '') !== attemptId || (globalThis.__chatgptNotifierRequestId||null)!==requestId) return;
    await audit('error.detected',{error:error.response,action:info?.action || 'unknown',promptKey,durationMs:error.durationMs,attemptId});
    if (location.pathname !== sourcePath || (globalThis.__chatgptNotifierAttemptId || '') !== attemptId || (globalThis.__chatgptNotifierRequestId||null)!==requestId) return;
    if (info?.ok && info.action === 'retry') {
      handleError(error, promptKey);
      return;
    }
    const state = retryState();
    if (state.terminalHandled) return;
    state.terminalHandled = true;
    state.blocked = true;
    void audit('retry.blocked',{reason:info?.action === 'new-chat'?'Требуется новый чат':'Неизвестный тип ошибки',terminal:true,goalHandoff:info?.action==='new-chat'});
    // A new-chat recovery action is terminal: never send a retry in this chat.
    notifyError(error, info?.action === 'new-chat' ? 'Требуется новый чат' : 'Автоповтор отключён: неизвестный тип ошибки');
    if (info?.ok && info.action === 'new-chat') {
      try { await beginHandoff(error, info, alert); }
      catch (cause) { notifyOperationWarning(error, String(cause.message || cause)); }
    }
  }

  async function resumeSavedHandoff() {
    try {
      const result = await runtimeMessage({ type: 'CHATGPT_HANDOFF_GET' });
      if (result?.ok)handoffRecord = result.record || handoffRecord;
      if (['sending','awaiting-confirmation'].includes(handoffRecord?.stage)) {
        if(!await reconcileHandoff())await awaitHandoffConfirmation('Восстановление после начала отправки');
      } else if (handoffRecord?.stage==='sent') {
        await finishSentHandoff();
      } else {
        await submitHandoff();
      }
    } catch {}
  }

  async function renameHandoff() {
    const record=handoffRecord;
    if (!record?.naming || record.stage!=='sent' || !ChatGPTHandoffTitle.chatUrl(record.targetUrl) ||
        ChatGPTHandoffTitle.chatUrl(record.targetUrl)!==ChatGPTHandoffTitle.chatUrl(location.href)) return;
    const result=await runtimeMessage({type:'CHATGPT_HANDOFF_RENAME',id:record.id});
    if(result?.ok===false) notifyOperationWarning({sourceUrl:record.targetUrl,sessionTitle:document.title,response:`История передана, но название нового чата не изменено: ${result.reason}`},'','title');
  }

  function currentErrors() {
    const turns = turnNodes();
    let latestUser = null;
    for (const turn of turns) {
      if (roleOf(turn) === 'user') latestUser = turn;
    }
    return Array.from(document.querySelectorAll(ERROR_SELECTOR)).filter((alert) => {
      if (!isElementVisible(alert) || alert.closest('.markdown, pre, code, [data-markdown-text-style="assistant-message"]')) return false;
      if (!latestUser) return true;
      if (latestUser.contains(alert)) return false;
      const errorTurnIndex = turns.findIndex((turn) => turn.contains(alert));
      if (errorTurnIndex >= 0) return errorTurnIndex > turns.indexOf(latestUser);
      return Boolean(latestUser.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  }

  function checkErrors() {
    if(!retryStateReady())return;
    errorScanTimer = null;
    if (!runtimeAvailable()) { stopContext(); return; }
    if (!replacingDraft && pendingDrafts.has(location.pathname)) {
      void restoreDraft().catch(()=>{});
    }
    const next = new Set();
    const errors = currentErrors();
    for (const node of recoveryFirstSeen.keys()) if (!errors.includes(node)) recoveryFirstSeen.delete(node);
    for (const alert of errors) {
      const content = alert.cloneNode(true);
      content.querySelectorAll('button, [role="button"], [aria-hidden="true"]').forEach((node) => node.remove());
      const errorText = normalize(content.textContent);
      if (!errorText) continue;
      const promptKey = latestPromptSnapshot()?.promptKey || location.pathname;
      const identity=`${globalThis.__chatgptNotifierAttemptId||''}|${promptKey}`;
      const previous=recoveryFirstSeen.get(alert);
      if(!previous || previous.identity!==identity || previous.text!==errorText) {
        recoveryFirstSeen.set(alert,{at:Date.now(),identity,text:errorText,
          inherited:Boolean(previous && previous.text===errorText && previous.identity!==identity)});
      }
      const firstSeen=recoveryFirstSeen.get(alert);
      // A still-mounted unchanged banner belongs to the previous request.
      // Only a changed/reappearing error can consume another retry, not time.
      if(firstSeen.inherited)continue;
      if (alert.querySelector('.text-chatgpt-recovery')) {
        const remaining = RECOVERY_GRACE_MS - (Date.now() - firstSeen.at);
        if (remaining > 0) { scheduleErrorCheck(remaining); continue; }
      }
      const fingerprint = `error|${promptKey}|${errorText}`;
      next.add(fingerprint);
      if (visibleErrors.has(fingerprint)) continue;
      // Cancel a pending success notification for this failed attempt.
      watchToken += 1;
      answerWaitSlot.cancel();
      void routeError({
        durationMs: consumeDuration(),
        sessionTitle: document.title,
        response: errorText,
        sourceUrl:location.href,
        recovery: Boolean(alert.querySelector('.text-chatgpt-recovery')),
        fingerprint
      }, promptKey, alert);
    }
    visibleErrors = next;
  }

  function scheduleErrorCheck(delay = ANSWER_CHECK_THROTTLE_MS) {
    if (errorScanTimer !== null) return;
    const scheduled = {};
    errorScanTimer = scheduled;
    // Background page timers may be throttled to a minute. Short waits in
    // the extension worker return through messaging instead of page timers.
    void runtimeMessage({type:'CHATGPT_WAIT',delayMs:delay}).then(result=>{
      if (errorScanTimer !== scheduled) return;
      errorScanTimer = null;
      if (result?.ok && runtimeAvailable()) checkErrors();
    });
  }

  errorObserver = new MutationObserver((records) => {
    if(['sending','awaiting-confirmation'].includes(handoffRecord?.stage))scheduleHandoffCheck();
    if(!replacingDraft&&draftRestorePath!==location.pathname)void restoreDraft(null,true).catch(()=>{});
    // Ignore unrelated streaming mutations unless an error is already visible
    // or an error component was inserted/changed.
    if (pendingDrafts.has(location.pathname) || visibleErrors.size || records.some((record) => {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (target?.closest(ERROR_SELECTOR)) return true;
      return Array.from(record.addedNodes).some((node) => node.nodeType === Node.ELEMENT_NODE &&
        (node.matches(ERROR_SELECTOR) || node.querySelector(ERROR_SELECTOR)));
    })) scheduleErrorCheck();
  });
  errorObserver.observe(document, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'role', 'hidden', 'style', 'aria-hidden']
  });
  deferredTaskObserver=globalThis.ChatGPTDeferredTaskStatus?.create({document,getUrl:()=>location.href,alive:runtimeAvailable,
    readMetadata:({url})=>runtimeMessage({type:'CHATGPT_DEFERRED_PROBE',url}).then(reply=>reply?.snapshot??null),
    isGenerating:()=>isGenerating()&&currentErrors().length===0,
    onChange:event=>{
      const generating=event.phase==='resumed'&&isGenerating()&&currentErrors().length===0;
      if(generating)deferredObservedStart=Date.now();
      void runtimeMessage({type:'CHATGPT_DEFERRED_TASK',url:event.url,event:{...event,generating,startedAt:generating?deferredObservedStart:null}}).then(result=>{if(result?.ok)statusIndicator?.accept(result);});
      if(event.phase==='resumed'&&(isGenerating()||event.reason==='request-started'))scheduleActiveCompletionRecovery();
    }})||null;
  checkErrors();
  void resumeSavedHandoff();

  function isGenerating() {
    try {
      const stopButtons = pageRoot().querySelectorAll(STOP_BUTTON_SELECTOR);
      for (const button of stopButtons) {
        if (isElementVisible(button)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function waitForAnswerBoundToLatestPrompt(isCurrent, attempt) {
    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let watchdogId = null;
      let pollId = null;
      let throttleId = null;
      let frameId = null;
      let lastCheckAt = 0;
      let stableText = '';
      let stableSince = 0;
      let generationEndedAt = 0;
      let completionProbeBusy=false, lastCompletionProbeAt=0;
      const blockedProbeReasons=new Set();
      const startedAt = Date.now();

      const cleanupScheduledCheck = () => {
        if (throttleId !== null) {
          clearTimeout(throttleId);
          throttleId = null;
        }
        if (frameId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(frameId);
          frameId = null;
        }
      };

      const finish = (text) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        observer = null;
        if (watchdogId !== null) clearInterval(watchdogId);
        if (pollId !== null) clearInterval(pollId);
        watchdogId = null;
        pollId = null;
        cleanupScheduledCheck();
        stableText = '';
        release();
        resolve(text);
      };
      const release = answerWaitSlot.replace(() => finish(null));

      const check = () => {
        if (settled) return;
        if (!runtimeAvailable()) { stopContext(); return; }
        if (!isCurrent()) { finish(null); return; }
        lastCheckAt = performance.now();
        if (currentErrors().length) {
          checkErrors();
          finish(null);
          return;
        }

        const snapshot=latestPromptSnapshot();
        if(!attempt.promptKey&&snapshot){
          const bound=bindAttemptPrompt(attempt,{...snapshot,url:attempt.url,attemptId:globalThis.__chatgptNotifierAttemptId});
          if(bound){attempt.promptKey=bound.promptKey;persistCompletionAttempt(attempt);void audit('completion.bound',{promptKey:attempt.promptKey,startedAt:attempt.startedAt});}
        }
        // Only unbound attempts expire. A confirmed long-running answer keeps
        // its observer until completion, stop, route change or a newer request.
        if (!attempt.promptKey && Date.now() - startedAt >= GENERATION_HARD_CAP_MS) {
          finish(null);
          return;
        }

        // The stop button is the authoritative "still working" signal. While it
        // is present ChatGPT is thinking or streaming, which is not completion.
        if (isGenerating()) {
          stableText = '';
          stableSince = 0;
          generationEndedAt = 0;
          return;
        }

        const text = attempt.promptKey&&snapshot?.promptKey===attempt.promptKey?snapshot.response:'';
        if (!text) {
          stableText = '';
          stableSince = 0;
          return;
        }

        const now = Date.now();
        if (text !== stableText) {
          stableText = text;
          stableSince = now;
          return;
        }

        // Generation ended and the text stopped changing. Only now is the
        // answer actually finished, so a late repaint cannot cut it short.
        if (now - stableSince >= STREAM_SETTLE_MS && !completionProbeBusy && now-lastCompletionProbeAt>=1000) {
          completionProbeBusy=true;lastCompletionProbeAt=now;
          void runtimeMessage({type:'CHATGPT_COMPLETION_PROBE',url:attempt.url,startedAt:attempt.startedAt,requestId:attempt.requestId,boundPromptKey:attempt.promptKey})
            .then(native=>{
              if(!isCurrent()||settled)return;
              if(native?.ok===false){
                const reason=String(native.reason||'unknown');
                if(!blockedProbeReasons.has(reason)){blockedProbeReasons.add(reason);void audit('completion.probe_blocked',{promptKey:attempt.promptKey,startedAt:attempt.startedAt,reason});}
              }
              const latest=latestPromptSnapshot();
              if(latest?.promptKey!==attempt.promptKey||latest.response!==text||isGenerating()||currentErrors().length)return;
              const nativeFinal=native?.assistantKey===latest.assistantKey&&
                !!completedAttemptEvidence(attempt,{...native,attemptId:attempt.id});
              if(nativeFinal||(attempt.httpCompleted && native?.ok===false && native.reason==='native-turn-missing')){
                attempt.goalNativeVerified=nativeFinal;
                void audit('completion.confirmed',{promptKey:attempt.promptKey,assistantKey:latest.assistantKey,startedAt:attempt.startedAt,proof:native?.ok?'native-final':'completed-transport'});
                finish(text);
              }
            }).catch(()=>{}).finally(()=>{completionProbeBusy=false;});
        }
      };

      const scheduleCheck = () => {
        if (!isCurrent()) { finish(null); return; }
        if (settled || throttleId !== null || frameId !== null) return;
        const elapsed = performance.now() - lastCheckAt;
        const delay = Math.max(0, ANSWER_CHECK_THROTTLE_MS - elapsed);
        throttleId = setTimeout(() => {
          throttleId = null;
          const run = () => {
            frameId = null;
            check();
          };
          if (document.visibilityState !== 'hidden' && typeof requestAnimationFrame === 'function') {
            frameId = requestAnimationFrame(run);
          } else {
            run();
          }
        }, delay);
      };

      const root = conversationObserverRoot();
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(scheduleCheck);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      }

      // Interval fallback: background tabs freeze requestAnimationFrame, so the
      // observer chain alone can stall until the tab regains focus.
      pollId = setInterval(check, STREAM_POLL_MS);

      // Only counted once generation has ended, so a long reasoning phase is
      // not mistaken for the 30s "no answer text appeared" fallback.
      watchdogId = setInterval(() => {
        if (settled) return;
        if (!isCurrent()) { finish(null); return; }
        if (isGenerating()) {
          generationEndedAt = 0;
          return;
        }
        const now = Date.now();
        if (generationEndedAt === 0) generationEndedAt = now;
        if (now - generationEndedAt >= FINAL_TURN_WAIT_MS) check();
      }, STREAM_POLL_MS);

      check();
    });
  }

  function sendCompletion(snapshot, attempt) {
    const fingerprint = `${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.response.slice(0, 1000)}`;
    if (fingerprint === lastSentFingerprint) return;

    lastSentFingerprint = fingerprint;
    deferredTaskObserver?.refresh();
    runtimeMessage({
      type: 'CHATGPT_RESPONSE_COMPLETE',
      attemptId:attempt.id,completionStartedAt:attempt.startedAt,requestId:attempt.requestId,
      url:location.href,
      durationMs: consumeDuration(),
      sessionTitle: document.title,
      response: snapshot.response,
      goalPromptKey:snapshot.promptKey,goalNativeVerified:attempt.goalNativeVerified===true,
      goalRawExact:snapshot.goalMarkerExact===true,
      fingerprint,
      completionKey: snapshot.assistantKey
        ? `${snapshot.promptKey}|${snapshot.assistantKey}`
        : '',
      dismissOnReturn: false
    }).catch(() => {});
  }

  function scheduleActiveCompletionRecovery() {
    if(completionRecoveryTimer!==null)clearTimeout(completionRecoveryTimer);
    const id=globalThis.__chatgptNotifierAttemptId,path=location.pathname,token=watchToken;
    const scheduledAt=Date.now();
    let observedGeneration=false;
    const retry=async()=>{
      completionRecoveryTimer=null;
      if(!runtimeAvailable()||id!==globalThis.__chatgptNotifierAttemptId||path!==location.pathname||token!==watchToken)return;
      let recovered=false;
      try{recovered=await recoverActiveCompletion()===true;}catch{}
      const generating=isGenerating();
      observedGeneration ||= generating;
      // Keep observing a long-running request through temporary probe failures.
      // Before controls mount, allow only a short startup grace period.
      if(!recovered&&!currentErrors().length&&(generating||!observedGeneration&&Date.now()-scheduledAt<30000))
        completionRecoveryTimer=setTimeout(retry,Date.now()-scheduledAt<5000?1000:5000);
    };
    void retry();
  }

  async function recoverActiveCompletion() {
    if(!runtimeAvailable()||!isGenerating()||currentErrors().length)return;
    const id=globalThis.__chatgptNotifierAttemptId,startedAt=globalThis.__chatgptNotifierRequestStartedAt;
    const path=location.pathname,token=watchToken,snapshot=latestPromptSnapshot();
    if(!id||!snapshot?.promptKey)return;
    const native=await runtimeMessage({type:'CHATGPT_COMPLETION_PROBE',url:location.origin+path,startedAt,requestId:globalThis.__chatgptNotifierRequestId||null});
    if(!runtimeAvailable()||path!==location.pathname||token!==watchToken||id!==globalThis.__chatgptNotifierAttemptId||
        startedAt!==globalThis.__chatgptNotifierRequestStartedAt||latestPromptSnapshot()?.promptKey!==snapshot.promptKey||
        !native?.ok||native.promptKey!==snapshot.promptKey||native.turnStatus!=='in_progress'||native.isLatest!==true||native.isReadOnly!==false||native.hasError!==false||!native.generating)return;
    armForCurrentPrompt({resumed:true,nativeProgress:true});
    return true;
  }

  function persistCompletionAttempt(attempt) {
    const metadata={type:'CHATGPT_COMPLETION_CHECKPOINT',action:'update',url:attempt.url,startedAt:attempt.startedAt,requestId:attempt.requestId,
      baselineKey:attempt.baselineKey,promptKey:attempt.promptKey,httpCompleted:attempt.httpCompleted};
    attempt.checkpointWrite=(attempt.checkpointWrite||Promise.resolve()).then(()=>runtimeMessage(metadata)).catch(()=>null);
  }

  async function restoreCompletionCheckpoint() {
    const path=location.pathname,token=watchToken,initial=globalThis.__chatgptNotifierAttemptId,initialRequestId=globalThis.__chatgptNotifierRequestId;
    const result=await runtimeMessage({type:'CHATGPT_COMPLETION_CHECKPOINT',action:'restore',url:location.href});
    if(!runtimeAvailable()||path!==location.pathname||token!==watchToken||initial!==globalThis.__chatgptNotifierAttemptId||initialRequestId!==globalThis.__chatgptNotifierRequestId)return;
    const record=result?.ok&&result.record;
    if(!record||record.url!==(ChatGPTHandoffTitle.chatUrl(location.href)||location.origin+'/')||record.state!=='active'||typeof record.baselineKey!=='string'||
        !Number.isFinite(record.startedAt)||record.attemptId!==String(record.startedAt))return;
    if(initial&&initial!==record.attemptId&&(!Number.isFinite(Number(initial))||Number(initial)>record.startedAt))return;
    globalThis.__chatgptNotifierAttemptId=record.attemptId;
    globalThis.__chatgptNotifierRequestStartedAt=record.startedAt;
    globalThis.__chatgptNotifierRequestId=record.requestId||null;
    globalThis.__chatgptNotifierRequestReceipt=record.receipt||null;
    armForCurrentPrompt({restored:record});
    void audit('completion.checkpoint_restored',{promptKey:record.promptKey,startedAt:record.startedAt,bound:Boolean(record.promptKey)});
  }

  function armForCurrentPrompt(options={}) {
    const id=globalThis.__chatgptNotifierAttemptId;
    const startedAt=globalThis.__chatgptNotifierRequestStartedAt;
    const requestId=globalThis.__chatgptNotifierRequestId||null;
    if(completionAttempt&&completionAttempt.id===id&&completionAttempt.requestId===requestId&&completionAttempt.token===watchToken&&!options.resumed){
      if(options.completed){completionAttempt.httpCompleted=true;persistCompletionAttempt(completionAttempt);}
      return;
    }
    const intent=completionSendIntent;
    if(!intent&&!options.resumed&&!options.restored)return;
    if(options.resumed&&!options.nativeProgress)return;
    if(!options.resumed&&!options.restored&&(intent.path!==location.pathname||!Number.isFinite(startedAt)||startedAt<intent.at||startedAt-intent.at>10000))return;
    completionSendIntent=null;
    const snapshot=latestPromptSnapshot();
    const attempt={id,requestId,startedAt,token:watchToken,path:location.pathname,url:ChatGPTHandoffTitle.chatUrl(location.href)||location.origin+'/',
      baselineKey:options.restored?options.restored.baselineKey:options.resumed?'':intent.baselineKey,promptKey:options.restored?options.restored.promptKey:options.resumed?snapshot?.promptKey||'':'',httpCompleted:Boolean(options.completed||options.restored?.httpCompleted)};
    if(!id)return;
    completionAttempt=attempt;
    persistCompletionAttempt(attempt);
    const isCurrent=()=>{
      if(!runtimeAvailable()){stopContext();return false;}
      if(attempt.path==='/'&&/^\/c\//.test(location.pathname)){attempt.path=location.pathname;attempt.url=location.origin+location.pathname;persistCompletionAttempt(attempt);}
      return completionAttempt===attempt&&attempt.token===watchToken&&attempt.path===location.pathname&&
        attempt.id===globalThis.__chatgptNotifierAttemptId&&attempt.startedAt===globalThis.__chatgptNotifierRequestStartedAt&&attempt.requestId===(globalThis.__chatgptNotifierRequestId||null);
    };
    waitForAnswerBoundToLatestPrompt(isCurrent,attempt).then(async text=>{
      await attempt.checkpointWrite;
      if(!isCurrent()||!text)return;
      const resolved=latestPromptSnapshot();
      if(resolved?.response&&resolved.promptKey===attempt.promptKey)sendCompletion(resolved,attempt);
    });
  }

  function isStopButton(node) {
    if (!(node instanceof Element)) return false;
    return Boolean(node.closest(STOP_BUTTON_SELECTOR));
  }

  document.addEventListener('click', (event) => {
    if (!isStopButton(event.target)) return;
    if (stoppingRecovery && !event.isTrusted) return;
    if(event.isTrusted){
      void runtimeMessage({type:'CHATGPT_GOAL_MANUAL',url:location.href});
      const generation=statusIndicator?.loadingGeneration?.(),captured=globalThis.__chatgptNotifierRequestReceipt;
      const exact=!generation||generation.startedAt===globalThis.__chatgptNotifierRequestStartedAt&&generation.startReceipt?.epoch===captured?.epoch&&generation.startReceipt?.order===captured?.order;
      void runtimeMessage({type:'CHATGPT_GENERATION_STOPPED',url:location.href,startedAt:generation?.startedAt||deferredObservedStart||Number(globalThis.__chatgptNotifierAttemptId),
        requestId:exact?globalThis.__chatgptNotifierRequestId||null:null,startReceipt:generation?.startReceipt||null});
    }
    // A manual stop is not a successful completion. The next conversation
    // request will arm the watcher again.
    watchToken += 1;
    answerWaitSlot.cancel();
    suppressUntilEpoch = Date.now() + 1500;
  }, { capture: true, signal: listeners.signal });

  function onRuntimeMessage(message,sender,sendResponse) {
    if(!runtimeAvailable())return;
    if(message?.type==='CHATGPT_GOAL_DISPATCH') {
      if(!message.url||ChatGPTHandoffTitle.chatUrl(location.href)!==message.url){
        sendResponse?.({ok:false});
        return;
      }
      sendResponse?.({ok:true});
      // A second operation must wait for cleanup of a cancelled preparation.
      // Both operations independently require a fresh worker-owned grant.
      goalDispatchQueue=goalDispatchQueue.catch(()=>{}).then(async()=>{
        goalDispatchBusy=true;
        await dispatchGoal(message);
      });
      return;
    }
    if(message?.type==='CHATGPT_STATUS_TICK'){sendResponse?.({ok:statusIndicator?.tick(message)||false});return;}
    if(message?.type==='CHATGPT_STATUS_CHANGED') {if(statusIndicator?.accept(message))returnedPageUrl='';}
    if(message?.type==='CHATGPT_CONVERSATION_REQUEST_STARTED')confirmManualStatusIntent(message.startedAt,message.requestId);
    const currentRequest=message?.startedAt===globalThis.__chatgptNotifierRequestStartedAt&&(!globalThis.__chatgptNotifierRequestId||message.requestId===globalThis.__chatgptNotifierRequestId);
    if(message?.type==='CHATGPT_CONVERSATION_REQUEST_STARTED'&&currentRequest){deferredObservedStart=0;deferredTaskObserver?.requestStarted(message.startedAt);armForCurrentPrompt();}
    if(message?.type==='CHATGPT_HANDOFF_ROUTE_CHANGED'){deferredTaskObserver?.refresh();void statusIndicator?.refresh();notifyPageReturned();void restoreDraft(null,true).catch(()=>{});}
    if (runtimeAvailable() && message?.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED'&&currentRequest){deferredTaskObserver?.refresh();armForCurrentPrompt({completed:true});}
    if(message?.type==='CHATGPT_CONVERSATION_REQUEST_FAILED'&&currentRequest)armForCurrentPrompt();
    if(runtimeAvailable()&&['CHATGPT_HANDOFF_ROUTE_CHANGED','CHATGPT_CONVERSATION_REQUEST_COMPLETED'].includes(message?.type))scheduleHandoffCheck();
  }
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch { stopContext(); }
  const initialDraftRecovery=restoreDraft(null,true).catch(()=>{});
  const initialCompletionRecovery=restoreCompletionCheckpoint().catch(()=>{}).finally(()=>{
    if(runtimeAvailable()&&!completionAttempt&&isGenerating())scheduleActiveCompletionRecovery();
  });
  void Promise.all([initialDraftRecovery,initialCompletionRecovery]).then(()=>{
    if(runtimeAvailable())return runtimeMessage({type:'CHATGPT_GOAL_RECOVER',url:location.href});
  }).catch(()=>{});
})();
