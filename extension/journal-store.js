'use strict';

// One writer (the service worker), one atomic storage.set per event + sequence.
// No automatic deletion: a failed write stops automatic sends rather than hiding a gap.
const JOURNAL_PREFIX = 'chatgpt-journal:event:';
const JOURNAL_META = 'chatgpt-journal:meta';
const GOAL_CAS_RECEIPT = 'chatgpt-goal-cas:provisional';
const RETRY_CAS_RECEIPT = 'chatgpt-retry-cas:provisional';
let journalQueue = Promise.resolve();
let journalFailure = '';
// Observe ingress synchronously, scoped both to the exact tab and canonical
// conversation. An unidentifiable source may belong to any conversation.
const journalIngressByTab = new Map(), journalIngressByChat = new Map(), journalIngressRoutes = new Map();
let journalUnknownIngress = 0, journalIngressSerial = 0;
function recordJournalIngress(event,tab) {
  const tabId=tab?.id??event?.tabId,source=retryDraftUrl(event?.sourceUrl||event?.url||''),
    observed=retryDraftUrl(tab?.url||''),chat=source||observed;
  // A network request can name chat B while the durable tab snapshot still
  // observes chat A. Retain both identities until protected writes finish.
  const route=JSON.stringify([Number.isInteger(tabId)?tabId:null,source,observed]);
  journalIngressRoutes.set(route,++journalIngressSerial);
  if(Number.isInteger(tabId)&&tabId>=0)journalIngressByTab.set(tabId,(journalIngressByTab.get(tabId)||0)+1);
  else journalUnknownIngress++;
  if(chat)journalIngressByChat.set(chat,(journalIngressByChat.get(chat)||0)+1);
  else journalUnknownIngress++;
}
function journalIngressSnapshot(tabId,url) {
  return {tabId,url,tab:journalIngressByTab.get(tabId)||0,chat:journalIngressByChat.get(url)||0,
    unknown:journalUnknownIngress,tabs:new Map(journalIngressByTab),serial:journalIngressSerial};
}
function journalIngressChanged(snapshot,tabId,url,knownTabs) {
  if(!snapshot||snapshot.tabId!==tabId||snapshot.url!==url||snapshot.tab!==(journalIngressByTab.get(tabId)||0)||
      snapshot.chat!==(journalIngressByChat.get(url)||0)||snapshot.unknown!==journalUnknownIngress)return true;
  if(!url||snapshot.serial===journalIngressSerial)return false;
  for(const [route,lastIngress] of journalIngressRoutes) {
    if(lastIngress<=snapshot.serial)continue;
    const [owner,source,observed]=JSON.parse(route),saved=retryDraftUrl(knownTabs?.[owner]?.url||'');
    // Only two positively different chat routes may leave this grant intact.
    // An absent observed route is ambiguous, not evidence for another chat.
    if(owner===tabId||source===url||observed===url||saved===url||!observed&&!saved)return true;
  }
  return false;
}
async function hasProvisionalGoalCAS() {
  const value=(await chrome.storage.local.get(GOAL_CAS_RECEIPT))[GOAL_CAS_RECEIPT];
  return value!==undefined&&value!==null;
}
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
  if(event.kind==='retry.send_intent'||event.kind==='goal.send_intent')phase='intent';
  if(['send.authorized','send.dispatched','draft.restore_deferred'].includes(event.kind))phase='unknown';
  if(event.kind==='retry.confirmed'||event.kind==='goal.confirmed')phase='confirmed';
  if(event.kind==='draft.not_clicked'||event.kind==='send.not_clicked'||event.kind==='retry.cancelled'||event.kind==='retry.failed'&&event.clicked===false)phase='not-clicked';
  if(event.kind==='retry.manual_reset')phase='superseded';
  if(event.kind==='retry.preparation_superseded'&&!retryAttemptAtOrAfter(current.attemptId,event.startedAt))phase='superseded';
  if(event.kind==='draft.restored')phase='restored';
  if(event.kind==='draft.restore_intent')return {...drafts,[url]:{...current,phase:'claimed',claimedAt:event.recordedAt,claimSequence:event.sequence,...(current.phase==='unknown'?{unknownOutcome:true}:{})}};
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
    typeof entry.draft==='string'&&entry.draft?{...record,draft:entry.draft,retryText:entry.text}:null;
}
function reduceRetrySummary(retryByChat, event) {
  const chatId = journalChatId(event.sourceUrl || event.observedTabUrl || event.url);
  if (!chatId) return retryByChat;
  if(event.kind==='retry.preparation_rollback'&&event.restoredState?.blocked===true)
    return {...retryByChat,[chatId]:event.restoredState};
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
    if(!keepBlock){delete state.blockedAttemptId;delete state.reasonCode;}
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
  if(event.kind==='retry.preparation_recovered') {
    const state=retryByChat[chatId];
    if(!state?.blocked||state.terminal||state.blockedAttemptId!==event.attemptId||
        state.lastPromptKey!==event.promptKey||(state.preparationRecoveries||0)>=2||
        state.remainingRetries===0)return retryByChat;
    return {...retryByChat,[chatId]:{...state,blocked:false,reason:'',
      ...(event.legacyNoClick?{lastPromptKey:event.legacyNoClick.newPromptKey}:{}),
      preparationRecovered:true,preparationRecoveries:(state.preparationRecoveries||0)+1,
      preparationDraftOperationId:event.preparationDraftOperationId||null,preparationDraftSequence:event.preparationDraftSequence||null}};
  }
  if(event.kind==='retry.cancelled_recovered') {
    const state=retryByChat[chatId];
    if(!state||state.blocked||state.terminal||state.remainingRetries===0||
        state.lastAttemptId!==event.attemptId||state.lastPromptKey!==event.promptKey||
        (state.cancelledRecoveries||0)>=2)return retryByChat;
    return {...retryByChat,[chatId]:{...state,preparationRecovered:true,
      cancelledRecoveries:(state.cancelledRecoveries||0)+1}};
  }
  if(event.kind==='retry.late_recovered') {
    const state=retryByChat[chatId];
    if(!state?.blocked||state.terminal||state.blockedAttemptId!==event.attemptId||
        state.lastPromptKey!==event.promptKey||state.remainingRetries===0)return retryByChat;
    return {...retryByChat,[chatId]:{...state,blocked:false,reason:'',reasonCode:'',lastPromptKey:'',lastAttemptId:'',
      preparationRecovered:true}};
  }
  if(event.kind==='retry.planned' && retryByChat[chatId]) {
    const state=retryByChat[chatId];
    if(state.lastBudgetOperation===event.operationId)return retryByChat;
    return {...retryByChat,[chatId]:{...state,preparationRecovered:false,
      ...(state.remainingRetries!=null?{remainingRetries:Math.max(0,state.remainingRetries-1),lastBudgetOperation:event.operationId}:{})}};
  }
  if(event.kind==='retry.confirmed'&&retryByChat[chatId])return {...retryByChat,[chatId]:{...retryByChat[chatId],
    preparationDraftOperationId:null,preparationDraftSequence:null}};
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
      const repeatedError=String(event.error||'').replace(/\s+/g,' ').trim();
      state.sameErrorCount=previous.repeatedError===repeatedError?(previous.sameErrorCount||0)+1:1;
      state.repeatedError=repeatedError;
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
    if(event.kind==='retry.failed')state.reasonCode=event.errorCode||'';
    state.terminal = Boolean(previous.terminal || event.terminal === true);
    if(event.terminal===true)state.terminalAttemptId=state.blockedAttemptId;
  }
  return {...retryByChat, [chatId]: state};
}
async function retryMetadata(meta) {
  if (meta.retrySchema === 1&&meta.handoffSourceClaimSchema===1&&meta.retrySendClaimSchema===2) return meta;
  const replayRetries=meta.retrySchema!==1;
  const replaySends=meta.retrySendClaimSchema!==2;
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
          retryIntents.set(event.operationId,{sourceUrl:source,promptKey:event.promptKey,tabId:event.tabId,
            retryUserId:event.retryUserId||retryIntents.get(event.operationId)?.retryUserId||null});
        }
        const intent=retryIntents.get(event.operationId);
        if(intent&&intent.tabId===event.tabId) {
          const claim=JSON.stringify([intent.sourceUrl,intent.retryUserId?'native-user:'+intent.retryUserId:intent.promptKey]);
          if(event.kind==='send.authorized'&&source===intent.sourceUrl) {
            retrySendClaims[claim]={...intent,operationId:event.operationId,tabId:event.tabId,at:event.recordedAt,phase:'consumed'};
            retryConsumedOperations[event.operationId]=event.sequence;
          }
          if(source===intent.sourceUrl&&(event.kind==='send.not_clicked'||event.kind==='retry.failed'&&event.clicked===false)&&
              retrySendClaims[claim]?.operationId===event.operationId&&retrySendClaims[claim].tabId===event.tabId)delete retrySendClaims[claim];
        }
      }
    }
  }
  return {...meta, retrySchema: 1, retryByChat,handoffSourceClaims,handoffSourceClaimSchema:1,
    retrySendClaims,retryConsumedOperations,retrySendClaimSchema:2};
}
// Called only while holding journalQueue. Never recurse into appendJournal or
// readJournal here: a pending writer would otherwise deadlock its recovery.
async function recoverProvisionalGoalCASLocked() {
  const receipt=(await chrome.storage.local.get(GOAL_CAS_RECEIPT))[GOAL_CAS_RECEIPT];
  if(receipt===null||receipt===undefined)return {ok:true,recovered:false};
  const failure=()=>Object.assign(new Error('Невозможно безопасно восстановить незавершённое состояние Goal'),
    {journalPolicy:true,code:'GOAL_CAS_RECOVERY_UNCERTAIN'});
  const url=retryDraftUrl(receipt.url),goalKey=url&&'chatgpt-goal:'+url;
  if(typeof receipt!=='object'||Array.isArray(receipt)||receipt.schema!==1||!url||url!==receipt.url||!Number.isInteger(receipt.tabId)||receipt.tabId<0||
      !receipt.expected||!receipt.next||typeof receipt.expected.id!=='string'||!receipt.expected.id||
      receipt.expected.id!==receipt.next.id||receipt.expected.url!==url||receipt.next.url!==url||
      !Number.isSafeInteger(receipt.sequence)||receipt.sequence<1||typeof receipt.kind!=='string')throw failure();
  const eventKey=`${JOURNAL_PREFIX}${String(receipt.sequence).padStart(12,'0')}`;
  const current=await chrome.storage.local.get([goalKey,JOURNAL_META,eventKey]);
  const meta=current[JOURNAL_META],event=current[eventKey];
  if(JSON.stringify(current[goalKey])!==JSON.stringify(receipt.next)||!Number.isSafeInteger(meta?.sequence)||
      meta.sequence<receipt.sequence||event?.sequence!==receipt.sequence||event.kind!==receipt.kind||
      event.goalId!==receipt.expected.id||event.tabId!==receipt.tabId||retryDraftUrl(event.sourceUrl)!==url)throw failure();
  // Later requests may already be queued or recorded. Preserve all metadata
  // and events, while rejecting a gap which could hide a conflicting write.
  for(let first=receipt.sequence+1;first<=meta.sequence;first+=RETRY_MIGRATION_BATCH_SIZE) {
    const keys=[];
    for(let n=first;n<=Math.min(meta.sequence,first+RETRY_MIGRATION_BATCH_SIZE-1);n++)
      keys.push(`${JOURNAL_PREFIX}${String(n).padStart(12,'0')}`);
    const rows=await chrome.storage.local.get(keys);
    if(keys.some((key,i)=>!rows[key]||rows[key].sequence!==first+i))throw failure();
  }
  const fresh=await chrome.storage.local.get([goalKey,JOURNAL_META,GOAL_CAS_RECEIPT]);
  if(JSON.stringify(fresh[goalKey])!==JSON.stringify(receipt.next)||JSON.stringify(fresh[JOURNAL_META])!==JSON.stringify(meta)||
      JSON.stringify(fresh[GOAL_CAS_RECEIPT])!==JSON.stringify(receipt))throw failure();
  const sequence=meta.sequence+1,rollback={kind:'goal.completion_rolled_back',schema:1,sequence,
    recordedAt:Date.now(),sourceUrl:url,sourceChatId:journalChatId(url),tabId:receipt.tabId,goalId:receipt.expected.id,
    previousSequence:receipt.sequence,version:chrome.runtime.getManifest().version};
  await chrome.storage.local.set({[goalKey]:receipt.expected,[`${JOURNAL_PREFIX}${String(sequence).padStart(12,'0')}`]:rollback,
    [JOURNAL_META]:{...meta,sequence,lastAt:rollback.recordedAt},[GOAL_CAS_RECEIPT]:null});
  return {ok:true,recovered:true};
}
async function recoverProvisionalRetryCASLocked() {
  const receipt=(await chrome.storage.local.get(RETRY_CAS_RECEIPT))[RETRY_CAS_RECEIPT];
  if(receipt===null||receipt===undefined)return {ok:true,recovered:false};
  const failure=()=>Object.assign(new Error('Невозможно безопасно восстановить незавершённое состояние автоповтора'),
    {journalPolicy:true,code:'RETRY_CAS_RECOVERY_UNCERTAIN'});
  const url=retryDraftUrl(receipt.url),chatId=journalChatId(url);
  if(typeof receipt!=='object'||Array.isArray(receipt)||receipt.schema!==1||url!==receipt.url||!chatId||
      !Number.isInteger(receipt.tabId)||!Number.isSafeInteger(receipt.sequence)||receipt.sequence<1||
      !receipt.expected||!receipt.next||!receipt.expected.blocked||receipt.next.blocked)throw failure();
  const key=`${JOURNAL_PREFIX}${String(receipt.sequence).padStart(12,'0')}`;
  const saved=await chrome.storage.local.get([JOURNAL_META,key]),meta=saved[JOURNAL_META],row=saved[key];
  if(!Number.isSafeInteger(meta?.sequence)||meta.sequence<receipt.sequence||
      JSON.stringify(meta.retryByChat?.[chatId])!==JSON.stringify(receipt.next)||
      row?.sequence!==receipt.sequence||row.kind!=='retry.preparation_recovered'||row.tabId!==receipt.tabId||
      retryDraftUrl(row.sourceUrl)!==url||row.operationId!==receipt.operationId)throw failure();
  for(let first=receipt.sequence+1;first<=meta.sequence;first+=RETRY_MIGRATION_BATCH_SIZE) {
    const keys=Array.from({length:Math.min(RETRY_MIGRATION_BATCH_SIZE,meta.sequence-first+1)},(_,i)=>
      `${JOURNAL_PREFIX}${String(first+i).padStart(12,'0')}`);
    const rows=await chrome.storage.local.get(keys);
    if(keys.some((key,i)=>!rows[key]||rows[key].sequence!==first+i))throw failure();
  }
  const fresh=await chrome.storage.local.get([JOURNAL_META,RETRY_CAS_RECEIPT]);
  if(JSON.stringify(fresh[JOURNAL_META])!==JSON.stringify(meta)||JSON.stringify(fresh[RETRY_CAS_RECEIPT])!==JSON.stringify(receipt))throw failure();
  const sequence=meta.sequence+1,rollback={kind:'retry.preparation_rollback',schema:1,sequence,recordedAt:Date.now(),
    sourceUrl:url,sourceChatId:chatId,tabId:receipt.tabId,operationId:receipt.operationId,
    previousSequence:receipt.sequence,restoredState:receipt.expected,version:chrome.runtime.getManifest().version};
  await chrome.storage.local.set({[`${JOURNAL_PREFIX}${String(sequence).padStart(12,'0')}`]:rollback,
    [JOURNAL_META]:{...meta,sequence,lastAt:rollback.recordedAt,retryByChat:{...meta.retryByChat,[chatId]:receipt.expected}},
    [RETRY_CAS_RECEIPT]:null});
  return {ok:true,recovered:true};
}
function recoverProvisionalGoalCAS() {
  const recovery=journalQueue.catch(()=>{}).then(async()=>{const goal=await recoverProvisionalGoalCASLocked();
    const retry=await recoverProvisionalRetryCASLocked();return {ok:true,recovered:goal.recovered||retry.recovered};});
  journalQueue=recovery;
  return recovery.catch(error=>{if(!error.journalPolicy){journalFailure=String(error?.message||error);console.error('Goal CAS recovery failed',journalFailure);}throw error;});
}
function appendJournal(event, tab = {}, options = {}) {
  if(event?.kind==='request.started')recordJournalIngress(event,tab);
  const enqueueTabId=tab.id??event.tabId??null;
  const enqueueUrl=retryDraftUrl(options?.goalCAS?.url||event.sourceUrl||tab.url||event.url||'');
  const ingressAtEnqueue=journalIngressSnapshot(enqueueTabId,enqueueUrl);
  const write = journalQueue.catch(() => {}).then(async () => {
    let savedMeta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    const pendingRetry=(await chrome.storage.local.get(RETRY_CAS_RECEIPT))[RETRY_CAS_RECEIPT];
    if(pendingRetry!==null&&pendingRetry!==undefined) {
      const pendingUrl=retryDraftUrl(pendingRetry?.url),owner=tab.id??event.tabId;
      const source=retryDraftUrl(event.sourceUrl||tab.url||event.url||savedMeta?.tabs?.[owner]?.url||'');
      const observed=retryDraftUrl(tab.url||savedMeta?.tabs?.[owner]?.url||'');
      // Resolve before any same-chat journal event can mutate retryByChat.
      // Unknown sources fail closed; a proven different chat continues.
      if(!pendingUrl||source===pendingUrl||observed===pendingUrl||!source&&!observed) {
        await recoverProvisionalRetryCASLocked();
        savedMeta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
      }
    }
    const goalCAS=options?.goalCAS;
    const existingGoalCAS=goalCAS?(await chrome.storage.local.get(GOAL_CAS_RECEIPT))[GOAL_CAS_RECEIPT]:null;
    const goalFenceChanged=()=>Object.assign(new Error('Goal или журнал изменились до подтверждения ответа'),{journalPolicy:true,code:'GOAL_FENCE_CHANGED'});
    // A CAS refusal must not even write a legacy metadata migration. The
    // caller can retry after normal journal initialization has completed.
    if(goalCAS&&(!savedMeta||savedMeta.retrySchema!==1||savedMeta.handoffSourceClaimSchema!==1||
        savedMeta.retrySendClaimSchema!==2||journalFailure||existingGoalCAS!==null&&existingGoalCAS!==undefined))throw goalFenceChanged();
    const meta = retryDraftMetadata(await retryMetadata(savedMeta || { sequence: 0, startedAt: Date.now() }));
    // Save a legacy replay even if the requested operation is then refused.
    // This checkpoint changes metadata only, under the same serialized writer.
    if(savedMeta&&(savedMeta.retrySchema!==1||savedMeta.handoffSourceClaimSchema!==1||savedMeta.retrySendClaimSchema!==2))await chrome.storage.local.set({[JOURNAL_META]:meta});
    const sequence = meta.sequence + 1;
    const tabId = tab.id ?? event.tabId ?? null;
    const tabs = {...meta.tabs};
    tab = {...tabs[tabId],...tab};
    if (tab.id != null && tab.url) tabs[tab.id] = {id:tab.id,url:tab.url,title:tab.title,windowId:tab.windowId};
    const sourceUrl = event.sourceUrl && event.sourceUrl !== 'https://chatgpt.com' ? event.sourceUrl : tab.url || event.sourceUrl || event.url || '';
    async function verifyGoalFence(fence,url,anchorTabId) {
      const canonical=retryDraftUrl(url);
      if(!canonical||canonical!==url||!Number.isInteger(anchorTabId)||anchorTabId<0||
          !fence||typeof fence.requestId!=='string'||!fence.requestId||typeof fence.userId!=='string'||!fence.userId||
          !Number.isFinite(fence.startedAt)||!Number.isSafeInteger(fence.requestSequence)||fence.requestSequence<1||
          !Number.isSafeInteger(meta.sequence)||fence.requestSequence>meta.sequence||journalFailure)return false;
      for(let first=fence.requestSequence;first<=meta.sequence;first+=RETRY_MIGRATION_BATCH_SIZE) {
        const keys=[];
        for(let n=first;n<=Math.min(meta.sequence,first+RETRY_MIGRATION_BATCH_SIZE-1);n++)
          keys.push(`${JOURNAL_PREFIX}${String(n).padStart(12,'0')}`);
        const values=await chrome.storage.local.get(keys);
        for(let i=0;i<keys.length;i++) {
          const entry=values[keys[i]],number=first+i;
          if(!entry||entry.sequence!==number||number>fence.requestSequence&&entry.previousWriteError)return false;
          if(number===fence.requestSequence) {
            if(entry.kind!=='request.started'||entry.tabId!==anchorTabId||retryDraftUrl(entry.sourceUrl)!==canonical||
                entry.requestId!==fence.requestId||entry.eventAt!==fence.startedAt)return false;
          } else if(entry.kind==='request.started') {
            const source=retryDraftUrl(entry.sourceUrl),observed=retryDraftUrl(entry.observedTabUrl);
            if(entry.tabId===anchorTabId||source===canonical||observed===canonical||!source&&!observed)return false;
          }
        }
      }
      return true;
    }
    async function fenceAnchorTab(fence) {
      if(!Number.isSafeInteger(fence?.requestSequence)||fence.requestSequence<1)return null;
      const key=`${JOURNAL_PREFIX}${String(fence.requestSequence).padStart(12,'0')}`;
      const row=(await chrome.storage.local.get(key))[key];
      return row?.kind==='request.started'&&Number.isInteger(row.tabId)&&row.tabId>=0?row.tabId:null;
    }
    let goalCASKey=null;
    if(goalCAS) {
      const {url,expected,next,fence}=goalCAS;
      if(!['goal.answer_continue','goal.answer_complete','goal.answer_blocked','goal.answer_budget','goal.answer_deadline','goal.answer_unverified'].includes(event.kind)||
          retryDraftUrl(sourceUrl)!==url||!expected||!next||expected.url!==url||next.url!==url||expected.id!==next.id||
          event.goalId!==expected.id||JSON.stringify(expected.queuedResumeFence)!==JSON.stringify(fence)||
          next.operation&&JSON.stringify(next.operation.queuedResumeFence)!==JSON.stringify(fence)||
          !await verifyGoalFence(fence,url,tabId))throw goalFenceChanged();
      goalCASKey='chatgpt-goal:'+url;
      if(JSON.stringify((await chrome.storage.local.get(goalCASKey))[goalCASKey])!==JSON.stringify(expected))throw goalFenceChanged();
    }
    const targetUrl = event.targetUrl || '';
    const active = { ...meta.active };
    let protectedGoalGrant=false,protectedRetryGrant=false,protectedAnchorTab=null;
    const retrySendClaims = { ...meta.retrySendClaims };
    const retryConsumedOperations = { ...meta.retryConsumedOperations };
    const retryReleasedOperations = { ...meta.retryReleasedOperations };
    const retryPreparingByChat = { ...meta.retryPreparingByChat };
    const handoffSourceClaims = { ...meta.handoffSourceClaims };
    const handoffNavigationClaims={...meta.handoffNavigationClaims};
    const requests = { ...meta.requests };
    let operationId = event.operationId || null;
    const savedDraft=meta.retryDraftByChat[retryDraftUrl(sourceUrl)];
    const retrySource=retryDraftUrl(sourceUrl);
    const superseded=retryAttemptBefore(event.attemptId,meta.retryByChat?.[journalChatId(retrySource)]?.manualStartedAt);
    const staleDraftSave=event.kind==='draft.saved'&&(superseded||Boolean(operationId&&Object.hasOwn(retryReleasedOperations,operationId)));
    const owns=claim=>claim?.operationId===operationId&&claim.tabId===tabId;
    const duplicate=()=>Object.assign(new Error('Автоповтор этого запроса уже запускался в другой вкладке или ранее'),{journalPolicy:true,code:'RETRY_DUPLICATE'});
    async function proveManualAfterLegacyRoute(prior,proof,retryUserId,binding=event) {
      if(!proof||!retryUserId||proof.userId!==retryUserId||typeof proof.requestId!=='string'||!proof.requestId||
          proof.requestId!==binding.requestId||!Number.isFinite(proof.startedAt)||String(proof.startedAt)!==String(binding.attemptId)||
          !Number.isFinite(prior.at)||proof.startedAt<=prior.at||!Number.isSafeInteger(proof.requestSequence)||
          proof.requestSequence<1||proof.requestSequence>meta.sequence)return false;
      let seenSuperseded=0;
      for(let first=proof.requestSequence;first<=meta.sequence;first+=RETRY_MIGRATION_BATCH_SIZE) {
        const keys=[];
        for(let n=first;n<=Math.min(meta.sequence,first+RETRY_MIGRATION_BATCH_SIZE-1);n++)
          keys.push(`${JOURNAL_PREFIX}${String(n).padStart(12,'0')}`);
        const batch=await chrome.storage.local.get(keys);
        for(let i=0;i<keys.length;i++) {
          const entry=batch[keys[i]],seq=first+i;
          if(!entry||entry.sequence!==seq||seq>proof.requestSequence&&entry.previousWriteError)return false;
          if(seq===proof.requestSequence) {
            if(entry.kind!=='request.started'||entry.tabId!==tabId||retryDraftUrl(entry.sourceUrl)!==retrySource||
                entry.requestId!==proof.requestId||entry.eventAt!==proof.startedAt||entry.operationId||entry.automatic===true)return false;
          } else if(entry.kind==='request.started') {
            const source=retryDraftUrl(entry.sourceUrl),observed=retryDraftUrl(entry.observedTabUrl);
            if(entry.tabId===tabId||source===retrySource||observed===retrySource||!source&&!observed)return false;
          }
          if(entry.kind==='retry.preparation_superseded'&&entry.tabId===tabId&&retryDraftUrl(entry.sourceUrl)===retrySource&&
              entry.requestId===proof.requestId&&entry.startedAt===proof.startedAt)seenSuperseded++;
        }
      }
      return seenSuperseded===1;
    }
    async function reserveRetry() {
      // Unbound historical log entries remain readable, but cannot authorize a
      // send. Real retry.planned carries this binding before any editor effect.
      if(!retrySource||!operationId||typeof event.promptKey!=='string'||!event.promptKey)return;
      if(retryAttemptBefore(event.attemptId,meta.retryByChat?.[journalChatId(retrySource)]?.manualStartedAt))throw duplicate();
      // A source handoff and a same-chat retry must not both advance the
      // failed turn, including after the handoff stopped before navigation.
      // Only a newer positively observed manual request supersedes that fence.
      const handoff=handoffSourceClaims[retrySource],manualAt=meta.retryByChat?.[journalChatId(retrySource)]?.manualStartedAt;
      if(handoff&&!(Number.isFinite(manualAt)&&manualAt>handoff.at&&retryAttemptAtOrAfter(event.attemptId,manualAt)))throw duplicate();
      if(Object.hasOwn(retryConsumedOperations,operationId)||Object.hasOwn(retryReleasedOperations,operationId))throw duplicate();
      if(meta.retryDraftClaims?.[operationId])return;
      const preparing=retryPreparingByChat[retrySource];
      // An old reservation without an observed plan sequence cannot acquire
      // a new anchor from a later intent: that could hide an intervening POST.
      if(preparing&&(!Number.isSafeInteger(preparing.plannedSequence)||preparing.plannedSequence<1||preparing.plannedSequence>meta.sequence)||
          !preparing&&event.kind!=='retry.planned')throw duplicate();
      const key=owns(preparing)?preparing.claimKey:
        JSON.stringify([retrySource,event.retryUserId?'native-user:'+event.retryUserId:event.promptKey]);
      const retryUserId=event.retryUserId||preparing?.retryUserId||null;
      for(const prior of Object.values(retrySendClaims)) {
        if(prior.phase!=='consumed'||prior.sourceUrl!==retrySource)continue;
        // A claim without a native user ID has no durable turn identity: a
        // different DOM key may be the same turn after virtualized rows remount.
        if(!prior.retryUserId) {
          if(!await proveManualAfterLegacyRoute(prior,event.legacyRetryProof||preparing?.legacyRetryProof,retryUserId))throw duplicate();
          continue;
        }
        // An unbound current turn cannot be distinguished from a consumed
        // native user merely because its rendered key changed or disappeared.
        if(!retryUserId)throw duplicate();
        // Distinct positively bound native turns remain independent even when
        // ChatGPT reuses a fallback DOM key. Without both IDs that key is
        // ambiguous and cannot authorize a second click after restart.
        if(retryUserId&&prior.retryUserId?retryUserId===prior.retryUserId:prior.promptKey===event.promptKey)
          throw duplicate();
      }
      const claim=retrySendClaims[key];
      if(claim&&(!owns(claim)||claim.phase!=='reserved')||preparing&&!owns(preparing))throw duplicate();
      retrySendClaims[key]={operationId,tabId,sourceUrl:retrySource,promptKey:event.promptKey,retryUserId,at:claim?.at||Date.now(),phase:'reserved'};
      retryPreparingByChat[retrySource]={operationId,tabId,claimKey:key,plannedSequence:preparing?.plannedSequence||sequence,attemptId:event.attemptId||preparing?.attemptId||'',
        retryUserId:event.retryUserId||preparing?.retryUserId||null,
        legacyRetryProof:event.legacyRetryProof||preparing?.legacyRetryProof||null};
      if(retryPreparingByChat[retrySource].retryUserId)event={...event,retryUserId:retryPreparingByChat[retrySource].retryUserId};
    }
    if(event.kind==='goal.started'&&retrySource&&(
        retryPreparingByChat[retrySource]||
        Object.entries(active).some(([owner,entry])=>entry&&
          (entry.chatUrl||entry.sourceUrl||retryDraftUrl(meta.tabs?.[owner]?.url))===retrySource)))
      throw Object.assign(new Error('В этом чате уже готовится или выполняется автоматическая отправка'),{journalPolicy:true});
    // Recovery preflight and Goal writes have separate lifetimes. A user can
    // Pause/Stop after preparation or intent; consult the durable Goal again
    // at each grant boundary, before reserving or consuming a retry click.
    if(retrySource&&(['retry.send_intent','retry.preparation_recovered','retry.cancelled_recovered','retry.late_recovered'].includes(event.kind)||
        event.kind==='send.authorized'&&active[tabId]?.kind==='retry.send_intent')) {
      const goal=(await chrome.storage.local.get('chatgpt-goal:'+retrySource))['chatgpt-goal:'+retrySource];
      if(goal&&(goal.stopRequested||goal.pauseRequested||['stopped','paused'].includes(goal.phase)))
        throw Object.assign(new Error('Цель остановлена или приостановлена; автоповтор отменён'),{journalPolicy:true});
    }
    if(event.kind==='retry.preparation_recovered'&&event.legacyNoClick) {
      const proof=event.legacyNoClick,state=meta.retryByChat?.[journalChatId(retrySource)];
      let changed=!Number.isSafeInteger(proof.expectedSequence)||proof.expectedSequence<0||proof.expectedSequence>meta.sequence;
      if(!changed&&proof.expectedSequence<meta.sequence) {
        const count=meta.sequence-proof.expectedSequence;
        if(count>1000)changed=true;
        else {
          const keys=Array.from({length:count},(_,i)=>`${JOURNAL_PREFIX}${String(proof.expectedSequence+i+1).padStart(12,'0')}`);
          const delta=await chrome.storage.local.get(keys);
          changed=keys.some((key,i)=>{const entry=delta[key];
            if(!entry||entry.sequence!==proof.expectedSequence+i+1||entry.previousWriteError)return true;
            const source=retryDraftUrl(entry.sourceUrl),observed=retryDraftUrl(entry.observedTabUrl);
            return entry.tabId===tabId||source===retrySource||observed===retrySource||
              entry.kind==='request.started'&&!source&&!observed;
          });
        }
      }
      if(!retrySource||changed||
          proof.oldPromptKey!==event.promptKey||state?.lastPromptKey!==proof.oldPromptKey||
          typeof proof.newPromptKey!=='string'||!proof.newPromptKey.startsWith(new URL(retrySource).pathname+'|')||
          !state.blocked||state.terminal||state.blockedAttemptId!==event.attemptId)
        throw Object.assign(new Error('Проверенный запрос изменился до восстановления'),{journalPolicy:true,code:'RETRY_LEGACY_RACE'});
    }
    if(event.kind==='retry.cancelled_recovered') {
      const state=meta.retryByChat?.[journalChatId(retrySource)];
      let changed=!Number.isInteger(event.expectedSequence)||event.expectedSequence<0||event.expectedSequence>meta.sequence;
      if(!changed&&event.expectedSequence<meta.sequence) {
        const count=meta.sequence-event.expectedSequence;
        if(count>1000)changed=true;
        else {
          const keys=Array.from({length:count},(_,i)=>`${JOURNAL_PREFIX}${String(event.expectedSequence+i+1).padStart(12,'0')}`);
          const delta=await chrome.storage.local.get(keys);
          changed=keys.some((key,i)=>{
            const entry=delta[key];
            return !entry||entry.sequence!==event.expectedSequence+i+1||entry.tabId===tabId||
              retryDraftUrl(entry.sourceUrl)===retrySource||retryDraftUrl(entry.observedTabUrl)===retrySource;
          });
        }
      }
      if(changed||
          !state||state.blocked||state.terminal||state.preparationRecovered||state.remainingRetries===0||
          state.lastAttemptId!==event.attemptId||state.lastPromptKey!==event.promptKey||
          (state.cancelledRecoveries||0)>=2||retryPreparingByChat[retrySource]||handoffSourceClaims[retrySource]||
          Object.values(active).some(a=>a&&(a.sourceUrl===retrySource||a.chatUrl===retrySource)))
        throw Object.assign(new Error('Отменённый повтор изменился до восстановления'),{journalPolicy:true,code:'RETRY_CANCELLED_RACE'});
    }
    if(event.kind==='retry.late_recovered') {
      if(!Number.isInteger(event.expectedSequence)||meta.sequence!==event.expectedSequence)
        throw Object.assign(new Error('Журнал изменился до восстановления'),{journalPolicy:true,code:'RETRY_LATE_RACE'});
      const state=meta.retryByChat?.[journalChatId(retrySource)],goal=(await chrome.storage.local.get('chatgpt-goal:'+retrySource))['chatgpt-goal:'+retrySource];
      const prior=Object.values(retrySendClaims).filter(c=>c.operationId===operationId&&c.tabId===tabId&&c.sourceUrl===retrySource&&c.phase==='consumed');
      if(!state?.blocked||state.terminal||state.remainingRetries===0||state.blockedAttemptId!==event.attemptId||
          state.lastPromptKey!==event.promptKey||savedDraft||retryPreparingByChat[retrySource]||handoffSourceClaims[retrySource]||
          Object.values(active).some(a=>a&&(a.chatUrl===retrySource||a.sourceUrl===retrySource))||prior.length!==1||
          goal&&(goal.phase!=='waiting'||goal.expectedPromptKey!==event.promptKey||goal.operation||goal.manualPending||goal.stopRequested||goal.pauseRequested))
        throw Object.assign(new Error('Проверенная отправка изменилась до восстановления'),{journalPolicy:true});
    }
    if(['retry.planned','retry.send_intent'].includes(event.kind)&&retrySource){
      // The Goal's persisted reservation wins over legacy retry planning.
      // Refuse before reserving a retry or touching the user's draft.
      const goal=(await chrome.storage.local.get('chatgpt-goal:'+retrySource))['chatgpt-goal:'+retrySource];
      if(goal?.operation&&['preparing','sending','clicked','blocked','stopped'].includes(goal.phase))
        throw duplicate();
    }
    if(event.kind==='retry.planned'||event.kind==='retry.send_intent')await reserveRetry();
    const unknownPreparation=retryPreparingByChat[retrySource],unknownOwner=unknownPreparation?.tabId;
    const unknownOwnerTabs=event.kind==='draft.restore_intent'&&event.allowUnknown===true&&unknownOwner!==tabId&&Number.isInteger(unknownOwner)
      ?await chrome.tabs.query({}):null;
    const unknownOwnerClosed=Array.isArray(unknownOwnerTabs)&&!unknownOwnerTabs.some(t=>t.id===unknownOwner);
    const unknownDraftClaim=event.kind==='draft.restore_intent'&&event.allowUnknown===true&&!journalFailure&&savedDraft?.phase==='unknown'&&savedDraft.replacementProven===true&&
      Number.isInteger(event.expectedSequence)&&event.expectedSequence===meta.sequence&&
      !active[tabId]&&!active[unknownOwner]&&unknownPreparation?.operationId===operationId&&
      (unknownOwner===tabId||event.originalTabId===unknownOwner&&unknownOwnerClosed)&&
      retrySendClaims[unknownPreparation?.claimKey]?.operationId===operationId&&
      retrySendClaims[unknownPreparation?.claimKey]?.tabId===unknownOwner&&
      retrySendClaims[unknownPreparation?.claimKey]?.phase==='consumed'&&Boolean(retryConsumedOperations[operationId]);
    if(event.kind==='draft.restore_intent'&&(!(retryDraftClaimable(savedDraft)||unknownDraftClaim)||savedDraft.operationId!==operationId||savedDraft.savedSequence!==event.savedSequence)) {
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
      if(event.kind==='goal.send_intent'&&chatUrl) {
        const goal=(await chrome.storage.local.get('chatgpt-goal:'+chatUrl))['chatgpt-goal:'+chatUrl];
        const fence=goal?.operation?.queuedResumeFence;
        const anchorTabId=fence?await fenceAnchorTab(fence):null;
        if((fence||event.queuedResumeFence)&&(!fence||goal.id!==event.goalId||goal.operation.id!==operationId||
            goal.operation.tabId!==tabId||JSON.stringify(fence)!==JSON.stringify(event.queuedResumeFence)||
            await hasProvisionalGoalCAS()||!await verifyGoalFence(fence,chatUrl,anchorTabId)))throw goalFenceChanged();
      }
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
        ...(event.kind==='retry.send_intent'?{sourceUrl:retryDraftUrl(sourceUrl),promptKey:event.promptKey,retryText:event.text,attemptId:event.attemptId||''}:{}),
        ...(event.kind==='goal.send_intent'&&event.queuedResumeFence?{queuedResumeFence:event.queuedResumeFence,anchorTabId:await fenceAnchorTab(event.queuedResumeFence)}:{})};
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
    if(event.kind==='handoff.navigation_intent') {
      const source=retryDraftUrl(sourceUrl),claim=handoffSourceClaims[source];
      if(!operationId||!source||!claim||claim.operationId!==operationId||claim.tabId!==tabId||
          active[tabId]||retryPreparingByChat[source]||Object.values(active).some(a=>a.chatUrl===source||a.sourceUrl===source)||
          Object.hasOwn(handoffNavigationClaims,operationId))
        throw Object.assign(new Error('Переход в новый чат уже запускался или не принадлежит этой передаче'),{journalPolicy:true,code:'RETRY_DUPLICATE'});
      handoffNavigationClaims[operationId]={tabId,sourceUrl:source,at:Date.now()};
    }
    if (event.kind === 'send.authorized') {
      if(meta.retryDraftClaims?.[operationId])throw Object.assign(new Error('Черновик уже передан на восстановление; отправка отменена'),{journalPolicy:true});
      if (!active[tabId] || active[tabId].operationId !== operationId || active[tabId].consumed) throw Object.assign(new Error('Повторная автоматическая отправка запрещена'),{journalPolicy:true});
      if(active[tabId].kind==='goal.send_intent'&&active[tabId].queuedResumeFence) {
        const intent=active[tabId],goal=(await chrome.storage.local.get('chatgpt-goal:'+intent.chatUrl))['chatgpt-goal:'+intent.chatUrl];
        if(retryDraftUrl(sourceUrl)!==intent.chatUrl||goal?.id!==intent.goalId||goal.operation?.id!==operationId||
            goal.operation?.tabId!==tabId||JSON.stringify(goal.operation?.queuedResumeFence)!==JSON.stringify(intent.queuedResumeFence)||
            await hasProvisionalGoalCAS()||
            !await verifyGoalFence(intent.queuedResumeFence,intent.chatUrl,intent.anchorTabId))throw goalFenceChanged();
        protectedGoalGrant=true;protectedAnchorTab=intent.anchorTabId;
      }
      if(active[tabId].kind==='retry.send_intent') {
        const intent=active[tabId];
        if(journalFailure)throw Object.assign(new Error('Неустранённый сбой записи журнала блокирует автоповтор'),
          {journalPolicy:true,code:'RETRY_GRANT_RACE'});
        protectedRetryGrant=true;
        if(!intent.sourceUrl||intent.sourceUrl!==retryDraftUrl(sourceUrl)||typeof intent.promptKey!=='string'||!intent.promptKey)throw Object.assign(new Error('Исходный запрос автоповтора не подтверждён'),{journalPolicy:true});
        const claim=retryPreparingByChat[intent.sourceUrl]?.claimKey||JSON.stringify([intent.sourceUrl,intent.promptKey]);
        if(!owns(retrySendClaims[claim])||retrySendClaims[claim].phase!=='reserved'||!owns(retryPreparingByChat[intent.sourceUrl]))throw duplicate();
        const prepared=retryPreparingByChat[intent.sourceUrl];
        if(!Number.isSafeInteger(prepared.plannedSequence)||prepared.plannedSequence<1||prepared.plannedSequence>meta.sequence)throw duplicate();
        for(let first=prepared.plannedSequence+1;first<=meta.sequence;first+=RETRY_MIGRATION_BATCH_SIZE) {
          const keys=Array.from({length:Math.min(RETRY_MIGRATION_BATCH_SIZE,meta.sequence-first+1)},(_,i)=>
            `${JOURNAL_PREFIX}${String(first+i).padStart(12,'0')}`);
          const rows=await chrome.storage.local.get(keys);
          if(keys.some((key,i)=>{const row=rows[key];
            if(!row||row.sequence!==first+i||row.previousWriteError)return true;
            if(row.kind!=='request.started')return false;
            const source=retryDraftUrl(row.sourceUrl),observed=retryDraftUrl(row.observedTabUrl);
            return row.tabId===tabId||source===intent.sourceUrl||observed===intent.sourceUrl||!source&&!observed;
          }))throw duplicate();
        }
        if(prepared.legacyRetryProof) {
          const bound={requestId:prepared.legacyRetryProof.requestId,attemptId:prepared.attemptId};
          for(const prior of Object.values(retrySendClaims)) {
            if(prior.phase==='consumed'&&prior.sourceUrl===intent.sourceUrl&&!prior.retryUserId&&
                !await proveManualAfterLegacyRoute(prior,prepared.legacyRetryProof,prepared.retryUserId,bound))throw duplicate();
          }
        }
        // Keep the claim after failure/unknown and worker restart. A different
        // native user turn receives its own claim; tab IDs cannot duplicate it.
        retrySendClaims[claim]={...retrySendClaims[claim],phase:'consumed'};
        retryConsumedOperations[operationId]=sequence;
      }
      active[tabId] = {...active[tabId],consumed:true};
    }
    if(event.kind==='send.not_clicked') {
      const preparation=retryPreparingByChat[retrySource];
      const claim=owns(preparation)?preparation.claimKey:
        JSON.stringify([retrySource,event.promptKey]);
      if(retrySendClaims[claim]?.operationId===operationId&&retrySendClaims[claim].tabId===tabId)delete retrySendClaims[claim];
      // The old operation stays consumed: only a new intent may try again after
      // MAIN positively refused the click. Unknown/missing results never release.
    }
    const preparation=retryPreparingByChat[retrySource];
    const ownSavedDraft=savedDraft?.operationId===operationId;
    const releasePreparation=(owns(preparation)||event.kind==='draft.restore_intent'&&preparation?.operationId===operationId)&&(
      event.kind==='draft.restore_intent'&&!unknownDraftClaim||
      event.kind==='retry.finished'&&(!event.clicked||event.confirmed||!ownSavedDraft||savedDraft.claimedAt&&!savedDraft.unknownOutcome)||
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
    const clearsGoal=exactGrant&&currentSend.kind==='goal.send_intent'&&
      (event.kind==='goal.confirmed'||event.kind==='goal.unsent_release'&&currentSend.consumed!==true&&
        currentSend.goalId===event.goalId&&currentSend.chatUrl===retryDraftUrl(sourceUrl));
    if(event.kind==='goal.unsent_release'&&!clearsGoal)
      throw Object.assign(new Error('Unspent Goal grant changed'),{journalPolicy:true});
    const clearsRetry=(exactGrant||resetRetry)&&currentSend?.kind==='retry.send_intent'&&
      ['retry.confirmed','retry.failed','retry.cancelled','retry.manual_reset'].includes(event.kind);
    const clearsHandoff=exactGrant&&currentSend.kind==='handoff.sending'&&
      (['handoff.sent','handoff.failed'].includes(event.kind)||event.kind==='handoff.superseded'&&
        event.nativeVerified===true&&typeof event.manualRequestId==='string'&&event.manualRequestId&&
        Number.isFinite(event.manualStartedAt)&&event.manualStartedAt>currentSend.at&&
        typeof event.userId==='string'&&event.userId&&typeof event.promptKey==='string'&&event.promptKey);
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
    const retryCAS=event.kind==='retry.preparation_recovered'&&event.legacyNoClick?{url:retrySource,tabId,sequence,operationId,
      expected:meta.retryByChat?.[journalChatId(retrySource)]}:null;
    const protectedDraftClaim=event.kind==='draft.restore_intent'&&unknownDraftClaim;
    const protectedUrl=goalCAS?.url||(protectedGoalGrant?active[tabId]?.chatUrl:null)||
      (protectedRetryGrant?active[tabId]?.sourceUrl:null)||retryCAS?.url||(protectedDraftClaim?retrySource:null);
    const protectedIngressChanged=()=>journalIngressChanged(ingressAtEnqueue,tabId,protectedUrl,meta.tabs)||
      protectedGoalGrant&&(ingressAtEnqueue.tabs.get(protectedAnchorTab)||0)!==(journalIngressByTab.get(protectedAnchorTab)||0);
    const grantRace=()=>Object.assign(new Error('Запрос изменился до разрешения автоповтора'),{journalPolicy:true,code:'RETRY_GRANT_RACE'});
    if(protectedUrl&&protectedIngressChanged())throw protectedRetryGrant?grantRace():goalFenceChanged();
    const updatedMeta={ ...meta, ...(event.kind==='journal.started'?{handoffImportPending:true}:{}),
        ...(event.kind==='extension.started'&&event.handoffImportComplete===true?{handoffImportComplete:true,handoffImportPending:false}:{}), sequence, active, retrySendClaims, retryConsumedOperations, retryReleasedOperations, retryPreparingByChat, handoffSourceClaims, handoffNavigationClaims, requests, tabs, lastAt: entry.recordedAt,
        retryByChat: reduceRetrySummary(meta.retryByChat || {}, entry),retryDraftByChat,
        retryDraftClaims:event.kind==='draft.restore_intent'?{...meta.retryDraftClaims,[operationId]:sequence}:meta.retryDraftClaims };
    if(retryCAS) {
      retryCAS.next=updatedMeta.retryByChat[journalChatId(retrySource)];
      if(!retryCAS.expected?.blocked||retryCAS.next?.blocked!==false)throw Object.assign(
        new Error('Автоповтор изменился до восстановления'),{journalPolicy:true,code:'RETRY_LEGACY_RACE'});
    }
    const provisional=goalCAS?{schema:1,url:goalCAS.url,tabId,sequence,kind:event.kind,expected:goalCAS.expected,next:goalCAS.next}:null;
    await chrome.storage.local.set({ [`${JOURNAL_PREFIX}${String(sequence).padStart(12, '0')}`]: entry,
      [JOURNAL_META]: updatedMeta,...(goalCASKey?{[goalCASKey]:goalCAS.next,[GOAL_CAS_RECEIPT]:provisional}:{}),
      ...(retryCAS?{[RETRY_CAS_RECEIPT]:{schema:1,...retryCAS}}:{}) });
    if(retryCAS&&protectedIngressChanged()) {
      await recoverProvisionalRetryCASLocked();
      throw Object.assign(new Error('Запрос изменился до восстановления автоповтора'),{journalPolicy:true,code:'RETRY_LEGACY_RACE'});
    }
    if(retryCAS) {
      try {await chrome.storage.local.set({[RETRY_CAS_RECEIPT]:null});}
      catch(error) {throw Object.assign(new Error('Не удалось завершить восстановление автоповтора: '+String(error?.message||error)),
        {journalPolicy:true,code:'RETRY_CAS_CLEANUP_UNKNOWN'});}
    }
    if(goalCAS&&journalIngressChanged(ingressAtEnqueue,tabId,protectedUrl,meta.tabs)) {
      // An interrupt/crash before this compensation leaves the provisional
      // receipt in the same atomic write as next, so startup can restore it.
      await recoverProvisionalGoalCASLocked();
      throw goalFenceChanged();
    }
    // The synchronous check above is the CAS linearization point. New ingress
    // afterwards is later than completion and is queued before the next grant.
    // If cleanup fails or the worker dies before it, startup conservatively
    // restores expected while the provisional receipt still exists.
    if(goalCAS) {
      try { await chrome.storage.local.set({[GOAL_CAS_RECEIPT]:null}); }
      catch(error) {throw Object.assign(new Error('Не удалось завершить сохранение Goal: '+String(error?.message||error)),
        {journalPolicy:true,code:'GOAL_CAS_CLEANUP_UNKNOWN'});}
    }
    // A grant already recorded while ingress occurred must stay consumed: no
    // page click has happened, but replaying this authorization is unsafe.
    if((protectedGoalGrant||protectedRetryGrant||protectedDraftClaim)&&protectedIngressChanged())
      throw protectedRetryGrant||protectedDraftClaim?grantRace():goalFenceChanged();
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
    if (saved.retrySchema !== 1||saved.handoffSourceClaimSchema!==1||saved.retrySendClaimSchema!==2) await chrome.storage.local.set({[JOURNAL_META]: meta});
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
    storageError: journalFailure, storage: globalThis.ChatGPTStorage?.status() || null,
    events: Object.entries(values).filter(([key]) => key.startsWith(JOURNAL_PREFIX)).map(([, value]) => value).sort((a,b) => a.sequence - b.sequence) };
}
let journalInitialization=null;
function initializeJournal(reason) {
  if(journalInitialization)return journalInitialization;
  const start=(async()=>{
    let meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    if(!meta) {
      await appendJournal({kind:'journal.started',reason,note:'С этого момента ведётся журнал. Прошлые автоповторы восстановить нельзя.'});
      meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    }
    let importPending=meta?.handoffImportPending===true;
    if(meta?.handoffImportComplete!==true&&meta?.handoffImportPending===undefined&&meta?.sequence>0) {
      // Pre-marker installations may be either a running legacy journal or
      // the previous version interrupted during its first handoff import.
      // Inspect only bounded journal batches: an already started journal never
      // needs a full storage scan or renewed import of terminal handoffs.
      const firstKey=`${JOURNAL_PREFIX}${String(1).padStart(12,'0')}`;
      const first=(await chrome.storage.local.get(firstKey))[firstKey];
      if(first?.kind==='journal.started') {
        importPending=true;
        for(let start=2;start<=meta.sequence&&importPending;start+=RETRY_MIGRATION_BATCH_SIZE) {
          const keys=Array.from({length:Math.min(RETRY_MIGRATION_BATCH_SIZE,meta.sequence-start+1)},(_,i)=>
            `${JOURNAL_PREFIX}${String(start+i).padStart(12,'0')}`);
          const rows=await chrome.storage.local.get(keys);
          if(keys.some(key=>rows[key]?.kind==='extension.started'))importPending=false;
        }
      }
    }
    if(meta?.handoffImportComplete!==true&&importPending) {
      const saved=await chrome.storage.local.get(null);
      const imported=Object.entries(saved).filter(([key,value])=>key.startsWith(JOURNAL_PREFIX)&&
        ['handoff.imported','handoff.navigating'].includes(value?.kind))
        .map(([,value])=>value);
      for(const [key,record] of Object.entries(saved)) {
        if(!/^chatgpt-handoff:\d+$/.test(key)||!record?.id)continue;
        const tabId=Number(key.split(':')[1]);
        if(imported.some(e=>e.operationId===record.id&&e.tabId===tabId&&e.sourceUrl===record.sourceUrl))continue;
        await appendJournal({kind:'handoff.imported',operationId:record.id,sourceUrl:record.sourceUrl,
          targetUrl:record.targetUrl,stage:record.stage,originalCreatedAt:record.createdAt,
          text:record.text,prompt:record.prompt,asFile:record.asFile,reason:record.reason,
          provenance:'Сохранённое состояние до начала журнала; это не запись наблюдения отправки'}, {id:tabId});
      }
    }
    await appendJournal({kind:'extension.started',reason,handoffImportComplete:true});
  })();
  journalInitialization=start.finally(()=>{journalInitialization=null;});
  return journalInitialization;
}
