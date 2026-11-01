'use strict';

// One writer (the service worker), one atomic storage.set per event + sequence.
// No automatic deletion: a failed write stops automatic sends rather than hiding a gap.
const JOURNAL_PREFIX = 'chatgpt-journal:event:';
const JOURNAL_META = 'chatgpt-journal:meta';
let journalQueue = Promise.resolve();
let journalFailure = '';
const RETRY_STATE_WINDOW_MS = 120000;
const RETRY_MIGRATION_BATCH_SIZE = 50;
function journalChatId(value) {
  try { const url = new URL(value); return url.origin === 'https://chatgpt.com' ? url.pathname.match(/\/c\/([^/]+)/)?.[1] || null : null; }
  catch { return null; }
}
function reduceRetrySummary(retryByChat, event) {
  const chatId = journalChatId(event.sourceUrl || event.observedTabUrl || event.url);
  if (!chatId) return retryByChat;
  if (event.kind === 'retry.manual_reset') {
    const next = {...retryByChat};
    delete next[chatId];
    return next;
  }
  if(event.kind==='retry.resume' && Number.isInteger(event.remainingRetries) && event.remainingRetries>=1 && event.remainingRetries<=3) {
    return {...retryByChat,[chatId]:{failures:[],recentErrors:[],blocked:false,terminal:false,reason:'',
      lastPromptKey:'',lastAttemptId:'',remainingRetries:event.remainingRetries}};
  }
  if(event.kind==='retry.planned' && retryByChat[chatId]?.remainingRetries!=null) {
    const state=retryByChat[chatId];
    if(state.lastBudgetOperation===event.operationId)return retryByChat;
    return {...retryByChat,[chatId]:{...state,remainingRetries:Math.max(0,state.remainingRetries-1),lastBudgetOperation:event.operationId}};
  }
  const isRetryError = event.kind === 'error.detected' && event.action === 'retry';
  const isBlocked = ['retry.blocked', 'retry.failed', 'draft.restore_failed'].includes(event.kind);
  if (!isRetryError && !isBlocked) return retryByChat;
  const previous = Object.hasOwn(retryByChat, chatId) ? retryByChat[chatId] : {};
  const now = Number.isFinite(event.recordedAt) ? event.recordedAt : Date.now();
  const inWindow = (at) => Number.isFinite(at) && at <= now && now - at <= RETRY_STATE_WINDOW_MS;
  const state = {...previous,
    failures: (previous.failures || []).filter(inWindow),
    recentErrors: (previous.recentErrors || []).filter((item) => inWindow(item.at))
  };
  if (isRetryError) {
    const promptKey = String(event.promptKey || '');
    const attemptId = String(event.attemptId || '');
    const duplicate = (previous.lastPromptKey === promptKey && previous.lastAttemptId === attemptId) ||
      state.recentErrors.some((item) => item.promptKey === promptKey && item.attemptId === attemptId);
    if (!duplicate) {
      const at = Number.isFinite(event.eventAt) ? Math.min(event.eventAt, now) : now;
      if (inWindow(at)) {
        state.failures.push(at);
        state.recentErrors.push({at, promptKey, attemptId});
      }
    }
    state.lastPromptKey = promptKey;
    state.lastAttemptId = attemptId;
  }
  if (isBlocked) {
    state.blocked = true;
    state.reason = String(event.reason || event.error || previous.reason || 'Автопродолжение остановлено');
    state.terminal = Boolean(previous.terminal || event.terminal === true);
  }
  return {...retryByChat, [chatId]: state};
}
async function retryMetadata(meta) {
  if (meta.retrySchema === 1) return meta;
  let retryByChat = {};
  // Replay existing immutable events in sequence, without loading full history
  // (handoff payloads may be large) or racing the serialized journal writer.
  for (let first = 1; first <= meta.sequence; first += RETRY_MIGRATION_BATCH_SIZE) {
    const keys = [];
    for (let sequence = first; sequence <= Math.min(meta.sequence, first + RETRY_MIGRATION_BATCH_SIZE - 1); sequence += 1) {
      keys.push(`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`);
    }
    const batch = await chrome.storage.local.get(keys);
    for (const key of keys) if (batch[key]) retryByChat = reduceRetrySummary(retryByChat, batch[key]);
  }
  return {...meta, retrySchema: 1, retryByChat};
}
function appendJournal(event, tab = {}) {
  const write = journalQueue.catch(() => {}).then(async () => {
    const meta = await retryMetadata((await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META] || { sequence: 0, startedAt: Date.now() });
    const sequence = meta.sequence + 1;
    const tabId = tab.id ?? event.tabId ?? null;
    const tabs = {...meta.tabs};
    tab = {...tabs[tabId],...tab};
    if (tab.id != null && tab.url) tabs[tab.id] = {id:tab.id,url:tab.url,title:tab.title,windowId:tab.windowId};
    const sourceUrl = event.sourceUrl && event.sourceUrl !== 'https://chatgpt.com' ? event.sourceUrl : tab.url || event.sourceUrl || event.url || '';
    const targetUrl = event.targetUrl || '';
    const active = { ...meta.active };
    const requests = { ...meta.requests };
    let operationId = event.operationId || null;
    if (event.kind === 'tab.updated') operationId ||= active[tabId]?.operationId || null;
    if (event.kind === 'request.started') {
      operationId ||= Date.now() - (active[tabId]?.at || 0) < 120000 ? active[tabId]?.operationId || null : null;
      requests[event.requestId] = {operationId,sourceUrl};
    }
    if (['request.completed','request.failed'].includes(event.kind)) operationId ||= requests[event.requestId]?.operationId || null;
    if (['retry.send_intent','handoff.sending'].includes(event.kind)) active[tabId] = {operationId,kind:event.kind,at:Date.now()};
    if (event.kind === 'send.authorized') {
      if (!active[tabId] || active[tabId].operationId !== operationId || active[tabId].consumed) throw Object.assign(new Error('Повторная автоматическая отправка запрещена'),{journalPolicy:true});
      active[tabId] = {...active[tabId],consumed:true};
    }
    if (['retry.confirmed','retry.failed','retry.cancelled','retry.manual_reset','handoff.sent','handoff.failed','tab.closed'].includes(event.kind) &&
      (!operationId || active[tabId]?.operationId === operationId)) delete active[tabId];
    const requestSource = requests[event.requestId]?.sourceUrl;
    if (['request.completed','request.failed'].includes(event.kind)) delete requests[event.requestId];
    const entry = { ...event, schema: 1, sequence, recordedAt: Date.now(),
      ...(journalFailure ? {previousWriteError:journalFailure,note:'После ошибки записи возможен пропуск событий; автоматические отправки при ошибке записи блокируются'} : {}),
      operationId, automatic: event.kind.startsWith('request.') ? Boolean(operationId) : event.automatic,
      version: chrome.runtime.getManifest().version, tabId,
      windowId: tab.windowId ?? null, title: event.title || tab.title || '',
      sourceUrl:requestSource || sourceUrl, sourceChatId:journalChatId(requestSource || sourceUrl), targetUrl, targetChatId: journalChatId(targetUrl),
      observedTabUrl: tab.url || '', observedChatId: journalChatId(tab.url) };
    if (event.kind === 'tab.closed') delete tabs[tabId];
    await chrome.storage.local.set({ [`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`]: entry,
      [JOURNAL_META]: { ...meta, sequence, active, requests, tabs, lastAt: entry.recordedAt,
        retryByChat: reduceRetrySummary(meta.retryByChat || {}, entry) } });
    journalFailure = '';
    return { ok: true, sequence };
  });
  journalQueue = write;
  return write.catch((error) => { if (!error.journalPolicy) {journalFailure = String(error?.message || error); console.error('Journal write failed', journalFailure);} throw error; });
}
async function readRetryState(url) {
  // A first read after upgrading may precede initializeJournal's append. Put
  // migration on the same queue so it cannot overwrite a concurrently logged error.
  const read = journalQueue.catch(() => {}).then(async () => {
    const saved = (await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    if (!saved) return null;
    const meta = await retryMetadata(saved);
    if (saved.retrySchema !== 1) await chrome.storage.local.set({[JOURNAL_META]: meta});
    const chatId = journalChatId(url);
    const state = chatId && Object.hasOwn(meta.retryByChat || {}, chatId) ? meta.retryByChat[chatId] : null;
    if (!state) return null;
    const now = Date.now();
    return {...state, failures: (state.failures || []).filter((at) => Number.isFinite(at) && at <= now && now - at <= RETRY_STATE_WINDOW_MS),
      recentErrors: (state.recentErrors || []).filter((item) => Number.isFinite(item.at) && item.at <= now && now - item.at <= RETRY_STATE_WINDOW_MS)};
  });
  journalQueue = read;
  return read;
}
function journalInBackground(event, tab) { void appendJournal(event, tab).catch(() => {}); }
function journalRequest(kind, details) {
  // Queue immediately, preserving request order; documentUrl is the URL at send time.
  journalInBackground({kind, tabId:details.tabId, requestId:details.requestId, attemptId:String(details.timeStamp),
    eventAt:details.timeStamp, sourceUrl:details.documentUrl || details.initiator || '',
    statusCode:details.statusCode, error:details.error});
}
async function readJournal() {
  await journalQueue.catch(() => {});
  const values = await chrome.storage.local.get(null);
  return { ok: true, schema: 1, exportedAt: Date.now(), meta: values[JOURNAL_META] || null,
    storageError: journalFailure,
    events: Object.entries(values).filter(([key]) => key.startsWith(JOURNAL_PREFIX)).map(([, value]) => value).sort((a,b) => a.sequence - b.sequence) };
}
async function initializeJournal(reason) {
  const meta = (await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
  if (!meta) {
    await appendJournal({ kind: 'journal.started', reason, note: 'С этого момента ведётся журнал. Прошлые автоповторы восстановить нельзя.' });
    const saved = await chrome.storage.local.get(null);
    for (const [key, record] of Object.entries(saved)) {
      if (/^chatgpt-handoff:\d+$/.test(key) && record?.id) {
        await appendJournal({ kind: 'handoff.imported', operationId: record.id, sourceUrl: record.sourceUrl,
          targetUrl: record.targetUrl, stage: record.stage, originalCreatedAt: record.createdAt,
          text: record.text, prompt: record.prompt, asFile: record.asFile, reason: record.reason,
          provenance: 'Сохранённое состояние до начала журнала; это не запись наблюдения отправки' }, { id: Number(key.split(':')[1]) });
      }
    }
  }
  await appendJournal({ kind: 'extension.started', reason });
}
