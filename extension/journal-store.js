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
function retryAttemptAtOrAfter(value,startedAt) {
  const attempt=Number(value);
  return Number.isFinite(startedAt)&&startedAt>0&&Number.isFinite(attempt)&&attempt>=startedAt;
}
function retryAttemptBefore(value,startedAt) {
  const attempt=Number(value);
  return Number.isFinite(startedAt)&&startedAt>0&&Number.isFinite(attempt)&&attempt>0&&attempt<startedAt;
}
function retryDraftMetadata(meta) {
  // Historical backups remain in the immutable journal. They lack a durable
  // restoration claim, so importing them could insert an already-used draft.
  return meta.retryDraftSchema===1?meta:{...meta,retryDraftSchema:1,retryDraftByChat:{},retryDraftClaims:{}};
}
function reduceRetryDraft(drafts,event,manualStartedAt) {
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
  if(event.kind==='retry.preparation_superseded') {
    const previous=retryByChat[chatId]||{};
    const manualStartedAt=Math.max(previous.manualStartedAt||0,event.startedAt);
    const keepErrors=retryAttemptAtOrAfter(previous.lastAttemptId,manualStartedAt);
    const keepBlock=previous.blocked&&retryAttemptAtOrAfter(previous.blockedAttemptId,manualStartedAt);
    const keepTerminal=previous.terminal&&retryAttemptAtOrAfter(previous.terminalAttemptId,manualStartedAt);
    const keepBudget=Number.isFinite(previous.budgetGrantedAt)&&previous.budgetGrantedAt>=manualStartedAt;
    // Keep the fence after the visible retry state is cleared: an old async
    // callback can arrive after this ACK or after a worker restart.
    if(!keepErrors&&!keepBlock&&!keepTerminal&&!keepBudget)return {...retryByChat,[chatId]:{manualStartedAt}};
    const state={...previous,manualStartedAt,blocked:Boolean(keepBlock),terminal:Boolean(keepTerminal),reason:keepBlock?previous.reason:'',
      lastPromptKey:keepErrors?previous.lastPromptKey:'',lastAttemptId:keepErrors?previous.lastAttemptId:'',
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
  if(event.kind==='retry.resume' && Number.isInteger(event.remainingRetries) && event.remainingRetries>=1 && event.remainingRetries<=3) {
    return {...retryByChat,[chatId]:{failures:[],recentErrors:[],blocked:false,terminal:false,reason:'',
      lastPromptKey:'',lastAttemptId:'',remainingRetries:event.remainingRetries,budgetGrantedAt:event.recordedAt,
      ...(retryByChat[chatId]?.manualStartedAt?{manualStartedAt:retryByChat[chatId].manualStartedAt}:{})}};
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
    state.blockedAttemptId=String(event.attemptId||previous.lastAttemptId||'');
    state.reason = String(event.reason || event.error || previous.reason || 'Автопродолжение остановлено');
    state.terminal = Boolean(previous.terminal || event.terminal === true);
    if(event.terminal===true)state.terminalAttemptId=state.blockedAttemptId;
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
      if(meta.handoffSourceClaimSchema!==1&&event.operationId) {
        const source=retryDraftUrl(event.sourceUrl);
        if(source&&['handoff.navigating','handoff.imported'].includes(event.kind)&&
            !Object.hasOwn(handoffSourceClaims,source))
          handoffSourceClaims[source]={operationId:event.operationId,tabId:event.tabId,at:event.recordedAt};
        // A proven pre-navigation failure can release only its own source
        // claim, even when replaying an immutable legacy journal after upgrade.
        if(source&&event.kind==='handoff.pre_navigation_cancelled'&&
            handoffSourceClaims[source]?.operationId===event.operationId&&
            handoffSourceClaims[source].tabId===event.tabId)delete handoffSourceClaims[source];
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
    const retryReleasedOperations = { ...meta.retryReleasedOperations };
    const retryPreparingByChat = { ...meta.retryPreparingByChat };
    const handoffSourceClaims = { ...meta.handoffSourceClaims };
    const requests = { ...meta.requests };
    let operationId = event.operationId || null;
    const savedDraft=meta.retryDraftByChat[retryDraftUrl(sourceUrl)];
    const retrySource=retryDraftUrl(sourceUrl);
    const superseded=retryAttemptBefore(event.attemptId,meta.retryByChat?.[journalChatId(retrySource)]?.manualStartedAt);
    const staleDraftSave=event.kind==='draft.saved'&&(superseded||Boolean(operationId&&Object.hasOwn(retryReleasedOperations,operationId)));
    const owns=claim=>claim?.operationId===operationId&&claim.tabId===tabId;
    const duplicate=()=>Object.assign(new Error('Автоповтор этого запроса уже запускался в другой вкладке или ранее'),{journalPolicy:true,code:'RETRY_DUPLICATE'});
    function reserveRetry() {
      // Unbound historical log entries remain readable, but cannot authorize a
      // send. Real retry.planned carries this binding before any editor effect.
      if(!retrySource||!operationId||typeof event.promptKey!=='string'||!event.promptKey)return;
      if(retryAttemptBefore(event.attemptId,meta.retryByChat?.[journalChatId(retrySource)]?.manualStartedAt))throw duplicate();
      if(Object.hasOwn(retryConsumedOperations,operationId)||Object.hasOwn(retryReleasedOperations,operationId))throw duplicate();
      if(meta.retryDraftClaims?.[operationId])return;
      const key=JSON.stringify([retrySource,event.promptKey]);
      const claim=retrySendClaims[key],preparing=retryPreparingByChat[retrySource];
      if(claim&&(!owns(claim)||claim.phase!=='reserved')||preparing&&!owns(preparing))throw duplicate();
      retrySendClaims[key]={operationId,tabId,at:claim?.at||Date.now(),phase:'reserved'};
      retryPreparingByChat[retrySource]={operationId,tabId,claimKey:key,attemptId:event.attemptId||preparing?.attemptId||''};
    }
    if(event.kind==='goal.started'&&retrySource&&(
        retryPreparingByChat[retrySource]||
        Object.entries(active).some(([owner,entry])=>entry&&
          (entry.chatUrl||entry.sourceUrl||retryDraftUrl(meta.tabs?.[owner]?.url))===retrySource)))
      throw Object.assign(new Error('В этом чате уже готовится или выполняется автоматическая отправка'),{journalPolicy:true});
    if(['retry.planned','retry.send_intent'].includes(event.kind)&&retrySource){
      // The Goal's persisted reservation wins over legacy retry planning.
      // Refuse before reserving a retry or touching the user's draft.
      const goal=(await chrome.storage.local.get('chatgpt-goal:'+retrySource))['chatgpt-goal:'+retrySource];
      if(goal?.operation&&['preparing','sending','clicked','blocked','stopped'].includes(goal.phase))
        throw duplicate();
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
    if (['retry.send_intent','handoff.sending','goal.send_intent'].includes(event.kind)) {
      const chatUrl=retryDraftUrl(event.kind==='handoff.sending'?event.targetUrl||tab.url:sourceUrl);
      // The Goal's intent state is saved BEFORE its journal grant. A crash
      // between these two writes would leave no active journal entry, so
      // competing retries must also consult that durable operation claim.
      if(event.kind==='goal.send_intent'&&chatUrl&&retryPreparingByChat[chatUrl])
        throw Object.assign(new Error('В чате уже подготавливается восстановление ошибки; Goal не может параллельно отправлять'),{journalPolicy:true});
      if(chatUrl&&event.kind==='handoff.sending') {
        const goal=(await chrome.storage.local.get('chatgpt-goal:'+chatUrl))['chatgpt-goal:'+chatUrl];
        if(goal?.operation&&['preparing','sending','clicked','blocked','stopped'].includes(goal.phase))
          throw Object.assign(new Error('Цель удерживает незавершённую отправку в этом чате'),{journalPolicy:true});
      }
      // All automatic senders share one canonical-chat lock, not just one tab
      // slot. Unknown outcomes remain fenced after a tab closes or a worker
      // restarts. Read legacy entries through their saved tab URL.
      if(active[tabId] || chatUrl && Object.entries(active).some(([owner,entry])=>
          Number(owner)!==tabId && entry &&
          (entry.chatUrl||retryDraftUrl(meta.tabs?.[owner]?.url))===chatUrl))
        throw Object.assign(new Error('В чате уже имеется незавершённая автоматическая отправка'),{journalPolicy:true});
      active[tabId]={operationId,kind:event.kind,goalId:event.goalId||null,chatUrl,at:Date.now(),
        ...(event.kind==='retry.send_intent'?{sourceUrl:retryDraftUrl(sourceUrl),promptKey:event.promptKey,attemptId:event.attemptId||''}:{})};
    }
    if(['handoff.navigating','handoff.imported','handoff.pre_navigation_cancelled'].includes(event.kind)) {
      const source=retryDraftUrl(sourceUrl),claim=handoffSourceClaims[source];
      if(event.kind==='handoff.navigating'&&(!source||!operationId||claim))throw Object.assign(new Error('Передача этого чата уже запускалась'),{journalPolicy:true});
      if(source&&event.kind==='handoff.pre_navigation_cancelled'){
        // Only the worker can report a failed preparation before a native
        // click. A different tab or operation cannot release this fence.
        if(!claim||claim.operationId!==operationId||claim.tabId!==tabId)
          throw Object.assign(new Error('Нельзя снять запрет другой передачи'),{journalPolicy:true});
        delete handoffSourceClaims[source];
      } else if(source&&operationId&&!claim) {
        handoffSourceClaims[source]={operationId,tabId,at:Date.now()};
      }
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
    if(event.kind==='retry.preparation_superseded'&&preparation&&!retryAttemptAtOrAfter(preparation.attemptId,event.startedAt)) {
      retryReleasedOperations[preparation.operationId]=sequence;
      if(retrySendClaims[preparation.claimKey]?.phase==='reserved')delete retrySendClaims[preparation.claimKey];
      delete retryPreparingByChat[retrySource];
    }
    if(savedDraft?.operationId&&(event.kind==='retry.manual_reset'||
        event.kind==='retry.preparation_superseded'&&!retryAttemptAtOrAfter(savedDraft.attemptId,event.startedAt)))
      retryReleasedOperations[savedDraft.operationId]=sequence;
    if(event.kind==='retry.preparation_superseded') {
      // A confirmed newer manual request retires the old retry's chat slot,
      // while its consumed operation and failed-turn claim remain immutable.
      // Legacy entries without a provable request timestamp stay fenced.
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
    const currentSend=active[tabId];
    const exactGrant=Boolean(currentSend&&operationId&&currentSend.operationId===operationId);
    const resetRetry=event.kind==='retry.manual_reset'&&currentSend?.kind==='retry.send_intent';
    // An unknown Goal click remains an active, consumed fence. Neither a
    // timeout nor clicking Stop gives another automatic sender a new grant.
    const clearsGoal=exactGrant&&currentSend.kind==='goal.send_intent'&&event.kind==='goal.confirmed';
    const clearsRetry=(exactGrant||resetRetry)&&currentSend?.kind==='retry.send_intent'&&
      ['retry.confirmed','retry.failed','retry.cancelled','retry.manual_reset'].includes(event.kind);
    const clearsHandoff=exactGrant&&currentSend.kind==='handoff.sending'&&
      ['handoff.sent','handoff.failed'].includes(event.kind);
    // A closed tab is not evidence that its message was never clicked.
    // Preserve unresolved Goal locks for other tabs opening the same chat.
    if((event.kind==='tab.closed'&&currentSend?.kind!=='goal.send_intent')||
        clearsGoal||clearsRetry||clearsHandoff)delete active[tabId];
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
    const retryDraftByChat=staleDraftSave?meta.retryDraftByChat:reduceRetryDraft(meta.retryDraftByChat,entry,meta.retryByChat?.[journalChatId(entry.sourceUrl)]?.manualStartedAt);
    await chrome.storage.local.set({ [`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`]: entry,
      [JOURNAL_META]: { ...meta, sequence, active, retrySendClaims, retryConsumedOperations, retryReleasedOperations, retryPreparingByChat, handoffSourceClaims, requests, tabs, lastAt: entry.recordedAt,
        retryByChat: reduceRetrySummary(meta.retryByChat || {}, entry),retryDraftByChat,
        retryDraftClaims:event.kind==='draft.restore_intent'?{...meta.retryDraftClaims,[operationId]:sequence}:meta.retryDraftClaims } });
    journalFailure = '';
    return { ok: !staleDraftSave, ...(staleDraftSave?{duplicate:true}:{}), ...(superseded?{superseded:true}:{}), sequence, sourceUrl:entry.sourceUrl, operationId:entry.operationId,
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
    if(Object.keys(state).length===1&&Number.isFinite(state.manualStartedAt))return null;
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
