'use strict';

(() => {
  const SCRIPT_VERSION = '1.2.7';
  if (globalThis.__chatgptNotifierVersion === SCRIPT_VERSION && globalThis.__chatgptNotifierAlive?.()) return;
  globalThis.__chatgptNotifierDispose?.();
  globalThis.__chatgptNotifierVersion = SCRIPT_VERSION;
  let contextAlive = true;
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

  function notifyPageReturned() {
    runtimeMessage({ type: 'CHATGPT_PAGE_RETURNED' }).catch(() => {});
  }

  window.addEventListener('focus', notifyPageReturned, { capture: true, signal: listeners.signal });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') notifyPageReturned();
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
      return { promptKey, assistantKey: '', response: '' };
    }

    const assistantTurn = turns[assistantIndex];
    return {
      promptKey,
      assistantKey:
        assistantTurn?.getAttribute('data-testid') ||
        assistantTurn?.getAttribute('data-chatgpt-search-unit-key') ||
        `assistant-${assistantIndex}`,
      response
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
      type: 'CHATGPT_RESPONSE_ERROR', ...error, retryReason
    }).catch(() => {});
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

  function restoreDraft(operationId = null) {
    const path = location.pathname;
    const draft = pendingDrafts.get(path);
    if (!draft) return;
    const editor = composer();
    if (!editor || !isElementVisible(editor)) return;
    const current = rawEditorText(editor);
    // Retain text entered during the send as well as the original draft.
    const restored = !normalize(current) || normalize(current) === RETRY_TEXT
      ? draft : `${draft}\n\n${current}`;
    // Keep the backup until the editor accepted the restoration.
    replaceEditorText(editor, restored);
    pendingDrafts.delete(path);
    void audit('draft.restored', {operationId,draftChars:draft.length, restoredChars:restored.length});
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

  async function retryAfterError(error, attempt, path, promptKey, state) {
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
    const stillCurrent = () => runtimeAvailable() && watchToken === expectedToken && location.pathname === path && retryState() === state && !state.blocked &&
      (globalThis.__chatgptNotifierAttemptId || '') === attempt &&
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
      const deadline = Date.now() + 10000;
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
      let button = sendButton();
      while (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
        if (!stillCurrent()) return;
        if (editorText(editor) !== RETRY_TEXT) throw new Error('Содержимое поля изменилось');
        if (Date.now() >= deadline) throw new Error('Кнопка отправки недоступна');
        await sleepUntilNextCheck();
        button = sendButton();
      }
      if (!stillCurrent() || editorText(editor) !== RETRY_TEXT) return;
      await waitForExactComposer(RETRY_TEXT, () => stillCurrent() && rawEditorText(composer() || editor) === RETRY_TEXT);
      // Exactly one click. An uncertain send is never automatically repeated.
      await logRetry('retry.send_intent',{operationId,text:RETRY_TEXT,promptKey},true);
      if (!stillCurrent() || editorText(editor) !== RETRY_TEXT) return;
      if (!runtimeAvailable()) return;
      clicked = true; // A lost reply may still mean the page received the click.
      const sent = await inspectComposer(RETRY_TEXT,'send',{operationId});
      if (sent?.ok === false) clicked = false;
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
      await logRetry('retry.failed',{operationId,clicked,confirmed,error:String(cause.message || cause)});
      state.blocked = true;
      state.reason = `Автопродолжение остановлено: ${cause.message}`;
      notifyError(error, state.reason);
    } finally {
      if (!clicked) void logRetry('retry.cancelled',{operationId,reason:'Отправка не выполнялась'});
      else if (!confirmed && !state.blocked) void logRetry('retry.failed',{operationId,clicked:true,confirmed:false,reason:'Контекст чата изменился; результат отправки неизвестен'});
      replacingDraft = false;
      if (replaced && runtimeAvailable() && location.pathname === path) {
        try {
          if (pendingDrafts.has(path)) {
            if (!clicked || (globalThis.__chatgptNotifierAttemptId || '') !== attempt) restoreDraft(operationId);
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
    const attemptKey = `${promptKey}|${attempt}`;
    // Rewording/remounting one error does not count as another failed request.
    if (state.lastAttempt === attemptKey) return;
    state.lastAttempt = attemptKey;
    const now = Date.now();
    state.failures = state.failures.filter((at) => now - at <= RETRY_WINDOW_MS);
    state.failures.push(now);
    if (state.blocked || state.failures.length >= 4 || state.remainingRetries===0) {
      state.blocked = true;
      state.reason ||= state.remainingRetries===0?'Дополнительные автоповторы исчерпаны':'Автопродолжение остановлено: 3 автоповтора за 2 минуты';
      void audit('retry.blocked',{reason:state.reason,failureCount:state.failures.length,windowMs:RETRY_WINDOW_MS,error:error.response});
      notifyError(error, state.reason);
      return;
    }
    if(state.remainingRetries!=null)state.remainingRetries--;
    const path = location.pathname;
    retryTask = retryTask.then(() => retryAfterError(error, attempt, path, promptKey, state));
  }

  // A deliberate manual send starts a new run; automated clicks are untrusted.
  document.addEventListener('click', (event) => {
    if (event.isTrusted && event.target instanceof Element &&
        event.target.closest('button[data-testid="send-button"], button#composer-submit-button, [data-composer-body] button[type="submit"]')) {
      retryStates.delete(location.pathname);
      void audit('retry.manual_reset',{input:'send-button'});
    }
  }, { capture: true, signal: listeners.signal });
  document.addEventListener('keydown', (event) => {
    if (event.isTrusted && event.key === 'Enter' && !event.shiftKey && !event.isComposing &&
        event.target instanceof Element && event.target.closest('#prompt-textarea, [data-composer-markdown]')) {
      retryStates.delete(location.pathname);
      void audit('retry.manual_reset',{input:'enter'});
    }
  }, { capture: true, signal: listeners.signal });

  let handoffRecord = null;
  let handoffBusy = false;

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
  }

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
      const beforeAttempt = globalThis.__chatgptNotifierAttemptId || '';
      await updateHandoff('sending', { targetUrl: location.href });
      if (location.pathname !== initialPath || rawEditorText(editor) !== record.prompt) throw new Error('Содержимое нового чата изменилось перед отправкой');
      if (!runtimeAvailable()) return;
      clicked = true;
      const sent = await inspectComposer(record.prompt,'send',{operationId:record.id,requireMax:true,fileName:record.asFile?record.fileName:null});
      if (sent?.ok === false) clicked = false;
      if (!sent?.ok || !sent.clicked) throw new Error(sent?.reason || 'Безопасная отправка истории не подтверждена');
      void audit('handoff.clicked',{operationId:record.id,sourceUrl:record.sourceUrl,targetUrl:location.href});
      await waitHandoff(() => {
        const current = composer();
        const dispatched = (globalThis.__chatgptNotifierAttemptId || '') !== beforeAttempt;
        const newConversation = location.pathname !== initialPath && /\/c\/[^/]+/.test(location.pathname);
        // ChatGPT can hide the first user message entirely. A newly allocated
        // conversation plus the observed POST and cleared editor confirm send.
        return dispatched && current && !editorText(current) && /\/c\/[^/]+/.test(location.pathname) &&
          (turnNodes().some((node) => roleOf(node) === 'user') || newConversation);
      },60000);
      await updateHandoff('sent', { targetUrl: location.href });
      if (record.draft) {
        pendingDrafts.set(location.pathname, record.draft);
        restoreDraft(record.id);
      }
      void renameHandoff();
    } catch (cause) {
      try { await updateHandoff('failed', { reason: String(cause.message || cause) }); } catch {}
      notifyError({ sessionTitle: document.title, response: `Передача в новый чат остановлена: ${cause.message}. Копия истории сохранена в расширении.` },
        clicked ? 'Отправка не повторяется автоматически' : 'Историю можно скачать из меню расширения');
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
    const text = handoffText(info.messages, error.response, sourceUrl);
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

  async function routeError(error, promptKey, alert) {
    const sourcePath = location.pathname;
    const attemptId = globalThis.__chatgptNotifierAttemptId || '';
    // A pre-existing error already observed before an extension update is not
    // a new failed request. A real/manual request gets a new attempt or prompt.
    if(!attemptId&&retryState().restoredPromptKey===promptKey)return;
    let info;
    try {
      info = await runtimeMessage({ type: 'CHATGPT_INSPECT_ERROR',
        alertIndex: Array.from(document.querySelectorAll(ERROR_SELECTOR)).indexOf(alert), captureHistory: true });
    } catch {}
    if (location.pathname !== sourcePath || (globalThis.__chatgptNotifierAttemptId || '') !== attemptId) return;
    await audit('error.detected',{error:error.response,action:info?.action || 'unknown',promptKey,durationMs:error.durationMs,attemptId});
    if (location.pathname !== sourcePath || (globalThis.__chatgptNotifierAttemptId || '') !== attemptId) return;
    if (info?.ok && info.action === 'retry') {
      handleError(error, promptKey);
      return;
    }
    const state = retryState();
    if (state.terminalHandled) return;
    state.terminalHandled = true;
    state.blocked = true;
    void audit('retry.blocked',{reason:info?.action === 'new-chat'?'Требуется новый чат':'Неизвестный тип ошибки',terminal:true});
    // A new-chat recovery action is terminal: never send a retry in this chat.
    notifyError(error, info?.action === 'new-chat' ? 'Требуется новый чат' : 'Автоповтор отключён: неизвестный тип ошибки');
    if (info?.ok && info.action === 'new-chat') {
      try { await beginHandoff(error, info, alert); }
      catch (cause) { notifyError(error, String(cause.message || cause)); }
    }
  }

  async function resumeSavedHandoff() {
    try {
      const result = await runtimeMessage({ type: 'CHATGPT_HANDOFF_GET' });
      if (!handoffRecord) handoffRecord = result?.record || null;
      if (handoffRecord?.stage === 'sending') {
        notifyError({ sessionTitle: document.title, response: 'Передача прервалась после начала отправки. Повторная отправка отключена; копия сохранена в расширении.' });
      } else if (handoffRecord?.stage==='sent') {
        void renameHandoff();
      } else {
        await submitHandoff();
      }
    } catch {}
  }

  async function renameHandoff() {
    const record=handoffRecord;
    if (!record?.naming || record.stage!=='sent' || record.targetUrl!==location.href) return;
    const result=await runtimeMessage({type:'CHATGPT_HANDOFF_RENAME',id:record.id});
    if(result?.ok===false) notifyError({sessionTitle:document.title,response:`История передана, но название нового чата не изменено: ${result.reason}`});
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
      try { restoreDraft(); } catch {}
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

  function waitForAnswerBoundToLatestPrompt(isCurrent) {
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

        // Safety valve: a stop button that never clears must not wedge the
        // watcher. Abort without notifying, because the answer never finished.
        if (Date.now() - startedAt >= GENERATION_HARD_CAP_MS) {
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

        const text = answerBoundToLatestPrompt();
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
        if (now - stableSince >= STREAM_SETTLE_MS) finish(text);
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
        if (now - generationEndedAt >= FINAL_TURN_WAIT_MS) {
          finish(answerBoundToLatestPrompt() || 'Response finished.');
        }
      }, STREAM_POLL_MS);

      check();
    });
  }

  function sendCompletion(snapshot) {
    const fingerprint = `${snapshot.promptKey}|${snapshot.assistantKey}|${snapshot.response.slice(0, 1000)}`;
    if (fingerprint === lastSentFingerprint) return;

    lastSentFingerprint = fingerprint;
    runtimeMessage({
      type: 'CHATGPT_RESPONSE_COMPLETE',
      durationMs: consumeDuration(),
      sessionTitle: document.title,
      response: snapshot.response,
      fingerprint,
      completionKey: snapshot.assistantKey
        ? `${snapshot.promptKey}|${snapshot.assistantKey}`
        : '',
      dismissOnReturn: false
    }).catch(() => {});
  }

  function armForCurrentPrompt() {
    if (Date.now() < suppressUntilEpoch) return;
    const token = watchToken;
    const path = location.pathname;
    const attempt = globalThis.__chatgptNotifierAttemptId;
    const requestStartedAt = globalThis.__chatgptNotifierRequestStartedAt;
    const isCurrent = () => {
      if (!runtimeAvailable()) { stopContext(); return false; }
      return token === watchToken && path === location.pathname && attempt === globalThis.__chatgptNotifierAttemptId &&
        requestStartedAt === globalThis.__chatgptNotifierRequestStartedAt;
    };
    waitForAnswerBoundToLatestPrompt(isCurrent)
      .then((text) => {
        if (!isCurrent() || !text) return;
        const resolved = latestPromptSnapshot();
        if (resolved?.response) {
          sendCompletion(resolved);
        } else {
          sendCompletion({
            promptKey: '',
            assistantKey: '',
            response: text
          });
        }
      });
  }

  function isStopButton(node) {
    if (!(node instanceof Element)) return false;
    return Boolean(node.closest(STOP_BUTTON_SELECTOR));
  }

  document.addEventListener('click', (event) => {
    if (!isStopButton(event.target)) return;
    if (stoppingRecovery && !event.isTrusted) return;
    // A manual stop is not a successful completion. The next conversation
    // request will arm the watcher again.
    watchToken += 1;
    answerWaitSlot.cancel();
    suppressUntilEpoch = Date.now() + 1500;
  }, { capture: true, signal: listeners.signal });

  function onRuntimeMessage(message) {
    if (runtimeAvailable() && message?.type === 'CHATGPT_CONVERSATION_REQUEST_COMPLETED') armForCurrentPrompt();
  }
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch { stopContext(); }
})();
