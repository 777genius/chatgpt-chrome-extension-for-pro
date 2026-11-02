"use strict";

// The service worker owns the immutable, append-only journal. Every event
// advances one queue and is persisted atomically with its sequence metadata.
// Unknown outcomes never grant a second automatic send.
interface RetryDraft {
  operationId?: string;
  sourceUrl?: string;
  savedSequence?: number;
  phase?: string;
  claimedAt?: number;
  claimSequence?: number;
  replacementProven?: boolean;
  stopProven?: boolean;
}
interface RetryError { at: number; promptKey: string; attemptId: string }
interface RetrySummary {
  failures: number[];
  recentErrors: RetryError[];
  blocked?: boolean;
  terminal?: boolean;
  reason?: string;
  lastPromptKey?: string;
  lastAttemptId?: string;
  remainingRetries?: number;
  lastBudgetOperation?: string | null;
}
interface JournalTab {
  id?: number;
  url?: string;
  title?: string;
  windowId?: number | null;
}
interface ActiveJournalOp {
  operationId?: string | null;
  kind?: string;
  at: number;
  consumed?: boolean;
}
interface JournalRequestOp {
  operationId?: string | null;
  sourceUrl?: string;
}
interface JournalMeta extends Record<string, unknown> {
  sequence: number;
  startedAt: number;
  retrySchema?: number;
  retryByChat: Record<string, RetrySummary>;
  retryDraftSchema?: number;
  retryDraftByChat: Record<string, RetryDraft>;
  retryDraftClaims: Record<string, number>;
  active?: Record<string, ActiveJournalOp>;
  requests?: Record<string, JournalRequestOp>;
  tabs?: Record<string, JournalTab>;
  lastAt?: number;
}
interface JournalEvent extends Record<string, unknown> {
  kind: string;
  operationId?: string | null;
  requestId?: string;
  tabId?: number | null;
  sourceUrl?: string;
  observedTabUrl?: string;
  targetUrl?: string;
  url?: string;
  title?: string;
  response?: string;
  text?: string;
  prompt?: string;
  draft?: string;
  sequence?: number;
  savedSequence?: number;
  recordedAt?: number;
  eventAt?: number;
  attemptId?: string;
  action?: string;
  reason?: string;
  error?: string;
  remainingRetries?: number;
  clicked?: boolean;
  stopped?: boolean;
  statusCode?: number;
  automatic?: boolean;
  terminal?: boolean;
  originalCreatedAt?: number;
  initiator?: string;
}
interface JournalResult {
  ok: true;
  sequence: number;
  sourceUrl: string;
  record?: RetryDraft & { draft: string };
}
interface JournalChrome {
  runtime: { getManifest(): { version: string } };
  storage: {
    local: {
      get(keys: string | readonly string[] | null): Promise<Record<string, unknown>>;
      set(entries: Record<string, unknown>): Promise<unknown>;
    };
  };
}
declare const chrome: JournalChrome;
function journalObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function journalMeta(value: unknown): JournalMeta {
  if (!journalObject(value) || !Number.isSafeInteger(value.sequence) ||
      typeof value.sequence !== "number" || value.sequence < 0) {
    throw new Error("Journal metadata is invalid; automation must stop");
  }
  // The writer is the sole owner of these serialized records. Preserve every
  // historic key and never rewrite a record merely to satisfy a newer shape.
  return value as JournalMeta;
}
function journalEvent(value: unknown): JournalEvent | null {
  return journalObject(value) && typeof value.kind === "string"
    ? value as JournalEvent : null;
}
function journalMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
// One writer (the service worker), one atomic storage.set per event + sequence.
// No automatic deletion: a failed write stops automatic sends rather than hiding a gap.
const JOURNAL_PREFIX = 'chatgpt-journal:event:';
const JOURNAL_META = 'chatgpt-journal:meta';
let journalQueue: Promise<unknown> = Promise.resolve();
let journalFailure = '';
const RETRY_STATE_WINDOW_MS = 120000;
const RETRY_MIGRATION_BATCH_SIZE = 50;
function journalChatId(value: string | undefined | null): string | null {
  if(typeof value!=='string')return null;
  try { const url = new URL(value); return url.origin === 'https://chatgpt.com' ? url.pathname.match(/\/c\/([^/]+)/)?.[1] || null : null; }
  catch { return null; }
}
function retryDraftUrl(value: string | undefined | null): string | null {
  if(typeof value!=='string')return null;
  try { const url=new URL(value); return url.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)?`${url.origin}${url.pathname.replace(/\/$/,'')}`:null; }
  catch { return null; }
}
function retryDraftMetadata(meta: JournalMeta): JournalMeta {
  // Historical backups remain in the immutable journal. They lack a durable
  // restoration claim, so importing them could insert an already-used draft.
  return meta.retryDraftSchema===1?meta:{...meta,retryDraftSchema:1,retryDraftByChat:{},retryDraftClaims:{}};
}
function reduceRetryDraft(drafts: Record<string,RetryDraft>,event: JournalEvent): Record<string,RetryDraft> {
  const url=retryDraftUrl(event.sourceUrl||event.observedTabUrl||event.url);
  if(!url)return drafts;
  const current=drafts[url],operationId=event.operationId;
  if(event.kind==='draft.saved'&&operationId&&typeof event.draft==='string'&&event.draft) {
    if(current?.operationId===operationId&&current.claimedAt)return drafts;
    const previous=current?.operationId===operationId?current:{};
    return {...drafts,[url]:{...previous,operationId,sourceUrl:url,
      savedSequence:event.sequence,phase:previous.phase||'saved'}};
  }
  if(!current||(operationId&&operationId!==current.operationId))return drafts;
  if(event.kind==='draft.replaced')return {...drafts,[url]:{...current,replacementProven:true}};
  if(event.kind==='recovery.stop_result'&&event.stopped===true)return {...drafts,[url]:{...current,stopProven:true}};
  let phase=current.phase;
  if(event.kind==='retry.send_intent')phase='intent';
  if(['send.authorized','send.dispatched','draft.restore_deferred'].includes(event.kind))phase='unknown';
  if(event.kind==='retry.confirmed')phase='confirmed';
  if(event.kind==='retry.cancelled'||event.kind==='retry.failed'&&event.clicked===false)phase='not-clicked';
  if(event.kind==='retry.manual_reset')phase='superseded';
  if(event.kind==='draft.restored')phase='restored';
  if(event.kind==='draft.restore_intent')return {...drafts,[url]:{...current,phase:'claimed',claimedAt:event.recordedAt,claimSequence:event.sequence}};
  return phase===current.phase?drafts:{...drafts,[url]:{...current,phase}};
}
function retryDraftClaimable(record: RetryDraft | null | undefined): record is RetryDraft {
  return Boolean(record&&!record.claimedAt&&typeof record.phase==='string'&&['saved','intent','not-clicked','confirmed'].includes(record.phase));
}
async function indexedRetryDraft(meta: JournalMeta | null,url: string): Promise<(RetryDraft & {draft:string}) | null> {
  const record=meta?.retryDraftSchema===1?meta.retryDraftByChat?.[retryDraftUrl(url)||'']:null;
  if(!record||typeof record.savedSequence!=='number'||!Number.isInteger(record.savedSequence)||record.savedSequence<1)return null;
  const key=`${JOURNAL_PREFIX}${String(record.savedSequence).padStart(12,'0')}`;
  const entry=journalEvent((await chrome.storage.local.get(key))[key]);
  return entry?.kind==='draft.saved'&&entry.operationId===record.operationId&&retryDraftUrl(entry.sourceUrl)===record.sourceUrl&&
    typeof entry.draft==='string'&&entry.draft?{...record,draft:entry.draft}:null;
}
function reduceRetrySummary(retryByChat: Record<string, RetrySummary>, event: JournalEvent): Record<string, RetrySummary> {
  const chatId = journalChatId(event.sourceUrl || event.observedTabUrl || event.url);
  if (!chatId) return retryByChat;
  if (event.kind === 'retry.manual_reset') {
    const next = {...retryByChat};
    delete next[chatId];
    return next;
  }
  if(event.kind==='retry.resume' && typeof event.remainingRetries==='number' && Number.isInteger(event.remainingRetries) && event.remainingRetries>=1 && event.remainingRetries<=3) {
    return {...retryByChat,[chatId]:{failures:[],recentErrors:[],blocked:false,terminal:false,reason:'',
      lastPromptKey:'',lastAttemptId:'',remainingRetries:event.remainingRetries}};
  }
  if(event.kind==='retry.planned' && retryByChat[chatId]?.remainingRetries!=null) {
    const state=retryByChat[chatId]!;
    if(state.lastBudgetOperation===event.operationId)return retryByChat;
    return {...retryByChat,[chatId]:{...state,remainingRetries:Math.max(0,state.remainingRetries!-1),lastBudgetOperation:event.operationId}};
  }
  const isRetryError = event.kind === 'error.detected' && event.action === 'retry';
  const isBlocked = ['retry.blocked', 'retry.failed', 'draft.restore_failed'].includes(event.kind);
  if (!isRetryError && !isBlocked) return retryByChat;
  const previous: Partial<RetrySummary> = Object.hasOwn(retryByChat, chatId) ? retryByChat[chatId]! : {};
  const now = typeof event.recordedAt==='number'&&Number.isFinite(event.recordedAt) ? event.recordedAt : Date.now();
  const inWindow = (at: number) => Number.isFinite(at) && at <= now && now - at <= RETRY_STATE_WINDOW_MS;
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
      const at = typeof event.eventAt==='number'&&Number.isFinite(event.eventAt) ? Math.min(event.eventAt, now) : now;
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
async function retryMetadata(meta: JournalMeta): Promise<JournalMeta> {
  if (meta.retrySchema === 1) return meta;
  let retryByChat: Record<string,RetrySummary> = {};
  // Replay existing immutable events in sequence, without loading full history
  // (handoff payloads may be large) or racing the serialized journal writer.
  for (let first = 1; first <= meta.sequence; first += RETRY_MIGRATION_BATCH_SIZE) {
    const keys = [];
    for (let sequence = first; sequence <= Math.min(meta.sequence, first + RETRY_MIGRATION_BATCH_SIZE - 1); sequence += 1) {
      keys.push(`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`);
    }
    const batch = await chrome.storage.local.get(keys);
    for (const key of keys) { const event=journalEvent(batch[key]);if(event)retryByChat = reduceRetrySummary(retryByChat,event); }
  }
  return {...meta, retrySchema: 1, retryByChat};
}
function appendJournal(event: JournalEvent, tab: JournalTab = {}): Promise<JournalResult> {
  const write = journalQueue.catch(() => {}).then(async () => {
    const savedMeta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    const initial:JournalMeta=savedMeta?journalMeta(savedMeta):{sequence:0,startedAt:Date.now(),retryByChat:{},retryDraftByChat:{},retryDraftClaims:{}};
    const meta = retryDraftMetadata(await retryMetadata(initial));
    const sequence = meta.sequence + 1;
    const tabId = tab.id ?? event.tabId ?? null;
    const tabKey=String(tabId);
    const tabs:Record<string,JournalTab> = {...meta.tabs};
    tab = {...tabs[tabKey],...tab};
    if (tab.id != null && tab.url) tabs[tab.id] = {id:tab.id,url:tab.url,title:tab.title,windowId:tab.windowId};
    const sourceUrl = event.sourceUrl && event.sourceUrl !== 'https://chatgpt.com' ? event.sourceUrl : tab.url || event.sourceUrl || event.url || '';
    const targetUrl = event.targetUrl || '';
    const active:Record<string,ActiveJournalOp> = { ...meta.active };
    const requests:Record<string,JournalRequestOp> = { ...meta.requests };
    let operationId: string | null = event.operationId || null;
    const savedDraft=meta.retryDraftByChat[retryDraftUrl(sourceUrl)||''];
    if(event.kind==='draft.restore_intent'&&(!retryDraftClaimable(savedDraft)||savedDraft?.operationId!==operationId||savedDraft?.savedSequence!==event.savedSequence)) {
      throw Object.assign(new Error('Восстановление черновика уже выполнено или исход отправки неизвестен'),{journalPolicy:true});
    }
    const claimedDraft=event.kind==='draft.restore_intent'?await indexedRetryDraft(meta,sourceUrl):null;
    if(event.kind==='draft.restore_intent'&&!claimedDraft)throw Object.assign(new Error('Не найдена точная сохранённая копия черновика'),{journalPolicy:true});
    if (event.kind === 'tab.updated') operationId ||= active[tabKey]?.operationId || null;
    if (event.kind === 'request.started') {
      operationId ||= Date.now() - (active[tabKey]?.at || 0) < 120000 ? active[tabKey]?.operationId || null : null;
      requests[event.requestId||'undefined'] = {operationId,sourceUrl};
    }
    if (['request.completed','request.failed'].includes(event.kind)) operationId ||= requests[event.requestId||'undefined']?.operationId || null;
    if (['retry.send_intent','handoff.sending'].includes(event.kind)) active[tabKey] = {operationId,kind:event.kind,at:Date.now()};
    if (event.kind === 'send.authorized') {
      if(operationId&&meta.retryDraftClaims?.[operationId])throw Object.assign(new Error('Черновик уже передан на восстановление; отправка отменена'),{journalPolicy:true});
      if (!active[tabKey] || active[tabKey].operationId !== operationId || active[tabKey].consumed) throw Object.assign(new Error('Повторная автоматическая отправка запрещена'),{journalPolicy:true});
      active[tabKey] = {...active[tabKey],consumed:true};
    }
    if (['retry.confirmed','retry.failed','retry.cancelled','retry.manual_reset','handoff.sent','handoff.failed','tab.closed'].includes(event.kind) &&
      (!operationId || active[tabKey]?.operationId === operationId)) delete active[tabKey];
    const requestSource = requests[event.requestId||'undefined']?.sourceUrl;
    if (['request.completed','request.failed'].includes(event.kind)) delete requests[event.requestId||'undefined'];
    const entry = { ...event, schema: 1, sequence, recordedAt: Date.now(),
      ...(journalFailure ? {previousWriteError:journalFailure,note:'После ошибки записи возможен пропуск событий; автоматические отправки при ошибке записи блокируются'} : {}),
      operationId, automatic: event.kind.startsWith('request.') ? Boolean(operationId) : event.automatic,
      version: chrome.runtime.getManifest().version, tabId,
      windowId: tab.windowId ?? null, title: event.title || tab.title || '',
      sourceUrl:requestSource || sourceUrl, sourceChatId:journalChatId(requestSource || sourceUrl), targetUrl, targetChatId: journalChatId(targetUrl),
      observedTabUrl: tab.url || '', observedChatId: journalChatId(tab.url) };
    if (event.kind === 'tab.closed') delete tabs[tabKey];
    const retryDraftByChat=reduceRetryDraft(meta.retryDraftByChat,entry);
    await chrome.storage.local.set({ [`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`]: entry,
      [JOURNAL_META]: { ...meta, sequence, active, requests, tabs, lastAt: entry.recordedAt,
        retryByChat: reduceRetrySummary(meta.retryByChat || {}, entry),retryDraftByChat,
        retryDraftClaims:event.kind==='draft.restore_intent'?{...meta.retryDraftClaims,[operationId||'']:sequence}:meta.retryDraftClaims } });
    journalFailure = '';
    return { ok: true as const, sequence, sourceUrl:entry.sourceUrl,
      ...(event.kind==='draft.restore_intent'?{record:{...retryDraftByChat[retryDraftUrl(entry.sourceUrl)||''],draft:claimedDraft!.draft}}:{}) };
  });
  journalQueue = write;
  return write.catch((error: unknown) => { if (!journalObject(error)||error.journalPolicy!==true) {journalFailure = journalMessage(error); console.error('Journal write failed', journalFailure);} throw error; });
}
function readRetryDraft(url: string): Promise<(RetryDraft & {draft:string}) | null> {
  const read=journalQueue.catch(()=>{}).then(async()=>{
    const meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    return indexedRetryDraft(meta ? journalMeta(meta) : null,url);
  });
  journalQueue=read;
  return read;
}
async function claimRetryDraft(url: string,operationId: string,savedSequence: number,tab: JournalTab={}) {
  const sourceUrl=retryDraftUrl(url);
  if(!sourceUrl)return {ok:false,claimed:false};
  try {
    const result=await appendJournal({kind:'draft.restore_intent',sourceUrl,operationId,savedSequence},tab);
    return {ok:true,claimed:true,record:result.record};
  } catch(error) {
    return {ok:false,claimed:false,error:journalMessage(error)};
  }
}
async function readRetryState(url: string): Promise<RetrySummary | null> {
  // A first read after upgrading may precede initializeJournal's append. Put
  // migration on the same queue so it cannot overwrite a concurrently logged error.
  const read = journalQueue.catch(() => {}).then(async () => {
    const saved = (await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    if (!saved) return null;
    const current=journalMeta(saved);
    const meta = await retryMetadata(current);
    if (current.retrySchema !== 1) await chrome.storage.local.set({[JOURNAL_META]: meta});
    const chatId = journalChatId(url);
    const state = chatId && Object.hasOwn(meta.retryByChat || {}, chatId) ? meta.retryByChat[chatId] : null;
    if (!state) return null;
    const now = Date.now();
    return {...state, failures: (state.failures || []).filter((at: number) => Number.isFinite(at) && at <= now && now - at <= RETRY_STATE_WINDOW_MS),
      recentErrors: (state.recentErrors || []).filter((item: RetryError) => Number.isFinite(item.at) && item.at <= now && now - item.at <= RETRY_STATE_WINDOW_MS)};
  });
  journalQueue = read;
  return read;
}
function journalInBackground(event: JournalEvent, tab?: JournalTab): void { void appendJournal(event, tab).catch(() => {}); }
function journalRequest(kind: string, details: {tabId:number;requestId:string;timeStamp:number;documentUrl?:string;initiator?:string;statusCode?:number;error?:string}) {
  // Queue immediately, preserving request order; documentUrl is the URL at send time.
  return appendJournal({kind, tabId:details.tabId, requestId:details.requestId, attemptId:String(details.timeStamp),
    eventAt:details.timeStamp, sourceUrl:details.documentUrl || details.initiator || '',
    statusCode:details.statusCode, error:details.error});
}
async function readJournal() {
  await journalQueue.catch(() => {});
  const values = await chrome.storage.local.get(null);
  return { ok: true, schema: 1, exportedAt: Date.now(), meta: values[JOURNAL_META] || null,
    storageError: journalFailure,
    events: Object.entries(values).filter(([key]) => key.startsWith(JOURNAL_PREFIX)).map(([, value]) => value).sort((a,b) => {
      const number=(value: unknown): number=>journalObject(value)&&typeof value.sequence==='number'?value.sequence:0;
      return number(a)-number(b);
    }) };
}
async function initializeJournal(reason: string) {
  const meta = (await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
  if (!meta) {
    await appendJournal({ kind: 'journal.started', reason, note: 'С этого момента ведётся журнал. Прошлые автоповторы восстановить нельзя.' });
    const saved = await chrome.storage.local.get(null);
    for (const [key, record] of Object.entries(saved)) {
      if (/^chatgpt-handoff:\d+$/.test(key) && journalObject(record) && typeof record.id==='string') {
        await appendJournal({ kind: 'handoff.imported', operationId: record.id, sourceUrl: typeof record.sourceUrl==='string'?record.sourceUrl:undefined,
          targetUrl: typeof record.targetUrl==='string'?record.targetUrl:undefined, stage: record.stage,
          originalCreatedAt: typeof record.createdAt==='number'?record.createdAt:undefined,
          text: typeof record.text==='string'?record.text:undefined,
          prompt: typeof record.prompt==='string'?record.prompt:undefined,
          asFile: record.asFile, reason: typeof record.reason==='string'?record.reason:undefined,
          provenance: 'Сохранённое состояние до начала журнала; это не запись наблюдения отправки' }, { id: Number(key.split(':')[1]) });
      }
    }
  }
  await appendJournal({ kind: 'extension.started', reason });
}
