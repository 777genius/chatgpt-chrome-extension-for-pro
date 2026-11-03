"use strict";

// The service worker owns the immutable, append-only journal. Every event
// advances one queue and is persisted atomically with its sequence metadata.
// Unknown outcomes never grant a second automatic send.
interface RetryDraft {
  operationId?: string;
  sourceUrl?: string;
  savedSequence?: number;
  attemptId?:string;
  phase?: string;
  claimedAt?: number;
  claimSequence?: number;
  replacementProven?: boolean;
  stopProven?: boolean;
}
interface RetryError { at: number; promptKey: string; attemptId: string }
interface RetrySummary {
  failures?: number[];
  recentErrors?: RetryError[];
  blocked?: boolean;
  terminal?: boolean;
  reason?: string;
  lastPromptKey?: string;
  lastAttemptId?: string;
  remainingRetries?: number;
  lastBudgetOperation?: string | null;
  manualStartedAt?:number;
  blockedAttemptId?:string;
  terminalAttemptId?:string;
  budgetGrantedAt?:number;
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
  sourceUrl?: string | null;
  promptKey?: string;
  goalId?: string | null;
  chatUrl?: string | null;
  attemptId?:string;
}
interface RetrySendClaim {
  operationId: string;
  tabId: number | null;
  at: number;
  phase: "reserved" | "consumed";
}
interface RetryPreparing {
  operationId: string;
  tabId: number | null;
  claimKey: string;
  attemptId?:string;
}
interface HandoffSourceClaim { operationId: string; tabId: number | null; at: number }
interface RetryIntent { sourceUrl: string; promptKey: string; tabId: number | null }
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
  handoffSourceClaimSchema?: number;
  retrySendClaimSchema?: number;
  handoffSourceClaims?: Record<string, HandoffSourceClaim>;
  retrySendClaims?: Record<string, RetrySendClaim>;
  retryConsumedOperations?: Record<string, number>;
  retryReleasedOperations?:Record<string,number>;
  retryPreparingByChat?: Record<string, RetryPreparing>;
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
  startedAt?:number;
  promptKey?: string;
  confirmed?: boolean;
  goalId?: string;
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
  ok: boolean;
  duplicate?:boolean;
  superseded?:boolean;
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
function retryAttemptAtOrAfter(value:unknown,startedAt:number|undefined):boolean {
  const attempt=Number(value);
  return typeof startedAt==='number'&&Number.isFinite(startedAt)&&startedAt>0&&
    Number.isFinite(attempt)&&attempt>=startedAt;
}
function retryAttemptBefore(value:unknown,startedAt:number|undefined):boolean {
  const attempt=Number(value);
  return typeof startedAt==='number'&&Number.isFinite(startedAt)&&startedAt>0&&
    Number.isFinite(attempt)&&attempt>0&&attempt<startedAt;
}
function retryDraftMetadata(meta: JournalMeta): JournalMeta {
  // Historical backups remain in the immutable journal. They lack a durable
  // restoration claim, so importing them could insert an already-used draft.
  return meta.retryDraftSchema===1?meta:{...meta,retryDraftSchema:1,retryDraftByChat:{},retryDraftClaims:{}};
}
function reduceRetryDraft(drafts: Record<string,RetryDraft>,event: JournalEvent,manualStartedAt?:number): Record<string,RetryDraft> {
  if(retryAttemptBefore(event.attemptId,manualStartedAt))return drafts;
  const url=retryDraftUrl(event.sourceUrl||event.observedTabUrl||event.url);
  if(!url)return drafts;
  const current=drafts[url],operationId=event.operationId;
  if(event.kind==='draft.saved'&&operationId&&typeof event.draft==='string'&&event.draft) {
    if(current?.operationId===operationId&&(current.claimedAt||current.phase==='superseded'))return drafts;
    const previous=current?.operationId===operationId?current:{};
    return {...drafts,[url]:{...previous,operationId,sourceUrl:url,
      savedSequence:event.sequence,attemptId:event.attemptId||previous.attemptId||'',phase:previous.phase||'saved'}};
  }
  if(!current||(operationId&&operationId!==current.operationId))return drafts;
  if(current.phase==='superseded')return drafts;
  if(event.kind==='draft.replaced')return {...drafts,[url]:{...current,replacementProven:true}};
  if(event.kind==='recovery.stop_result'&&event.stopped===true)return {...drafts,[url]:{...current,stopProven:true}};
  let phase=current.phase;
  if(event.kind==='retry.send_intent')phase='intent';
  if(['send.authorized','send.dispatched','draft.restore_deferred'].includes(event.kind))phase='unknown';
  if(event.kind==='retry.confirmed')phase='confirmed';
  if(event.kind==='send.not_clicked'||event.kind==='retry.cancelled'||event.kind==='retry.failed'&&event.clicked===false)phase='not-clicked';
  if(event.kind==='retry.manual_reset')phase='superseded';
  if(event.kind==='retry.preparation_superseded'&&!retryAttemptAtOrAfter(current.attemptId,event.startedAt))phase='superseded';
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
  if(event.kind==='retry.preparation_superseded') {
    if(typeof event.startedAt!=='number'||!Number.isFinite(event.startedAt))return retryByChat;
    const previous:RetrySummary=retryByChat[chatId]||{};
    const manualStartedAt=Math.max(previous.manualStartedAt||0,event.startedAt);
    const keepErrors=retryAttemptAtOrAfter(previous.lastAttemptId,manualStartedAt);
    const keepBlock=Boolean(previous.blocked)&&retryAttemptAtOrAfter(previous.blockedAttemptId,manualStartedAt);
    const keepTerminal=Boolean(previous.terminal)&&retryAttemptAtOrAfter(previous.terminalAttemptId,manualStartedAt);
    const keepBudget=typeof previous.budgetGrantedAt==='number'&&Number.isFinite(previous.budgetGrantedAt)&&previous.budgetGrantedAt>=manualStartedAt;
    if(!keepErrors&&!keepBlock&&!keepTerminal&&!keepBudget)
      return {...retryByChat,[chatId]:{manualStartedAt}};
    const state:RetrySummary={...previous,manualStartedAt,blocked:keepBlock,terminal:keepTerminal,
      reason:keepBlock?previous.reason:'',lastPromptKey:keepErrors?previous.lastPromptKey:'',
      lastAttemptId:keepErrors?previous.lastAttemptId:'',
      failures:(previous.failures||[]).filter(at=>at>=manualStartedAt),
      recentErrors:(previous.recentErrors||[]).filter(item=>item.at>=manualStartedAt)};
    if(!keepBudget){delete state.remainingRetries;delete state.lastBudgetOperation;delete state.budgetGrantedAt;}
    if(!keepBlock)delete state.blockedAttemptId;
    if(!keepTerminal)delete state.terminalAttemptId;
    return {...retryByChat,[chatId]:state};
  }
  if (event.kind === 'retry.manual_reset') {
    const next = {...retryByChat};
    delete next[chatId];
    return next;
  }
  if(retryAttemptBefore(event.attemptId,retryByChat[chatId]?.manualStartedAt))return retryByChat;
  if(event.kind==='retry.resume' && typeof event.remainingRetries==='number' && Number.isInteger(event.remainingRetries) && event.remainingRetries>=1 && event.remainingRetries<=3) {
    return {...retryByChat,[chatId]:{failures:[],recentErrors:[],blocked:false,terminal:false,reason:'',
      lastPromptKey:'',lastAttemptId:'',remainingRetries:event.remainingRetries,budgetGrantedAt:event.recordedAt,
      ...(retryByChat[chatId]?.manualStartedAt?{manualStartedAt:retryByChat[chatId]!.manualStartedAt}:{})}};
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
    state.blockedAttemptId=String(event.attemptId||previous.lastAttemptId||'');
    state.reason = String(event.reason || event.error || previous.reason || 'Автопродолжение остановлено');
    state.terminal = Boolean(previous.terminal || event.terminal === true);
    if(event.terminal===true)state.terminalAttemptId=state.blockedAttemptId;
  }
  return {...retryByChat, [chatId]: state};
}
async function retryMetadata(meta: JournalMeta): Promise<JournalMeta> {
  if (meta.retrySchema === 1&&meta.handoffSourceClaimSchema===1&&meta.retrySendClaimSchema===1) return meta;
  const replayRetries=meta.retrySchema!==1;
  const replaySends=meta.retrySendClaimSchema!==1;
  let retryByChat: Record<string, RetrySummary> = replayRetries?{}:meta.retryByChat||{};
  const handoffSourceClaims: Record<string, HandoffSourceClaim>={...meta.handoffSourceClaims};
  const retrySendClaims: Record<string, RetrySendClaim>={...meta.retrySendClaims};
  const retryConsumedOperations: Record<string, number>={...meta.retryConsumedOperations};
  const retryIntents=new Map<string, RetryIntent>();
  // Replay the immutable journal in bounded batches without loading user payloads wholesale.
  for (let first=1;first<=meta.sequence;first+=RETRY_MIGRATION_BATCH_SIZE) {
    const keys: string[]=[];
    for(let sequence=first;sequence<=Math.min(meta.sequence,first+RETRY_MIGRATION_BATCH_SIZE-1);sequence++) {
      keys.push(`${JOURNAL_PREFIX}${String(sequence).padStart(12,'0')}`);
    }
    const batch=await chrome.storage.local.get(keys);
    for(const key of keys) {
      const event=journalEvent(batch[key]);
      if(!event)continue;
      if(replayRetries)retryByChat=reduceRetrySummary(retryByChat,event);
      if(meta.handoffSourceClaimSchema!==1&&event.operationId) {
        const source=retryDraftUrl(event.sourceUrl);
        if(source&&['handoff.navigating','handoff.imported'].includes(event.kind)&&
            !Object.hasOwn(handoffSourceClaims,source))handoffSourceClaims[source]={
          operationId:event.operationId,tabId:event.tabId??null,at:event.recordedAt??0,
        };
        if(source&&event.kind==='handoff.pre_navigation_cancelled'&&
            handoffSourceClaims[source]?.operationId===event.operationId&&
            handoffSourceClaims[source]?.tabId===event.tabId)delete handoffSourceClaims[source];
      }
      if(replaySends&&event.operationId) {
        const source=retryDraftUrl(event.sourceUrl);
        if(['retry.planned','retry.send_intent'].includes(event.kind)&&source&&typeof event.promptKey==='string'&&event.promptKey) {
          retryIntents.set(event.operationId,{sourceUrl:source,promptKey:event.promptKey,tabId:event.tabId??null});
        }
        const intent=retryIntents.get(event.operationId);
        if(intent&&intent.tabId===event.tabId) {
          const claim=JSON.stringify([intent.sourceUrl,intent.promptKey]);
          if(event.kind==='send.authorized'&&source===intent.sourceUrl) {
            retrySendClaims[claim]={operationId:event.operationId,tabId:event.tabId??null,at:event.recordedAt??0,phase:'consumed'};
            if(typeof event.sequence==='number')retryConsumedOperations[event.operationId]=event.sequence;
          }
          if(source===intent.sourceUrl&&(event.kind==='send.not_clicked'||event.kind==='retry.failed'&&event.clicked===false)&&
              retrySendClaims[claim]?.operationId===event.operationId&&retrySendClaims[claim]?.tabId===event.tabId)delete retrySendClaims[claim];
        }
      }
    }
  }
  return {...meta,retrySchema:1,retryByChat,handoffSourceClaims,handoffSourceClaimSchema:1,
    retrySendClaims,retryConsumedOperations,retrySendClaimSchema:1};
}
function appendJournal(event: JournalEvent, tab: JournalTab = {}): Promise<JournalResult> {
  const write = journalQueue.catch(() => {}).then(async () => {
    const savedMeta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    const initial:JournalMeta=savedMeta?journalMeta(savedMeta):{sequence:0,startedAt:Date.now(),retryByChat:{},retryDraftByChat:{},retryDraftClaims:{}};
    const meta = retryDraftMetadata(await retryMetadata(initial));
    // Persist migration before evaluating a potentially rejected send.
    if(savedMeta&&(initial.retrySchema!==1||initial.handoffSourceClaimSchema!==1||
        initial.retrySendClaimSchema!==1))await chrome.storage.local.set({[JOURNAL_META]:meta});
    const sequence = meta.sequence + 1;
    const tabId = tab.id ?? event.tabId ?? null;
    const tabKey=String(tabId);
    const tabs:Record<string,JournalTab> = {...meta.tabs};
    tab = {...tabs[tabKey],...tab};
    if (tab.id != null && tab.url) tabs[tab.id] = {id:tab.id,url:tab.url,title:tab.title,windowId:tab.windowId};
    const sourceUrl = event.sourceUrl && event.sourceUrl !== 'https://chatgpt.com' ? event.sourceUrl : tab.url || event.sourceUrl || event.url || '';
    const targetUrl = event.targetUrl || '';
    const active:Record<string,ActiveJournalOp> = { ...meta.active };
    const retrySendClaims: Record<string,RetrySendClaim> = { ...meta.retrySendClaims };
    const retryConsumedOperations: Record<string,number> = { ...meta.retryConsumedOperations };
    const retryReleasedOperations:Record<string,number>={...meta.retryReleasedOperations};
    const retryPreparingByChat: Record<string,RetryPreparing> = { ...meta.retryPreparingByChat };
    const handoffSourceClaims: Record<string,HandoffSourceClaim> = { ...meta.handoffSourceClaims };
    const requests:Record<string,JournalRequestOp> = { ...meta.requests };
    let operationId: string | null = event.operationId || null;
    const savedDraft=meta.retryDraftByChat[retryDraftUrl(sourceUrl)||''];
    const retrySource=retryDraftUrl(sourceUrl);
    const manualFence=meta.retryByChat?.[journalChatId(retrySource)||'']?.manualStartedAt;
    const superseded=retryAttemptBefore(event.attemptId,manualFence);
    const staleDraftSave=event.kind==='draft.saved'&&
      (superseded||Boolean(operationId&&Object.hasOwn(retryReleasedOperations,operationId)));
    const owns=(claim: RetrySendClaim | RetryPreparing | HandoffSourceClaim | undefined): boolean =>
      claim?.operationId===operationId&&claim.tabId===tabId;
    const duplicate=()=>Object.assign(new Error('Автоповтор этого запроса уже запускался в другой вкладке или ранее'),
      {journalPolicy:true,code:'RETRY_DUPLICATE'});
    function reserveRetry(): void {
      if(!retrySource||!operationId||typeof event.promptKey!=='string'||!event.promptKey)return;
      if(retryAttemptBefore(event.attemptId,manualFence))throw duplicate();
      if(Object.hasOwn(retryConsumedOperations,operationId)||
          Object.hasOwn(retryReleasedOperations,operationId))throw duplicate();
      if(meta.retryDraftClaims?.[operationId])return;
      const key=JSON.stringify([retrySource,event.promptKey]);
      const claim=retrySendClaims[key],preparing=retryPreparingByChat[retrySource];
      if(claim&&(!owns(claim)||claim.phase!=='reserved')||preparing&&!owns(preparing))throw duplicate();
      retrySendClaims[key]={operationId,tabId,at:claim?.at||Date.now(),phase:'reserved'};
      retryPreparingByChat[retrySource]={operationId,tabId,claimKey:key,attemptId:event.attemptId||preparing?.attemptId||''};
    }
    if(event.kind==='goal.started'&&retrySource&&(
        retryPreparingByChat[retrySource]||
        Object.entries(active).some(([owner,entry])=>Boolean(entry)&&
          (entry.chatUrl||entry.sourceUrl||retryDraftUrl(meta.tabs?.[owner]?.url))===retrySource)))
      throw Object.assign(new Error('В этом чате уже готовится или выполняется автоматическая отправка'),{journalPolicy:true});
    if(['retry.planned','retry.send_intent'].includes(event.kind)&&retrySource){
      const goal=(await chrome.storage.local.get('chatgpt-goal:'+retrySource))['chatgpt-goal:'+retrySource];
      if(journalObject(goal)&&goal.operation&&typeof goal.phase==='string'&&
          ['preparing','sending','clicked','blocked','stopped'].includes(goal.phase))throw duplicate();
    }
    // A legacy/unbound retry intent never authorizes a click. Reject it
    // before recording an active tab/chat send fence; otherwise a malformed
    // intent could permanently block a later correctly bound operation.
    if(event.kind==='retry.send_intent'&&(!retrySource||!operationId||
        typeof event.promptKey!=='string'||!event.promptKey))
      throw Object.assign(new Error('Исходный пользовательский запрос автоповтора не подтверждён'),{journalPolicy:true});
    if(event.kind==='retry.planned'||event.kind==='retry.send_intent')reserveRetry();
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
    if (['retry.send_intent','handoff.sending','goal.send_intent'].includes(event.kind)) {
      const chatUrl=retryDraftUrl(event.kind==='handoff.sending'?(event.targetUrl||tab.url):sourceUrl);
      if(event.kind==='goal.send_intent'&&chatUrl&&retryPreparingByChat[chatUrl])
        throw Object.assign(new Error('В чате уже подготавливается восстановление ошибки; Goal не может параллельно отправлять'),{journalPolicy:true});
      if(chatUrl&&event.kind==='handoff.sending'){
        const goal=(await chrome.storage.local.get('chatgpt-goal:'+chatUrl))['chatgpt-goal:'+chatUrl];
        if(journalObject(goal)&&goal.operation&&typeof goal.phase==='string'&&
            ['preparing','sending','clicked','blocked','stopped'].includes(goal.phase))
          throw Object.assign(new Error('Цель удерживает незавершённую отправку в этом чате'),{journalPolicy:true});
      }
      if(active[tabKey] || (chatUrl && Object.entries(active).some(([owner,entry])=>
          Number(owner)!==tabId && Boolean(entry) &&
          (entry.chatUrl||retryDraftUrl(meta.tabs?.[owner]?.url))===chatUrl)))
        throw Object.assign(new Error('В чате уже имеется незавершённая автоматическая отправка'),{journalPolicy:true});
      active[tabKey]={operationId,kind:event.kind,goalId:event.goalId||null,chatUrl,at:Date.now(),
        ...(event.kind==='retry.send_intent'?{sourceUrl:retrySource,promptKey:event.promptKey,attemptId:event.attemptId||''}:{})};
    }
    if(['handoff.navigating','handoff.imported','handoff.pre_navigation_cancelled'].includes(event.kind)) {
      const source=retryDraftUrl(sourceUrl),claim=source?handoffSourceClaims[source]:undefined;
      if(event.kind==='handoff.navigating'&&(!source||!operationId||claim))
        throw Object.assign(new Error('Передача этого чата уже запускалась'),{journalPolicy:true});
      if(source&&event.kind==='handoff.pre_navigation_cancelled'){
        if(!claim||claim.operationId!==operationId||claim.tabId!==tabId)
          throw Object.assign(new Error('Нельзя снять запрет другой передачи'),{journalPolicy:true});
        delete handoffSourceClaims[source];
      }else if(source&&operationId&&!claim){
        handoffSourceClaims[source]={operationId,tabId,at:Date.now()};
      }
    }
    if (event.kind === 'send.authorized') {
      if(operationId&&meta.retryDraftClaims?.[operationId])throw Object.assign(new Error('Черновик уже передан на восстановление; отправка отменена'),{journalPolicy:true});
      const activeSend=active[tabKey];
      if (!activeSend||activeSend.operationId!==operationId||activeSend.consumed)
        throw Object.assign(new Error('Повторная автоматическая отправка запрещена'),{journalPolicy:true});
      if(activeSend.kind==='retry.send_intent') {
        const intent=activeSend;
        if(!intent.sourceUrl||intent.sourceUrl!==retryDraftUrl(sourceUrl)||typeof intent.promptKey!=='string'||!intent.promptKey)
          throw Object.assign(new Error('Исходный запрос автоповтора не подтверждён'),{journalPolicy:true});
        const claim=JSON.stringify([intent.sourceUrl,intent.promptKey]);
        if(!owns(retrySendClaims[claim])||retrySendClaims[claim]?.phase!=='reserved'||!owns(retryPreparingByChat[intent.sourceUrl]))
          throw duplicate();
        retrySendClaims[claim]={...retrySendClaims[claim]!,phase:'consumed'};
        if(operationId)retryConsumedOperations[operationId]=sequence;
      }
      active[tabKey]={...activeSend,consumed:true};
    }
    if(event.kind==='send.not_clicked') {
      const claim=JSON.stringify([retryDraftUrl(sourceUrl),event.promptKey]);
      if(retrySendClaims[claim]?.operationId===operationId&&retrySendClaims[claim]?.tabId===tabId)delete retrySendClaims[claim];
    }
    const preparation=retrySource?retryPreparingByChat[retrySource]:undefined;
    const ownSavedDraft=savedDraft?.operationId===operationId;
    const releasePreparation=preparation&&(owns(preparation)||event.kind==='draft.restore_intent'&&preparation.operationId===operationId)&&(
      event.kind==='draft.restore_intent'||
      event.kind==='retry.finished'&&(!event.clicked||event.confirmed||!ownSavedDraft||savedDraft?.claimedAt)||
      event.kind==='retry.confirmed'&&!ownSavedDraft||
      ['retry.cancelled','retry.failed'].includes(event.kind)&&!ownSavedDraft&&retrySendClaims[preparation.claimKey]?.phase==='reserved');
    if(releasePreparation&&preparation&&retrySource) {
      if(retrySendClaims[preparation.claimKey]?.phase==='reserved')delete retrySendClaims[preparation.claimKey];
      delete retryPreparingByChat[retrySource];
    }
    if(event.kind==='retry.preparation_superseded'&&preparation&&retrySource&&
        !retryAttemptAtOrAfter(preparation.attemptId,event.startedAt)) {
      retryReleasedOperations[preparation.operationId]=sequence;
      if(retrySendClaims[preparation.claimKey]?.phase==='reserved')
        delete retrySendClaims[preparation.claimKey];
      delete retryPreparingByChat[retrySource];
    }
    if(savedDraft?.operationId&&(event.kind==='retry.manual_reset'||
        event.kind==='retry.preparation_superseded'&&
        !retryAttemptAtOrAfter(savedDraft.attemptId,event.startedAt)))
      retryReleasedOperations[savedDraft.operationId]=sequence;
    if(event.kind==='retry.preparation_superseded') {
      // Retire only older retries with proven timestamps. Unknown click
      // outcomes remain consumed, never silently authorize another send.
      for(const [owner,entry] of Object.entries(active)) {
        const attempt=entry?.attemptId||
          (preparation?.operationId===entry?.operationId?preparation.attemptId:'');
        if(entry?.kind==='retry.send_intent'&&
            (entry.chatUrl||entry.sourceUrl||retryDraftUrl(meta.tabs?.[owner]?.url))===retrySource&&
            retryAttemptBefore(attempt,event.startedAt)) {
          if(entry.operationId)retryReleasedOperations[entry.operationId]=sequence;
          delete active[owner];
        }
      }
    }
    const currentSend=active[tabKey];
    const exactGrant=Boolean(currentSend&&operationId&&currentSend.operationId===operationId);
    const resetRetry=event.kind==='retry.manual_reset'&&currentSend?.kind==='retry.send_intent';
    const clearsGoal=exactGrant&&currentSend?.kind==='goal.send_intent'&&event.kind==='goal.confirmed';
    const clearsRetry=(exactGrant||resetRetry)&&currentSend?.kind==='retry.send_intent'&&
      ['retry.confirmed','retry.failed','retry.cancelled','retry.manual_reset'].includes(event.kind);
    const clearsHandoff=exactGrant&&currentSend?.kind==='handoff.sending'&&
      ['handoff.sent','handoff.failed'].includes(event.kind);
    if((event.kind==='tab.closed'&&currentSend?.kind!=='goal.send_intent')||
        clearsGoal||clearsRetry||clearsHandoff)delete active[tabKey];
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
    const retryDraftByChat=staleDraftSave?meta.retryDraftByChat:
      reduceRetryDraft(meta.retryDraftByChat,entry,
        meta.retryByChat?.[journalChatId(entry.sourceUrl)||'']?.manualStartedAt);
    await chrome.storage.local.set({ [`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`]: entry,
      [JOURNAL_META]: { ...meta, sequence, active, retrySendClaims, retryConsumedOperations, retryReleasedOperations, retryPreparingByChat, handoffSourceClaims, requests, tabs, lastAt: entry.recordedAt,
        retryByChat: reduceRetrySummary(meta.retryByChat || {}, entry),retryDraftByChat,
        retryDraftClaims:event.kind==='draft.restore_intent'?{...meta.retryDraftClaims,[operationId||'']:sequence}:meta.retryDraftClaims } });
    journalFailure = '';
    return {ok:!staleDraftSave,...(staleDraftSave?{duplicate:true}:{}),
      ...(superseded?{superseded:true}:{}),sequence,sourceUrl:entry.sourceUrl,
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
    if (current.retrySchema !== 1||current.handoffSourceClaimSchema!==1||current.retrySendClaimSchema!==1) await chrome.storage.local.set({[JOURNAL_META]: meta});
    const chatId = journalChatId(url);
    const state = chatId && Object.hasOwn(meta.retryByChat || {}, chatId) ? meta.retryByChat[chatId] : null;
    if (!state) return null;
    if(Object.keys(state).length===1&&typeof state.manualStartedAt==='number'&&
        Number.isFinite(state.manualStartedAt))return null;
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
