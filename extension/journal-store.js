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
function retryDraftUrl(value) {
  try { const url=new URL(value); return url.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)?`${url.origin}${url.pathname.replace(/\/$/,'')}`:null; }
  catch { return null; }
}
function retryDraftMetadata(meta) {
  // Historical backups remain in the immutable journal. They lack a durable
  // restoration claim, so importing them could insert an already-used draft.
  return meta.retryDraftSchema===1?meta:{...meta,retryDraftSchema:1,retryDraftByChat:{},retryDraftClaims:{}};
}
function reduceRetryDraft(drafts,event) {
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
  if(event.kind==='send.not_clicked'||event.kind==='retry.cancelled'||event.kind==='retry.failed'&&event.clicked===false)phase='not-clicked';
  if(event.kind==='retry.manual_reset')phase='superseded';
  if(event.kind==='draft.restored')phase='restored';
  if(event.kind==='draft.restore_intent')return {...drafts,[url]:{...current,phase:'claimed',claimedAt:event.recordedAt,claimSequence:event.sequence}};
  return phase===current.phase?drafts:{...drafts,[url]:{...current,phase}};
}
function retryDraftClaimable(record) {
  return Boolean(record&&!record.claimedAt&&['saved','intent','not-clicked','confirmed'].includes(record.phase));
}
async function indexedRetryDraft(meta,url) {
  const record=meta?.retryDraftSchema===1?meta.retryDraftByChat?.[retryDraftUrl(url)]:null;
  if(!record||!Number.isInteger(record.savedSequence)||record.savedSequence<1)return null;
  const key=`${JOURNAL_PREFIX}${String(record.savedSequence).padStart(12,'0')}`;
  const entry=(await chrome.storage.local.get(key))[key];
  return entry?.kind==='draft.saved'&&entry.operationId===record.operationId&&retryDraftUrl(entry.sourceUrl)===record.sourceUrl&&
    typeof entry.draft==='string'&&entry.draft?{...record,draft:entry.draft}:null;
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
  if (meta.retrySchema === 1&&meta.handoffSourceClaimSchema===1&&meta.retrySendClaimSchema===1) return meta;
  const replayRetries=meta.retrySchema!==1;
  const replaySends=meta.retrySendClaimSchema!==1;
  let retryByChat = replayRetries?{}:meta.retryByChat||{};
  const handoffSourceClaims={...meta.handoffSourceClaims};
  const retrySendClaims={...meta.retrySendClaims},retryConsumedOperations={...meta.retryConsumedOperations};
  const retryIntents=new Map();
  // Replay existing immutable events in sequence, without loading full history
  // (handoff payloads may be large) or racing the serialized journal writer.
  for (let first = 1; first <= meta.sequence; first += RETRY_MIGRATION_BATCH_SIZE) {
    const keys = [];
    for (let sequence = first; sequence <= Math.min(meta.sequence, first + RETRY_MIGRATION_BATCH_SIZE - 1); sequence += 1) {
      keys.push(`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`);
    }
    const batch = await chrome.storage.local.get(keys);
    for (const key of keys) if (batch[key]) {
      const event=batch[key];
      if(replayRetries)retryByChat = reduceRetrySummary(retryByChat,event);
      if(meta.handoffSourceClaimSchema!==1&&['handoff.navigating','handoff.imported'].includes(event.kind)&&event.operationId) {
        const source=retryDraftUrl(event.sourceUrl);
        if(source&&!Object.hasOwn(handoffSourceClaims,source))handoffSourceClaims[source]={operationId:event.operationId,tabId:event.tabId,at:event.recordedAt};
      }
      if(replaySends&&event.operationId) {
        const source=retryDraftUrl(event.sourceUrl);
        if(['retry.planned','retry.send_intent'].includes(event.kind)&&source&&typeof event.promptKey==='string'&&event.promptKey) {
          retryIntents.set(event.operationId,{sourceUrl:source,promptKey:event.promptKey,tabId:event.tabId});
        }
        const intent=retryIntents.get(event.operationId);
        if(intent&&intent.tabId===event.tabId) {
          const claim=JSON.stringify([intent.sourceUrl,intent.promptKey]);
          if(event.kind==='send.authorized'&&source===intent.sourceUrl) {
            retrySendClaims[claim]={operationId:event.operationId,tabId:event.tabId,at:event.recordedAt,phase:'consumed'};
            retryConsumedOperations[event.operationId]=event.sequence;
          }
          if(source===intent.sourceUrl&&(event.kind==='send.not_clicked'||event.kind==='retry.failed'&&event.clicked===false)&&
              retrySendClaims[claim]?.operationId===event.operationId&&retrySendClaims[claim].tabId===event.tabId)delete retrySendClaims[claim];
        }
      }
    }
  }
  return {...meta, retrySchema: 1, retryByChat,handoffSourceClaims,handoffSourceClaimSchema:1,
    retrySendClaims,retryConsumedOperations,retrySendClaimSchema:1};
}
function appendJournal(event, tab = {}) {
  const write = journalQueue.catch(() => {}).then(async () => {
    const savedMeta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    const meta = retryDraftMetadata(await retryMetadata(savedMeta || { sequence: 0, startedAt: Date.now() }));
    // Save a legacy replay even if the requested operation is then refused.
    // This checkpoint changes metadata only, under the same serialized writer.
    if(savedMeta&&(savedMeta.retrySchema!==1||savedMeta.handoffSourceClaimSchema!==1||savedMeta.retrySendClaimSchema!==1))await chrome.storage.local.set({[JOURNAL_META]:meta});
    const sequence = meta.sequence + 1;
    const tabId = tab.id ?? event.tabId ?? null;
    const tabs = {...meta.tabs};
    tab = {...tabs[tabId],...tab};
    if (tab.id != null && tab.url) tabs[tab.id] = {id:tab.id,url:tab.url,title:tab.title,windowId:tab.windowId};
    const sourceUrl = event.sourceUrl && event.sourceUrl !== 'https://chatgpt.com' ? event.sourceUrl : tab.url || event.sourceUrl || event.url || '';
    const targetUrl = event.targetUrl || '';
    const active = { ...meta.active };
    const retrySendClaims = { ...meta.retrySendClaims };
    const retryConsumedOperations = { ...meta.retryConsumedOperations };
    const retryPreparingByChat = { ...meta.retryPreparingByChat };
    const handoffSourceClaims = { ...meta.handoffSourceClaims };
    const requests = { ...meta.requests };
    let operationId = event.operationId || null;
    const savedDraft=meta.retryDraftByChat[retryDraftUrl(sourceUrl)];
    const retrySource=retryDraftUrl(sourceUrl);
    const owns=claim=>claim?.operationId===operationId&&claim.tabId===tabId;
    const duplicate=()=>Object.assign(new Error('Автоповтор этого запроса уже запускался в другой вкладке или ранее'),{journalPolicy:true,code:'RETRY_DUPLICATE'});
    function reserveRetry() {
      // Unbound historical log entries remain readable, but cannot authorize a
      // send. Real retry.planned carries this binding before any editor effect.
      if(!retrySource||!operationId||typeof event.promptKey!=='string'||!event.promptKey)return;
      if(Object.hasOwn(retryConsumedOperations,operationId))throw duplicate();
      if(meta.retryDraftClaims?.[operationId])return;
      const key=JSON.stringify([retrySource,event.promptKey]);
      const claim=retrySendClaims[key],preparing=retryPreparingByChat[retrySource];
      if(claim&&(!owns(claim)||claim.phase!=='reserved')||preparing&&!owns(preparing))throw duplicate();
      retrySendClaims[key]={operationId,tabId,at:claim?.at||Date.now(),phase:'reserved'};
      retryPreparingByChat[retrySource]={operationId,tabId,claimKey:key};
    }
    if(event.kind==='retry.planned'||event.kind==='retry.send_intent')reserveRetry();
    if(event.kind==='draft.restore_intent'&&(!retryDraftClaimable(savedDraft)||savedDraft.operationId!==operationId||savedDraft.savedSequence!==event.savedSequence)) {
      throw Object.assign(new Error('Восстановление черновика уже выполнено или исход отправки неизвестен'),{journalPolicy:true});
    }
    const claimedDraft=event.kind==='draft.restore_intent'?await indexedRetryDraft(meta,sourceUrl):null;
    if(event.kind==='draft.restore_intent'&&!claimedDraft)throw Object.assign(new Error('Не найдена точная сохранённая копия черновика'),{journalPolicy:true});
    if (event.kind === 'tab.updated') operationId ||= active[tabId]?.operationId || null;
    if (event.kind === 'request.started') {
      operationId ||= Date.now() - (active[tabId]?.at || 0) < 120000 ? active[tabId]?.operationId || null : null;
      requests[event.requestId] = {operationId,sourceUrl};
    }
    if (['request.completed','request.failed'].includes(event.kind)) operationId ||= requests[event.requestId]?.operationId || null;
    if (['retry.send_intent','handoff.sending'].includes(event.kind)) active[tabId] = {operationId,kind:event.kind,at:Date.now(),
      ...(event.kind==='retry.send_intent'?{sourceUrl:retryDraftUrl(sourceUrl),promptKey:event.promptKey}: {})};
    if(['handoff.navigating','handoff.imported'].includes(event.kind)) {
      const source=retryDraftUrl(sourceUrl);
      if(event.kind==='handoff.navigating'&&(!source||!operationId||Object.hasOwn(handoffSourceClaims,source)))throw Object.assign(new Error('Передача этого чата уже запускалась'),{journalPolicy:true});
      // Import every recovery copy, while the first source claim prevents a
      // new navigation even when initialization already set the schema flag.
      if(source&&operationId&&!Object.hasOwn(handoffSourceClaims,source))handoffSourceClaims[source]={operationId,tabId,at:Date.now()};
    }
    if (event.kind === 'send.authorized') {
      if(meta.retryDraftClaims?.[operationId])throw Object.assign(new Error('Черновик уже передан на восстановление; отправка отменена'),{journalPolicy:true});
      if (!active[tabId] || active[tabId].operationId !== operationId || active[tabId].consumed) throw Object.assign(new Error('Повторная автоматическая отправка запрещена'),{journalPolicy:true});
      if(active[tabId].kind==='retry.send_intent') {
        const intent=active[tabId];
        if(!intent.sourceUrl||intent.sourceUrl!==retryDraftUrl(sourceUrl)||typeof intent.promptKey!=='string'||!intent.promptKey)throw Object.assign(new Error('Исходный запрос автоповтора не подтверждён'),{journalPolicy:true});
        const claim=JSON.stringify([intent.sourceUrl,intent.promptKey]);
        if(!owns(retrySendClaims[claim])||retrySendClaims[claim].phase!=='reserved'||!owns(retryPreparingByChat[intent.sourceUrl]))throw duplicate();
        // Keep the claim after failure/unknown and worker restart. A different
        // native user turn receives its own claim; tab IDs cannot duplicate it.
        retrySendClaims[claim]={...retrySendClaims[claim],phase:'consumed'};
        retryConsumedOperations[operationId]=sequence;
      }
      active[tabId] = {...active[tabId],consumed:true};
    }
    if(event.kind==='send.not_clicked') {
      const claim=JSON.stringify([retryDraftUrl(sourceUrl),event.promptKey]);
      if(retrySendClaims[claim]?.operationId===operationId&&retrySendClaims[claim].tabId===tabId)delete retrySendClaims[claim];
      // The old operation stays consumed: only a new intent may try again after
      // MAIN positively refused the click. Unknown/missing results never release.
    }
    const preparation=retryPreparingByChat[retrySource];
    const ownSavedDraft=savedDraft?.operationId===operationId;
    const releasePreparation=(owns(preparation)||event.kind==='draft.restore_intent'&&preparation?.operationId===operationId)&&(
      event.kind==='draft.restore_intent'||
      event.kind==='retry.finished'&&(!event.clicked||event.confirmed||!ownSavedDraft||savedDraft.claimedAt)||
      event.kind==='retry.confirmed'&&!ownSavedDraft||
      ['retry.cancelled','retry.failed'].includes(event.kind)&&!ownSavedDraft&&retrySendClaims[preparation.claimKey]?.phase==='reserved');
    if(releasePreparation) {
      if(retrySendClaims[preparation.claimKey]?.phase==='reserved')delete retrySendClaims[preparation.claimKey];
      delete retryPreparingByChat[retrySource];
    }
    if(event.kind==='retry.preparation_superseded'&&preparation) {
      if(retrySendClaims[preparation.claimKey]?.phase==='reserved')delete retrySendClaims[preparation.claimKey];
      delete retryPreparingByChat[retrySource];
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
    const retryDraftByChat=reduceRetryDraft(meta.retryDraftByChat,entry);
    await chrome.storage.local.set({ [`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`]: entry,
      [JOURNAL_META]: { ...meta, sequence, active, retrySendClaims, retryConsumedOperations, retryPreparingByChat, handoffSourceClaims, requests, tabs, lastAt: entry.recordedAt,
        retryByChat: reduceRetrySummary(meta.retryByChat || {}, entry),retryDraftByChat,
        retryDraftClaims:event.kind==='draft.restore_intent'?{...meta.retryDraftClaims,[operationId]:sequence}:meta.retryDraftClaims } });
    journalFailure = '';
    return { ok: true, sequence, sourceUrl:entry.sourceUrl,
      ...(event.kind==='draft.restore_intent'?{record:{...retryDraftByChat[retryDraftUrl(entry.sourceUrl)],draft:claimedDraft.draft}}:{}) };
  });
  journalQueue = write;
  return write.catch((error) => { if (!error.journalPolicy) {journalFailure = String(error?.message || error); console.error('Journal write failed', journalFailure);} throw error; });
}
function readRetryDraft(url) {
  const read=journalQueue.catch(()=>{}).then(async()=>{
    const meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    return indexedRetryDraft(meta,url);
  });
  journalQueue=read;
  return read;
}
async function claimRetryDraft(url,operationId,savedSequence,tab={}) {
  const sourceUrl=retryDraftUrl(url);
  if(!sourceUrl)return {ok:false,claimed:false};
  try {
    const result=await appendJournal({kind:'draft.restore_intent',sourceUrl,operationId,savedSequence},tab);
    return {ok:true,claimed:true,record:result.record};
  } catch(error) {
    return {ok:false,claimed:false,error:String(error.message||error)};
  }
}
async function readRetryState(url) {
  // A first read after upgrading may precede initializeJournal's append. Put
  // migration on the same queue so it cannot overwrite a concurrently logged error.
  const read = journalQueue.catch(() => {}).then(async () => {
    const saved = (await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    if (!saved) return null;
    const meta = await retryMetadata(saved);
    if (saved.retrySchema !== 1||saved.handoffSourceClaimSchema!==1||saved.retrySendClaimSchema!==1) await chrome.storage.local.set({[JOURNAL_META]: meta});
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
  return appendJournal({kind, tabId:details.tabId, requestId:details.requestId, attemptId:String(details.timeStamp),
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
