'use strict';
importScripts('page-probe.js');
importScripts('completion-probe.js');
importScripts('completion-checkpoint.js');
importScripts('legacy-handoff-status.js');
importScripts('request-receipts.js');
importScripts('watcher-bootstrap.js');
importScripts('journal-store.js');
importScripts('handoff-title.js');
importScripts('status-store.js');
importScripts('status-animation.js');
importScripts('deferred-task-status.js');
importScripts('chat-title-probe.js');
importScripts('handoff-renamer.js');
importScripts('goal-policy.js');
importScripts('goal-store.js');
const goalController=ChatGPTGoalStore.create({storage:chrome.storage.local,tabs:chrome.tabs,appendJournal,
  beforeDispatch:async goal=>{
    const tabId=goal.operation?.tabId;
    if(!Number.isInteger(tabId)||!goal.handoffId)return;
    const key=handoffKey(tabId),handoff=(await chrome.storage.local.get(key))[key];
    if(handoff?.id===goal.handoffId&&handoff.stage==='sent'&&
        ChatGPTHandoffTitle.chatUrl(handoff.targetUrl)===goal.url)
      await renameSavedHandoff(tabId,handoff.id,{goalOperationId:goal.operation.id});
  }});

initializeJournal('worker-start').catch(console.error);

const OFFSCREEN_DOCUMENT = 'offscreen.html';
const RESPONSE_PREVIEW_MAX_CHARS = 260;
const CHATGPT_REQUEST_FILTER = {
  urls: [
    'https://chatgpt.com/backend-api/f/conversation*',
    'https://chatgpt.com/backend-api/f/steer_turn*',
    'https://chatgpt.com/backend-api/conversation*'
  ]
};

let creatingOffscreen = null;
const lastNotificationFingerprintByTab = new Map();
const statusAnimation=ChatGPTStatusAnimation.create({send:(tabId,message)=>chrome.tabs.sendMessage(tabId,message),setTimeout,clearTimeout});
let statusFocusEventSeen=false;
if(chrome.windows?.getLastFocused)void chrome.windows.getLastFocused().then(window=>{if(!statusFocusEventSeen)statusAnimation.setEnabled(window.focused===true);}).catch(()=>{});
const manualRequestReceiptsByTab=new Map();
async function latestRequestReceipt(tabId) {
  if(manualRequestReceiptsByTab.has(tabId))return manualRequestReceiptsByTab.get(tabId);
  const saved=await readRequestReceipt(tabId);
  if(saved&&!manualRequestReceiptsByTab.has(tabId))manualRequestReceiptsByTab.set(tabId,saved);
  if(!saved&&!manualRequestReceiptsByTab.has(tabId)) {
    // Extension reload clears the session cache. An unfinished journal request
    // plus its exact durable loading generation preserves observation only.
    const checkpoint=await completionCheckpointRead(tabId);
    if(checkpoint?.state==='active'&&checkpoint.requestId&&Number.isFinite(checkpoint.startedAt)) {
      const meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
      const observed=meta?.requests?.[checkpoint.requestId],url=ChatGPTHandoffTitle.chatUrl(observed?.sourceUrl);
      if(url&&ChatGPTHandoffTitle.chatUrl(meta.tabs?.[tabId]?.url)===url) {
        const view=await readChatStatus(url),current=await completionCheckpointRead(tabId);
        if(view.status?.kind==='loading'&&view.status.eventAt===checkpoint.startedAt&&
            JSON.stringify(current)===JSON.stringify(checkpoint)&&!manualRequestReceiptsByTab.has(tabId))
          manualRequestReceiptsByTab.set(tabId,{startedAt:checkpoint.startedAt,requestId:checkpoint.requestId,
            receipt:view.status.receipt,url,consumed:true,operationId:observed.operationId||null});
      }
    }
  }
  return manualRequestReceiptsByTab.get(tabId)||null;
}

async function reconcileFailedCompletionLoading(tabId,url) {
  let record=await completionCheckpointRead(tabId);
  const view=await readChatStatus(url),request=await latestRequestReceipt(tabId);
  const matches=(current,status,known)=>current?.state==='active'&&current.url===url&&current.startedAt===record?.startedAt&&
    current.requestId===record?.requestId&&current.baselineKey===record?.baselineKey&&current.promptKey===record?.promptKey&&
    known?.startedAt===record?.startedAt&&known.requestId===record?.requestId&&
    (!known.url||ChatGPTHandoffTitle.chatUrl(known.url)===url)&&
    typeof known.receipt?.epoch==='string'&&Number.isSafeInteger(known.receipt?.order)&&known.receipt.order>0&&
    status.status?.kind==='loading'&&status.status.eventAt===record?.startedAt&&
    status.status.receipt?.epoch===known.receipt?.epoch&&status.status.receipt?.order===known.receipt?.order;
  if(!record?.baselineKey||!record.promptKey||!matches(record,view,request)||ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url)return {changed:false};
  const [result]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,false,record.promptKey]});
  const native=result?.result;
  // Already-stuck pre-upgrade requests lack the marker. Read only a bounded
  // journal tail after positive native rollback proof, never the whole history.
  if(!record.requestFailedAt&&failedAttemptRollbackEvidence({...record,requestFailedAt:record.startedAt},native)) {
    const meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META],through=meta?.sequence||0;
    const keys=Array.from({length:Math.min(300,through)},(_,i)=>`${JOURNAL_PREFIX}${String(through-i).padStart(12,'0')}`);
    const rows=await chrome.storage.local.get(keys);
    const failure=Object.values(rows).find(row=>row?.kind==='request.failed'&&row.tabId===tabId&&row.requestId===record.requestId&&
      ChatGPTHandoffTitle.chatUrl(row.sourceUrl)===url&&Number.isFinite(row.recordedAt)&&row.recordedAt>=record.startedAt);
    if(failure&&await completionCheckpointFailure(tabId,{startedAt:record.startedAt,requestId:record.requestId,failedAt:failure.recordedAt}))record=await completionCheckpointRead(tabId);
  }
  if(!failedAttemptRollbackEvidence(record,native))return {changed:false,pending:Boolean(record?.requestFailedAt)};
  const current=await completionCheckpointRead(tabId),status=await readChatStatus(url),known=await latestRequestReceipt(tabId);
  if(status.revision!==view.revision||!matches(current,status,known)||ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url)return {changed:false};
  if(!await completionCheckpointFinish(tabId,record.startedAt,'failed',record.requestId))return {changed:false};
  const stopped=await stopChatLoading(url,record.startedAt,statusReceipt(),request.receipt);
  await appendJournal({kind:'completion.failed_rollback',sourceUrl:url,requestId:record.requestId,startedAt:record.startedAt,
    promptKey:record.promptKey,baselineKey:record.baselineKey},{id:tabId});
  void broadcastChatStatus(stopped).catch(()=>{});
  return {changed:true,...stopped};
}

function normalizePathname(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function isAnswerStreamRequest(details) {
  if (details.tabId < 0 || details.method !== 'POST') return false;
  const path = normalizePathname(details.url);
  return path === '/backend-api/f/conversation' || path === '/backend-api/conversation' || path === '/backend-api/f/steer_turn';
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play an audible alert after a ChatGPT response completes.'
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

async function playCompletionSound() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await ensureOffscreenDocument();
    try {
      await chrome.runtime.sendMessage({ type: 'PLAY_COMPLETION_SOUND' });
      return;
    } catch (error) {
      // The offscreen document can exist before its listener is ready after
      // an extension update. Retry only when no receiver handled the message.
      if (attempt === 3 || !/receiving end does not exist|could not establish connection/i.test(String(error?.message || error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}


function cleanSessionTitle(rawTitle) {
  const raw = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'ChatGPT';
  const cleaned = raw
    .replace(/\s*[-|–—]\s*ChatGPT\s*$/i, '')
    .replace(/^ChatGPT\s*[-|–—]\s*/i, '')
    .trim();
  return cleaned && cleaned.toLowerCase() !== 'chatgpt' ? cleaned : 'ChatGPT';
}

function truncateResponse(text, maxChars = RESPONSE_PREVIEW_MAX_CHARS) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Response finished.';
  if (normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, Math.max(1, maxChars - 3));
  const lastSpace = slice.lastIndexOf(' ');
  const safeCut = lastSpace >= Math.floor(maxChars * 0.7) ? slice.slice(0, lastSpace) : slice;
  return `${safeCut.trimEnd()}...`;
}

function formatDuration(durationMs, isError) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const seconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours} ч`);
  if (minutes) parts.push(`${minutes} мин`);
  if (remainingSeconds || !parts.length) parts.push(`${remainingSeconds} с`);
  return `${isError ? 'Ошибка через' : 'Ответ за'} ${parts.join(' ')}`;
}

async function emitBoth({ tabId = null, title = 'ChatGPT', message = 'Response finished.', isTest = false, isError = false, isWarning = false, durationMs = null, retryReason = '', ticket = null } = {}) {
  const id = ticket?.id || (isTest
    ? `chatgpt-prompt-bound-test:${Date.now()}`
    : `chatgpt-prompt-bound:${tabId}:${Date.now()}`);

  const [soundResult, notificationResult] = await Promise.allSettled([
    playCompletionSound(),
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: isTest||isWarning?'icons/icon128.png':isError?'icons/status-error.png':'icons/status-success.png',
      title: isTest ? 'Background alert test' : title,
      message,
      contextMessage: isTest
        ? 'Sound + desktop notification dispatched by the extension'
        : [isWarning?'':formatDuration(durationMs, isError), retryReason].filter(Boolean).join(' · '),
      priority: 2,
      requireInteraction: false,
      silent: true
    }).then(async result=>{
      if(ticket)await completeChatNotification(ticket,true);
      return result;
    },async error=>{
      if(ticket)await completeChatNotification(ticket,false);
      throw error;
    })
  ]);

  if (soundResult.status === 'rejected') console.error('Prompt-Bound Alert: sound failed', soundResult.reason);
  if (notificationResult.status === 'rejected') console.error('Prompt-Bound Alert: notification failed', notificationResult.reason);
  journalInBackground({ kind: 'notification.result', tabId, notificationId: id, title, message, isError, warning:isWarning, durationMs,
    sound: soundResult.status, notification: notificationResult.status,
    soundError: soundResult.status === 'rejected' ? String(soundResult.reason) : '',
    notificationError: notificationResult.status === 'rejected' ? String(notificationResult.reason) : '' });
  if (soundResult.status === 'rejected' && notificationResult.status === 'rejected') {
    throw new Error('Both sound and desktop notification failed.');
  }
  return id;
}

async function broadcastChatStatus(view) {
  const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
  // Querying tabs may finish after a newer generation has changed the status.
  // The animation subscription must obey the same revision guard as the icon.
  if((await readChatStatus(view.url)).revision!==view.revision)return;
  await Promise.allSettled(tabs.filter(tab=>ChatGPTHandoffTitle.chatUrl(tab.url)===view.url).map(tab=>{
    statusAnimation.set(tab.id,view.url,view.status?.kind==='loading');
    return chrome.tabs.sendMessage(tab.id,{type:'CHATGPT_STATUS_CHANGED',...view});
  }));
}

function messageChatUrl(message,sender) {
  if(sender.frameId>0||typeof sender.tab?.id!=='number')return '';
  const url=ChatGPTHandoffTitle.chatUrl(sender.tab.url);
  return url&&(!message.url||ChatGPTHandoffTitle.chatUrl(message.url)===url)?url:'';
}

async function visibleChatTab(tabId,url) {
  const tab=await chrome.tabs.get(tabId);
  if(!tab.active||ChatGPTHandoffTitle.chatUrl(tab.url)!==url||typeof tab.windowId!=='number')return false;
  if((await chrome.windows.get(tab.windowId)).focused!==true)return false;
  const current=await chrome.tabs.get(tabId);
  return current.active&&current.windowId===tab.windowId&&ChatGPTHandoffTitle.chatUrl(current.url)===url;
}

async function visitVisibleChat(tabId,url,receipt) {
  if(!url||!await visibleChatTab(tabId,url))return;
  const view=await visitChatNotifications(url,receipt);
  if(view.seenChanged)void broadcastChatStatus(view).catch(()=>{});
  return view;
}

async function seeVisibleResult(url,receipt) {
  const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*',active:true});
  for(const tab of tabs) {
    if(!tab.active||ChatGPTHandoffTitle.chatUrl(tab.url)!==url||!await visibleChatTab(tab.id,url))continue;
    const view=await markChatViewed(url,receipt);
    if(view.seenChanged)void broadcastChatStatus(view).catch(()=>{});
    return;
  }
}

async function signalConversationRequestEvent(tabId,message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch {}

  // Handles tabs that were already open when the unpacked extension was
  // reloaded. The content script has an install guard, so reinjection is safe.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['memory-maintenance.js', 'handoff-title.js', 'status-indicator.js', 'deferred-task-status.js', 'completion-state.js', 'goal-policy.js', 'goal-inline.js', 'content-script.js']
    });
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn('Prompt-Bound Alert: could not notify tab request watcher', error);
  }
}

// Activate DOM error observation in existing tabs without reloading pages.
async function installErrorWatchers() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  await Promise.allSettled(tabs.map(async (tab) => {
    journalInBackground({kind:'tab.snapshot',discarded:tab.discarded,frozen:tab.frozen,status:tab.status},tab);
    try {
      // This pass runs once per full extension load. A same-version reload
      // must replace invalidated listeners, even if its isolated global remains.
      await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{try{globalThis.__chatgptNotifierDispose?.();}catch{}globalThis.__chatgptNotifierDispose=null;globalThis.__chatgptNotifierVersion=null;}});
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:['memory-maintenance.js','handoff-title.js','status-indicator.js','deferred-task-status.js','completion-state.js','goal-policy.js','goal-inline.js','content-script.js']}); }
    catch (error) { journalInBackground({kind:'watcher.unavailable',reason:String(error.message || error)},tab); }
  }));
}
const watcherBootstrap=chrome.storage.session?ChatGPTWatcherBootstrap.create({session:chrome.storage.session,version:chrome.runtime.getManifest().version,install:installErrorWatchers}):null;
function activateErrorWatchers(){return watcherBootstrap?watcherBootstrap.ensure():installErrorWatchers();}
chrome.runtime.onInstalled.addListener(() => activateErrorWatchers().catch(console.warn));
chrome.runtime.onStartup.addListener(() => activateErrorWatchers().catch(console.warn));
if(watcherBootstrap)void activateErrorWatchers().catch(console.warn);
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  const receipt=statusReceipt();
  const requestUrl=ChatGPTHandoffTitle.chatUrl(details.documentUrl)||'https://chatgpt.com/';
  const request={startedAt:details.timeStamp,requestId:details.requestId||null,receipt,url:ChatGPTHandoffTitle.chatUrl(details.documentUrl)};
  manualRequestReceiptsByTab.set(details.tabId,request);
  void rememberRequestReceipt(details.tabId,request).catch(()=>{});
  void completionCheckpointStart(details.tabId,{startedAt:details.timeStamp,requestId:details.requestId,url:requestUrl}).catch(()=>{});
  // Use the source captured by the serialized journal, never a later tab URL.
  void journalRequest('request.started',details).then(async event=>{
    if(event.operationId) {
      request.operationId=event.operationId;
      await bindRequestOperationReceipt(details.tabId,request.requestId,request.startedAt,event.operationId);
    } else {
      const pending=await goalController.composerGet({tabId:details.tabId});
      if(pending?.phase==='intent')await goalController.composerRequest({tabId:details.tabId,armId:pending.id,
        requestId:request.requestId,startedAt:request.startedAt,url:request.url});
    }
    const url=ChatGPTHandoffTitle.chatUrl(event.sourceUrl);
    if(url)await broadcastChatStatus(await markChatLoading(url,details.timeStamp,receipt));
  }).catch(()=>{});
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    func: (startedAt,requestId,receipt) => { const prior=globalThis.__chatgptNotifierRequestReceipt;if(!(globalThis.__chatgptNotifierRequestStartedAt>startedAt)&&!(prior?.epoch===receipt.epoch&&prior.order>receipt.order)){globalThis.__chatgptNotifierRequestStartedAt = startedAt; globalThis.__chatgptNotifierAttemptId = `${startedAt}`;globalThis.__chatgptNotifierRequestId=requestId;globalThis.__chatgptNotifierRequestReceipt=receipt;} },
    args: [details.timeStamp,request.requestId,receipt]
  }).then(()=>signalConversationRequestEvent(details.tabId,{type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:details.timeStamp,requestId:request.requestId})).catch(() => {});
}, CHATGPT_REQUEST_FILTER);

chrome.webRequest.onCompleted.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  void journalRequest('request.completed',details).catch(()=>{});
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  void readRequestReceipt(details.tabId,{requestId:details.requestId}).then(async known=>{
    if(!known)return;
    const checkpoint=await completionCheckpointRead(details.tabId);
    if(checkpoint?.requestId===known.requestId)await completionCheckpointUpdate(details.tabId,{startedAt:known.startedAt,requestId:known.requestId,url:checkpoint.url,httpCompleted:true});
    await signalConversationRequestEvent(details.tabId,{type:'CHATGPT_CONVERSATION_REQUEST_COMPLETED',startedAt:known.startedAt,requestId:known.requestId});
  }).catch(()=>{});
}, CHATGPT_REQUEST_FILTER);

chrome.webRequest.onErrorOccurred?.addListener((details) => {
  if (!isAnswerStreamRequest(details))return;
  void journalRequest('request.failed',details).catch(()=>{});
  void readRequestReceipt(details.tabId,{requestId:details.requestId}).then(async known=>{
    if(known)await completionCheckpointFailure(details.tabId,{startedAt:known.startedAt,requestId:known.requestId,failedAt:details.timeStamp});
    if(known)return signalConversationRequestEvent(details.tabId,{type:'CHATGPT_CONVERSATION_REQUEST_FAILED',startedAt:known.startedAt,requestId:known.requestId});
  }).catch(()=>{});
}, CHATGPT_REQUEST_FILTER);

const handoffWrites = new Map();
function handoffKey(tabId) { return `chatgpt-handoff:${tabId}`; }
// Recover pre-send readiness/upload timeouts only into an empty native root.
// Send intents and unknown clicks remain terminal; reuse the original sender.
async function recoverHandoffReadiness(tabId, expected) {
  const prior=handoffWrites.get(tabId)||Promise.resolve();
  const write=prior.catch(()=>{}).then(async()=>{
    const key=handoffKey(tabId),current=(await chrome.storage.local.get(key))[key];
    if(current?.id!==expected.id||current.stage!=='failed'||
        current.reason!=='Не удалось дождаться готовности нового чата'||current.sendReceipt||
        (current.preparationRecoveries||0)>=3)return current;
    const tab=await chrome.tabs.get(tabId);
    if(tab.url!=='https://chatgpt.com/'||tab.status!=='complete'||(current.targetUrl&&current.targetUrl!==tab.url))return current;
    const journal=await readJournal();
    if(!journal.ok||journal.storageError)return current;
    const events=journal.events.filter(e=>e.operationId===current.id);
    if(!events.some(e=>e.kind==='handoff.navigating'&&e.sourceUrl===current.sourceUrl)||
        events.some(e=>e.kind==='handoff.sending'||e.kind==='handoff.sent'||e.kind==='handoff.awaiting-confirmation'||
          e.kind==='handoff.clicked'||e.kind.startsWith('send.')||e.kind==='request.started')||
        journal.events.some(e=>e.tabId===tabId&&e.kind==='request.started'&&e.recordedAt>=current.createdAt))return current;
    const [probe]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
      func:controlChatComposer,args:[{action:'inspect-empty-handoff',text:'',url:tab.url,fileName:current.asFile?current.fileName:null}]});
    if(probe?.result?.ok!==true)return current;
    // Storage, URL and Goal fences are checked again after the native probe.
    const latest=(await chrome.storage.local.get(key))[key];
    if(latest?.id!==current.id||latest.stage!=='failed'||(await chrome.tabs.get(tabId)).url!==tab.url)return latest;
    const goal=await goalController.handoffPreparationReady({sourceUrl:current.sourceUrl,handoffId:current.id,tabId});
    if(!goal.ok)return current;
    const record={...current,stage:'navigating',reason:'',preparationRecoveries:(current.preparationRecoveries||0)+1};
    await appendJournal({kind:'handoff.preparation_recovered',operationId:current.id,
      sourceUrl:current.sourceUrl,targetUrl:tab.url,recoveries:record.preparationRecoveries},{id:tabId});
    await chrome.storage.local.set({[key]:record});
    return record;
  });
  handoffWrites.set(tabId,write);
  try{return await write;}finally{if(handoffWrites.get(tabId)===write)handoffWrites.delete(tabId);}
}

async function handleHandoffMessage(message, tabId) {
  const key = handoffKey(tabId);
  if (message.type === 'CHATGPT_HANDOFF_GET') {
    // A persisted navigating/sending handoff may precede the Goal's phase
    // write if MV3 suspended the worker between durable storage operations.
    // Complete the exact same transition before allowing the content script
    // to resume its native handoff. Never redeliver a send intent.
    const pending=handoffWrites.get(tabId);
    if(pending)await pending.catch(()=>{});
    let saved=(await chrome.storage.local.get(key))[key]||null;
    if(saved?.stage==='failed'&&saved.reason==='Не удалось дождаться готовности нового чата')
      saved=await recoverHandoffReadiness(tabId,saved);

    if(saved?.id&&['navigating','preparing','sending','awaiting-confirmation'].includes(saved.stage))
      await goalController.handoffBegin({sourceUrl:saved.sourceUrl,handoffId:saved.id,tabId});
    if(saved?.id&&['sent','failed'].includes(saved.stage)) {
      // A terminal historical recovery copy must not enroll a newer Goal in its
      // transfer. Only an existing exact binding may need the legacy tab fill.
      const goal=await goalController.get(saved.sourceUrl);
      if(goal?.phase==='handoff'&&goal.handoffId===saved.id)
        await goalController.handoffBegin({sourceUrl:saved.sourceUrl,handoffId:saved.id,tabId});
    }
    if(saved?.stage==='sent'&&saved.targetUrl)
      await goalController.handoffConfirm({sourceUrl:saved.sourceUrl,targetUrl:saved.targetUrl,handoffId:saved.id,tabId,acceptedUserId:saved.acceptance?.messageId});
    if(saved?.stage==='failed')await goalController.handoffFailed({sourceUrl:saved.sourceUrl,handoffId:saved.id,tabId,reason:saved.reason});
    return {ok:true,record:saved};
  }
  const previous = handoffWrites.get(tabId) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const current = (await chrome.storage.local.get(key))[key];
    if (message.type === 'CHATGPT_HANDOFF_BEGIN') {
      if(['sending','awaiting-confirmation'].includes(current?.stage))throw new Error('Предыдущая передача ещё ожидает подтверждения');
      let record = message.record;
      if (!record || typeof record.id !== 'string' || !record.sourceUrl?.startsWith('https://chatgpt.com/c/') || typeof record.text !== 'string' || typeof record.reasoningEffort !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(record.reasoningEffort) || typeof record.reasoningModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(record.reasoningModel)) throw new Error('Invalid handoff');
      const marker = `${key}:source:${record.sourceUrl}`;
      if ((await chrome.storage.local.get(marker))[marker]) return { ok: false, error: 'Передача этого чата уже запускалась' };
      const lineageKey=`chatgpt-handoff-title:${ChatGPTHandoffTitle.chatUrl(record.sourceUrl)}`;
      const lineage=(await chrome.storage.local.get(lineageKey))[lineageKey];
      const naming=ChatGPTHandoffTitle.planNext({sourceUrl:record.sourceUrl,sourceTitle:record.sourceTitle,lineage});
      record={...record,naming};
      // Persist the full handoff and its idempotent marker before moving the
      // Goal into the handoff phase. A failed journal/storage write must not
      // strand the Goal waiting on a transfer that never started.
      await appendJournal({kind:'handoff.navigating', operationId:record.id, sourceUrl:record.sourceUrl,
        text:record.text, prompt:record.prompt, asFile:record.asFile, fileName:record.fileName,
        draftChars:record.draft?.length || 0,sourceTitle:record.sourceTitle,reasoningEffort:record.reasoningEffort,reasoningModel:record.reasoningModel,naming}, {id:tabId});
      // Save the full text BEFORE navigating away from the source page.
      await chrome.storage.local.set({ [key]: { ...record, stage: 'navigating' }, [marker]: record.id });
      try {
        await goalController.handoffBegin({sourceUrl:record.sourceUrl,handoffId:record.id,tabId});
      } catch(error) {
        // No native navigation has been issued yet. Mark the saved handoff
        // failed and keep the user-facing recovery copy instead of a phantom
        // handoff that the Goal cannot follow.
        // Both cleanup steps must be attempted. Neither cleanup failure may
        // replace the original preparation error with a misleading exception.
        const [failedRecordSaved]=await Promise.allSettled([
          chrome.storage.local.set({[key]:{...record,stage:'failed',
            reason:'Goal handoff could not be prepared: '+String(error?.message||error)}}),
          chrome.storage.local.remove(marker)
        ]);
        // Only after the terminal failed record is durable can we drop the
        // shared source claim: no native navigation/click was attempted.
        // If the failed-record write was uncertain, leave the claim fenced.
        if(failedRecordSaved.status==='fulfilled') {
          try {
            await appendJournal({kind:'handoff.pre_navigation_cancelled',
              operationId:record.id,sourceUrl:record.sourceUrl},{id:tabId,url:record.sourceUrl});
          } catch {}
        }
        throw error;
      }
      return { ok: true, record: { ...record, stage: 'navigating' } };
    }
    if (!current || current.id !== message.id) throw new Error('Handoff changed');
    if(message.type==='HANDOFF_CLICK_RECEIPT') {
      if(!['sending','awaiting-confirmation'].includes(current.stage)||current.sendReceipt)throw new Error('Handoff click receipt refused');
      const record={...current,sendReceipt:message.receipt};
      await chrome.storage.local.set({[key]:record});
      return {ok:true,record};
    }
    if(message.type==='CHATGPT_HANDOFF_DRAFT_CLAIM') {
      if(current.stage!=='sent'||ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==ChatGPTHandoffTitle.chatUrl(current.targetUrl))throw new Error('Handoff draft destination changed');
      if(current.draftRestoreClaimedAt)return {ok:true,claimed:false,record:current};
      const record={...current,draftRestoreClaimedAt:Date.now()};
      await appendJournal({kind:'handoff.draft_restore_intent',operationId:record.id,targetUrl:record.targetUrl,draftChars:record.draft?.length||0},{id:tabId});
      await chrome.storage.local.set({[key]:record});
      return {ok:true,claimed:true,record};
    }
    let acceptance=null;
    if(message.type==='CHATGPT_HANDOFF_RECONCILE'||message.stage==='sent') {
      if(current.stage==='sent'){
        await goalController.handoffConfirm({sourceUrl:current.sourceUrl,targetUrl:current.targetUrl,handoffId:current.id,tabId,acceptedUserId:current.acceptance?.messageId});
        return {ok:true,record:current,confirmed:true};
      }
      if(!['sending','awaiting-confirmation'].includes(current.stage))return {ok:true,record:current,confirmed:false};
      const receipt=current.sendReceipt;
      if(receipt?.operationId===current.id&&typeof receipt.submittedText==='string'&&receipt.submittedText&&Number.isFinite(receipt.clickedAt)) {
        const results=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectHandoffAcceptance,args:[{
          sourceUrl:current.sourceUrl,targetUrl:current.targetUrl,submittedText:receipt.submittedText,conversationAlias:receipt.conversationAlias||''}]});
        const proof=results[0]?.result;
        if(proof?.accepted&&ChatGPTHandoffTitle.chatUrl(proof.targetUrl)&&ChatGPTHandoffTitle.chatUrl(proof.targetUrl)!==ChatGPTHandoffTitle.chatUrl(current.sourceUrl)&&proof.messageId&&
            ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)===ChatGPTHandoffTitle.chatUrl(proof.targetUrl))acceptance=proof;
      }
      if(!acceptance) {
        if(message.type==='CHATGPT_HANDOFF_RECONCILE')return {ok:true,record:current,confirmed:false};
        throw new Error('Handoff native payload acceptance is not confirmed');
      }
      message={...message,stage:'sent',targetUrl:acceptance.targetUrl};
    }
    const allowed = {
      navigating: ['preparing', 'failed'], preparing: ['preparing', 'sending', 'failed'],
      sending: ['sent', 'awaiting-confirmation', 'failed'], 'awaiting-confirmation':['sent','awaiting-confirmation'], sent: [], failed: []
    };
    if (!allowed[current.stage]?.includes(message.stage)) throw new Error('Handoff transition refused');
    if(message.stage==='sent'&&(!ChatGPTHandoffTitle.chatUrl(message.targetUrl)||
        ChatGPTHandoffTitle.chatUrl(message.targetUrl)===ChatGPTHandoffTitle.chatUrl(current.sourceUrl)))throw new Error('Handoff destination is not a new permanent chat');
    const record = { ...current, stage: message.stage, targetUrl: message.targetUrl || current.targetUrl, reason: message.reason || '',
      ...(message.stage==='awaiting-confirmation'?{awaitingNotifiedAt:current.awaitingNotifiedAt||Date.now()}:{}),
      ...(acceptance?{acceptance:{messageId:acceptance.messageId,entryId:acceptance.entryId,targetUrl:acceptance.targetUrl,confirmedAt:Date.now()}}:{}),
      ...(message.stage==='sent'?{sentAt:Date.now()}: {}) };
    await appendJournal({kind:`handoff.${message.stage}`,operationId:record.id,sourceUrl:record.sourceUrl,
      targetUrl:record.targetUrl,reason:record.reason}, {id:tabId});
    const lineageUrl=message.stage==='sent'&&record.naming?ChatGPTHandoffTitle.chatUrl(record.targetUrl):'';
    await chrome.storage.local.set({ [key]: record,
      ...(lineageUrl?{[`chatgpt-handoff-title:${lineageUrl}`]:{...record.naming,targetUrl:lineageUrl,transferred:true,confirmed:false}}:{}) });
    if(message.stage==='sent')
      await goalController.handoffConfirm({sourceUrl:record.sourceUrl,targetUrl:record.targetUrl,handoffId:record.id,tabId,acceptedUserId:record.acceptance?.messageId});
    if(message.stage==='failed')await goalController.handoffFailed({sourceUrl:record.sourceUrl,handoffId:record.id,tabId,reason:record.reason});
    return { ok: true, record, notifyAwaiting:message.stage==='awaiting-confirmation'&&!current.awaitingNotifiedAt };
  });
  handoffWrites.set(tabId, write);
  try { return await write; } finally { if (handoffWrites.get(tabId) === write) handoffWrites.delete(tabId); }
}

// Adopt only a user-submitted native message. This path never clicks or edits
// the composer, and does not infer a new chat from its URL alone.
async function recoverNativeComposerGoal(tabId,url,pending) {
  const waiting=()=>({ok:true,pending:true,url,composer:pending});
  if(!ChatGPTGoalPolicy.canonical(url)||pending.url!=='https://chatgpt.com/'||
      !Number.isFinite(pending.intent?.eventAt)||Date.now()-pending.intent.eventAt<30000)return waiting();
  const journal=await readJournal();
  const requests=journal.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&!e.operationId&&
    typeof e.requestId==='string'&&e.requestId&&Number.isFinite(e.eventAt));
  const candidates=requests.filter(e=>e.sourceUrl===pending.url&&e.eventAt>=pending.intent.eventAt&&e.eventAt-pending.intent.eventAt<=10000);
  if(candidates.length!==1)return waiting();
  const request=candidates[0];
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
    func:inspectCompletedTurn,args:[url,true,null,request.eventAt]});
  const native=checked?.result,timeline=native?.recoveryTimeline;
  if(!native?.ok||native.url!==url||native.isReadOnly!==false||!Array.isArray(timeline)||!timeline.length||
      timeline[0].userId!==native.userId||!ChatGPTGoalPolicy.submittedTextMatches(pending.intent.text,native.userText,native.userVisibleText)||
      !Number.isFinite(native.userSentAtMs)||Math.abs(native.userSentAtMs-request.eventAt)>10000)return waiting();
  const supplements=[];
  for(const user of timeline.slice(1)) {
    const found=requests.filter(e=>e.sourceUrl===url&&e.eventAt>request.eventAt&&Math.abs(e.eventAt-user.userSentAtMs)<=10000);
    if(found.length!==1)return waiting();
    supplements.push({...user,requestId:found[0].requestId,startedAt:found[0].eventAt});
  }
  const [currentNative]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
  const latest=currentNative?.result,last=timeline.at(-1),current=await goalController.composerGet({tabId});
  if(ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url||current?.id!==pending.id||
      current.phase!=='intent'||JSON.stringify(current)!==JSON.stringify(pending)||
      !latest?.ok||latest.isLatest!==true||latest.isReadOnly!==false||latest.userId!==last.userId||
      latest.promptKey!==last.promptKey||latest.userText!==last.userText||latest.userSentAtMs!==last.userSentAtMs)return waiting();
  const result=await goalController.composerBind({tabId,armId:pending.id,url,requestId:request.requestId,startedAt:request.eventAt,
    promptKey:native.promptKey,userId:native.userId,userText:native.userText,userVisibleText:native.userVisibleText,
    userSentAtMs:native.userSentAtMs,firstTurn:native.firstTurn,nativeVerified:true,
    recovery:{nativeVerified:true,firstUserId:timeline[0].userId,supplements}});
  // Only the latest fully completed answer may continue a recovered Goal.
  // Earlier answers are historical context, never independent send triggers.
  if(result.ok&&latest.turnStatus==='complete'&&latest.generating===false&&!latest.hasError&&
      latest.assistantCompleted===true&&latest.assistantPhase==='final_answer'&&latest.assistantKey)
    await goalController.completion({url,tabId,completionKey:latest.promptKey+'|'+latest.assistantKey,
      promptKey:latest.promptKey,userId:latest.userId,response:latest.goalResponse||'',
      rawExact:latest.goalRawExact===true,nativeVerified:true});
  return {ok:result.ok,url,tabId,composer:result.record,record:await goalController.get(url)};
}
async function bindNativeComposerGoal(tabId,currentUrl,armId) {
  const pending=await goalController.composerGet({tabId});
  const canonical=ChatGPTGoalPolicy.canonical(currentUrl);
  if(!pending||pending.id!==armId||!['intent','bound'].includes(pending.phase))
    return {ok:false,error:'Goal больше не ожидает эту отправку'};
  if(pending.phase==='bound') {
    if(pending.binding?.url!==canonical)return {ok:false,error:'Чат цели изменился'};
    return {ok:true,url:canonical,record:await goalController.get(canonical),composer:pending};
  }
  const waiting=()=>({ok:true,pending:true,url:currentUrl,composer:pending});
  const latest=await latestRequestReceipt(tabId);
  const request=latest||pending.request;
  if(!Number.isFinite(pending.intent?.eventAt)||!request||request.startedAt<pending.intent?.eventAt||request.startedAt-pending.intent?.eventAt>10000)
    return typeof recoverNativeComposerGoal==='function'?recoverNativeComposerGoal(tabId,canonical||currentUrl,pending):waiting();
  if(!pending.request)await goalController.composerRequest({tabId,armId,requestId:request.requestId,
    startedAt:request.startedAt,url:request.url});
  if(!canonical)return waiting();
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[canonical,true]});
  const native=checked?.result;
  if(!native?.ok||native.isLatest!==true||native.isReadOnly!==false||!native.userId||
      typeof native.userText!=='string'||!native.promptKey||!Number.isFinite(native.userSentAtMs))return waiting();
  const live=ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url),
    fresh=await latestRequestReceipt(tabId)||(await goalController.composerGet({tabId}))?.request;
  if(live!==canonical||fresh?.requestId!==request.requestId||fresh?.startedAt!==request.startedAt)
    return {ok:false,error:'Отправка или чат изменились до подтверждения Goal'};
  if(request.url&&request.url!=='https://chatgpt.com/'&&ChatGPTGoalPolicy.canonical(request.url)!==canonical)
    return {ok:false,error:'Запрос отправлен в другой чат'};
  const result=await goalController.composerBind({tabId,armId,url:canonical,requestId:request.requestId,
    startedAt:request.startedAt,promptKey:native.promptKey,userId:native.userId,userText:native.userText,
    userSentAtMs:native.userSentAtMs,userVisibleText:native.userVisibleText,firstTurn:native.firstTurn,nativeVerified:true});
  // The first answer may have completed before the root chat received its
  // permanent URL. Replay that exact native completion through the coordinator.
  if(result.ok&&native.turnStatus==='complete'&&native.generating===false&&!native.hasError&&
      native.assistantCompleted===true&&native.assistantPhase==='final_answer'&&native.assistantKey) {
    await goalController.completion({url:canonical,tabId,
      completionKey:native.promptKey+'|'+native.assistantKey,promptKey:native.promptKey,
      userId:native.userId,response:native.goalResponse||'',rawExact:native.goalRawExact===true,nativeVerified:true});
  }
  return {ok:result.ok,url:canonical,tabId,composer:result.record,record:await goalController.get(canonical)};
}

async function reconcileGoalPromptBinding(tabId,url) {
  const goal=await goalController.get(url);
  if(goal?.phase!=='waiting'||goal.operation||goal.manualPending||goal.pauseRequested||goal.stopRequested)return {ok:false};
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
  const native=checked?.result;
  if(!native?.ok||native.isLatest!==true||native.isReadOnly!==false||native.hasError||!native.userId||
      !native.promptKey||native.promptKey===goal.expectedPromptKey||!Number.isFinite(native.userSentAtMs))return {ok:false};
  const journal=await readJournal();
  if(!journal.ok||journal.storageError)return {ok:false};
  const confirmed=journal.events.filter(e=>e.sourceUrl===url&&e.goalId===goal.id&&e.kind==='goal.confirmed').at(-1);
  if(!confirmed||confirmed.tabId!==tabId||confirmed.promptKey!==goal.expectedPromptKey&&
      (goal.confirmedPromptBinding?.operationId!==confirmed.operationId||goal.confirmedPromptBinding.userId!==native.userId))return {ok:false};
  const own=journal.events.filter(e=>e.operationId===confirmed.operationId&&e.tabId===tabId&&e.sourceUrl===url);
  const sends=own.filter(e=>e.kind==='send.dispatched'),requests=own.filter(e=>e.kind==='request.started');
  if(sends.length!==1||requests.length!==1||!requests[0].requestId||
      !Number.isFinite(requests[0].eventAt)||Math.abs(requests[0].eventAt-native.userSentAtMs)>10000||
      sends[0].text!==native.userText||
      journal.events.filter(e=>e.kind==='request.started'&&(e.tabId===tabId||e.sourceUrl===url)&&
        Number.isFinite(e.eventAt)&&Math.abs(e.eventAt-native.userSentAtMs)<=10000).length!==1||
      journal.events.some(e=>(e.tabId===tabId||e.sourceUrl===url)&&e.kind==='request.started'&&e.sequence>requests[0].sequence)||
      ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
  const result=await goalController.rebindPrompt({url,tabId,id:goal.id,oldPromptKey:goal.expectedPromptKey,
    promptKey:native.promptKey,userId:native.userId,operationId:confirmed.operationId});
  if(!result.ok)return result;
  await completionCheckpointChange(tabId,current=>current?.url===url&&current.state==='active'&&
    current.promptKey===goal.expectedPromptKey&&current.startedAt===requests[0].eventAt
      ?{record:{...current,promptKey:native.promptKey},value:true}:{value:false});
  const receipt=manualRequestReceiptsByTab.get(tabId);
  if(receipt?.url===url&&receipt.startedAt===requests[0].eventAt&&receipt.recoveredPromptKey===goal.expectedPromptKey)
    manualRequestReceiptsByTab.set(tabId,{...receipt,recoveredPromptKey:native.promptKey});
  // Rebinding alone never authorizes a send. Only a fully completed native
  // answer may enter the existing coordinator and its protected sender.
  if(native.turnStatus==='complete'&&native.generating===false&&native.assistantCompleted===true&&
      native.assistantPhase==='final_answer'&&native.assistantKey)
    await goalController.completion({url,tabId,promptKey:native.promptKey,
      completionKey:native.promptKey+'|'+native.assistantKey,userId:native.userId,
      response:native.goalResponse||'',rawExact:native.goalRawExact===true,nativeVerified:true});
  return {ok:true,promptKey:native.promptKey,userId:native.userId};
}

const retryReadinessRecoveries=new Map();
async function recoverNoClickRetry(tabId,url) {
  if(retryReadinessRecoveries.has(url))return retryReadinessRecoveries.get(url);
  const work=(async()=>{
    const state=await readRetryState(url);
    if(!state?.blocked||state.terminal||(state.preparationRecoveries||0)>=2||state.remainingRetries===0||
        !state.lastPromptKey||!state.blockedAttemptId||await readRetryDraft(url))return state;
    const journal=await readJournal();
    if(!journal.ok||journal.storageError)return state;
    const failures=journal.events.filter(e=>e.sourceUrl===url&&['retry.failed','draft.restore_failed'].includes(e.kind));
    const failed=failures.at(-1);
    if(failed?.kind!=='retry.failed'||failed.tabId!==tabId||!failed.operationId||failed.clicked!==false||failed.attemptId!==state.blockedAttemptId||
        (failed.error||failed.reason)!==state.reason)return state;
    const events=journal.events.filter(e=>e.operationId===failed.operationId);
    const planned=events.find(e=>e.kind==='retry.planned');
    if(planned?.promptKey!==state.lastPromptKey||planned.attemptId!==failed.attemptId||
        !events.some(e=>e.kind==='retry.finished'&&e.clicked===false)||
        events.some(e=>e.kind==='send.dispatched'||e.kind==='retry.clicked'||e.kind==='request.started')||
        events.some(e=>e.kind==='retry.send_intent'||e.kind==='send.authorized')&&!events.some(e=>e.kind==='send.not_clicked')||
        journal.events.some(e=>(e.tabId===tabId||e.sourceUrl===url)&&e.kind==='request.started'&&e.recordedAt>planned.recordedAt))return state;
    const tab=await chrome.tabs.get(tabId);
    if(tab.url!==url||tab.status!=='complete')return state;
    const goal=await goalController.get(url);
    if(goal&&(goal.operation||goal.pauseRequested||goal.stopRequested||goal.manualPending||
        goal.phase!=='blocked'||goal.reason!=='Восстановление запроса завершилось ошибкой'||Date.now()>=goal.deadlineAt))return state;
    const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url]});
    const native=checked?.result;
    if(!native?.ok||native.isLatest!==true||native.isReadOnly!==false||!native.hasError||!native.userId||
        native.promptKey!==planned.promptKey||planned.retryUserId&&native.userId!==planned.retryUserId||Math.abs(native.lastUserSentAtMs-Number(planned.attemptId))>10000||
        !Number.isFinite(native.lastUserSentAtMs))return state;
    const [error]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectChatError,args:[0,false]});
    if(error?.result?.action!=='retry')return state;
    const [empty]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatComposer,
      args:[{action:'inspect-empty-retry',text:'',url}]});
    if(empty?.result?.ok!==true)return state;
    const [runtime]=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',
      func:()=>({attemptId:globalThis.__chatgptNotifierAttemptId||'',requestId:globalThis.__chatgptNotifierRequestId||null})});
    if(runtime?.result?.attemptId!==planned.attemptId||(runtime.result.requestId||null)!==(planned.requestId||null)||
        (await chrome.tabs.get(tabId)).url!==url)return state;
    await appendJournal({kind:'retry.preparation_recovered',operationId:failed.operationId,sourceUrl:url,
      attemptId:planned.attemptId,promptKey:planned.promptKey,requestId:planned.requestId},tab);
    await goalController.retry({url,tabId,kind:'retry.preparation_recovered',promptKey:planned.promptKey,attemptId:planned.attemptId});
    return readRetryState(url);
  })();
  retryReadinessRecoveries.set(url,work);
  try{return await work;}finally{if(retryReadinessRecoveries.get(url)===work)retryReadinessRecoveries.delete(url);}
}

const goalAckProofs=new Map();
async function readGoalAckProof(tabId,url,op) {
  const cached=goalAckProofs.get(op.id);
  if(cached&&cached.tabId===tabId&&cached.url===url&&cached.text===op.text&&cached.createdAt===op.createdAt)return cached;
  const journal=await readJournal();
  const own=e=>e.operationId===op.id&&e.tabId===tabId&&e.sourceUrl===url;
  const sends=journal.events.filter(e=>own(e)&&e.kind==='send.dispatched'&&e.requestedText===op.text&&typeof e.text==='string'&&e.text);
  const requests=journal.events.filter(e=>own(e)&&e.kind==='request.started'&&typeof e.requestId==='string'&&
    e.requestId&&Number.isFinite(e.eventAt)&&e.eventAt>=op.createdAt);
  if(sends.length!==1||requests.length!==1)return null;
  const proof={tabId,url,text:op.text,createdAt:op.createdAt,submittedText:sends[0].text,
    request:{requestId:requests[0].requestId,startedAt:requests[0].eventAt,url,operationId:op.id}};
  goalAckProofs.set(op.id,proof);
  if(goalAckProofs.size>16)goalAckProofs.delete(goalAckProofs.keys().next().value);
  return proof;
}
async function reconcileNativeGoalAcknowledgement(tabId,url) {
  const record=(await chrome.storage.local.get('chatgpt-goal:'+url))['chatgpt-goal:'+url],op=record?.operation;
  if(record?.phase!=='blocked'||!op||!['intent','clicked'].includes(op.status)||op.tabId!==tabId)return;
  const proof=await readGoalAckProof(tabId,url,op);
  if(!proof)return;
  return confirmNativeGoalSend({url,tabId,id:record.id,operationId:op.id,
    requestId:proof.request.requestId,startedAt:proof.request.startedAt});
}
async function reconcileAcceptedHandoffGoal(tabId,url) {
  const key='chatgpt-goal:'+url,values=await chrome.storage.local.get([key,handoffKey(tabId)]);
  const goal=values[key],handoff=values[handoffKey(tabId)];
  if(goal?.phase!=='waiting'||goal.operation||goal.handoffPending!==true||handoff?.stage!=='sent'||
      goal.handoffId!==handoff.id||handoff.targetUrl!==url||!goal.handoffAcceptedUserId||
      handoff.acceptance?.messageId!==goal.handoffAcceptedUserId||!handoff.sendReceipt?.submittedText)return;
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
  const native=checked?.result;
  if(!native?.ok||native.url!==url||native.isLatest!==true||native.isReadOnly!==false||native.generating!==false||
      native.turnStatus!=='complete'||native.hasError||native.assistantCompleted!==true||native.assistantPhase!=='final_answer'||
      !native.assistantKey||native.userId!==goal.handoffAcceptedUserId||native.userText!==handoff.sendReceipt.submittedText)return;
  const current=await chrome.storage.local.get([key,handoffKey(tabId)]);
  if(JSON.stringify(current[key])!==JSON.stringify(goal)||JSON.stringify(current[handoffKey(tabId)])!==JSON.stringify(handoff)||
      ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)return;
  return goalController.completion({url,tabId,completionKey:native.promptKey+'|'+native.assistantKey,
    promptKey:native.promptKey,userId:native.userId,response:native.goalResponse||'',
    rawExact:native.goalRawExact===true,nativeVerified:true});
}
async function reconcileGoalPreparation(tabId,url) {
  const key='chatgpt-goal:'+url,goal=(await chrome.storage.local.get(key))[key],op=goal?.operation;
  if(goal?.phase!=='blocked'||op?.status!=='reserved'||op.tabId!==tabId||goal.pauseRequested||goal.stopRequested)return;
  const meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
  // A reserved operation may be retried only before any journal send intent.
  // Intent/clicked/unknown outcomes remain fenced even if the editor is idle.
  if(!meta||meta.active?.[tabId]||Object.values(meta.active||{}).some(a=>a.operationId===op.id))return;
  const ready=await chrome.tabs.sendMessage(tabId,{type:'CHATGPT_GOAL_READINESS',url});
  if(!ready?.ok||ready.idle!==true||ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)return;
  const current=(await chrome.storage.local.get(key))[key];
  const freshMeta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
  if(JSON.stringify(current)!==JSON.stringify(goal)||!freshMeta||freshMeta.active?.[tabId]||
      Object.values(freshMeta.active||{}).some(a=>a.operationId===op.id))return;
  return goalController.retryPreparation({url,tabId,id:goal.id,operationId:op.id});
}
async function confirmNativeGoalSend({url,tabId,id,operationId,requestId,startedAt}) {
  const key='chatgpt-goal:'+url,record=(await chrome.storage.local.get(key))[key],op=record?.operation;
  const sameOperation=value=>value?.id===id&&value.url===url&&value.operation?.id===operationId&&value.operation.tabId===tabId&&
    ['sending','clicked','blocked'].includes(value.phase)&&['intent','clicked'].includes(value.operation.status)&&
    value.operation.text===op?.text&&value.operation.baselineKey===op?.baselineKey&&!value.manualPending&&
    !(value.manualStartedAt>value.operation.createdAt);
  if(!sameOperation(record))return {ok:false,pending:false,error:'Операция Goal изменилась'};
  const known=await latestRequestReceipt(tabId);
  const proof=typeof readGoalAckProof==='function'?await readGoalAckProof(tabId,url,op):null;
  const request=known||proof?.request;
  const matches=known=>known?.operationId===operationId&&known.requestId===requestId&&known.startedAt===startedAt&&typeof requestId==='string'&&requestId&&
    Number.isFinite(startedAt)&&startedAt>=op.createdAt&&(!known.url||ChatGPTGoalPolicy.canonical(known.url)===url);
  if(!matches(request))return {ok:false,pending:true};
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
  const native=checked?.result;
  if(!native?.ok||native.url!==url||native.isLatest!==true||native.isReadOnly!==false||
      typeof native.userId!=='string'||!native.userId||typeof native.promptKey!=='string'||
      !native.promptKey.startsWith(new URL(url).pathname+'|')||native.promptKey===op.baselineKey||
      !Number.isFinite(native.userSentAtMs)||Math.abs(native.userSentAtMs-startedAt)>10000||
      (native.userText!==op.text&&native.userVisibleText!==op.text&&native.userText!==proof?.submittedText))return {ok:false,pending:true};
  const current=(await chrome.storage.local.get(key))[key],fresh=await latestRequestReceipt(tabId)||proof?.request;
  if(!sameOperation(current)||current.phase!==record.phase||!matches(fresh)||ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)
    return {ok:false,pending:false,error:'Goal или запрос изменились при подтверждении'};
  const result=await goalController.report({url,tabId,id,operationId,status:'confirmed',newPromptKey:native.promptKey,nativeConfirmed:true});
  if(result.ok&&typeof goalAckProofs!=='undefined')goalAckProofs.delete(operationId);
  if(result.ok&&native.turnStatus==='complete'&&native.generating===false&&!native.hasError&&
      native.assistantCompleted===true&&native.assistantPhase==='final_answer'&&native.assistantKey)
    await goalController.completion({url,tabId,completionKey:native.promptKey+'|'+native.assistantKey,
      promptKey:native.promptKey,userId:native.userId,response:native.goalResponse||'',
      rawExact:native.goalRawExact===true,nativeVerified:true});
  return result;
}

async function bindNativeManualSupplement(tabId,url) {
  const record=await goalController.get(url),pending=record?.manualPending;
  if(!pending)return {ok:true,pending:false};
  if(pending.tabId!==tabId)return {ok:false,pending:true};
  const request=await latestRequestReceipt(tabId);
  if(request?.requestId!==pending.requestId||request.startedAt!==pending.startedAt||
      request.url&&ChatGPTGoalPolicy.canonical(request.url)!==url) {
    // A later automatic retry may supersede the request cache while a sent
    // user clarification still awaits adoption. Recover only its exact native
    // timestamp and rendered sent text, never the current composer draft.
    const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
      func:inspectCompletedTurn,args:[url,true,null,pending.startedAt]});
    const native=checked?.result,current=await goalController.get(url);
    if(!native?.ok||native.isLatest!==false||native.isReadOnly!==false||native.url!==url||!native.userId||!native.promptKey||
        !Number.isFinite(native.userSentAtMs)||Math.abs(native.userSentAtMs-pending.startedAt)>10000||
        !ChatGPTGoalPolicy.submittedTextMatches(pending.text,native.userText,native.userVisibleText)||
        current?.id!==record.id||JSON.stringify(current.manualPending)!==JSON.stringify(pending)||
        ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)return {ok:false,pending:true};
    const bound=await goalController.manualBind({url,tabId,id:record.id,requestId:pending.requestId,
      startedAt:pending.startedAt,promptKey:native.promptKey,userId:native.userId,
      userText:native.userText,userVisibleText:native.userVisibleText,userSentAtMs:native.userSentAtMs,nativeVerified:true});
    return {ok:bound.ok,pending:!bound.ok};
  }
  const waiting=()=>({ok:true,pending:true});
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
  const native=checked?.result;
  if(!native?.ok||native.isLatest!==true||native.isReadOnly!==false||!native.userId||
      !native.promptKey||!Number.isFinite(native.userSentAtMs)||typeof native.userText!=='string')return waiting();
  const fresh=await latestRequestReceipt(tabId);
  if(ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url||fresh?.requestId!==pending.requestId||fresh.startedAt!==pending.startedAt)return {ok:false,pending:true};
  const bound=await goalController.manualBind({url,tabId,id:record.id,requestId:pending.requestId,startedAt:pending.startedAt,
    promptKey:native.promptKey,userId:native.userId,userText:native.userText,userVisibleText:native.userVisibleText,
    userSentAtMs:native.userSentAtMs,nativeVerified:true});
  if(!bound.ok)return waiting();
  if(native.turnStatus==='complete'&&native.generating===false&&!native.hasError&&native.assistantCompleted===true&&native.assistantPhase==='final_answer'&&native.assistantKey)
    await goalController.completion({url,tabId,completionKey:native.promptKey+'|'+native.assistantKey,promptKey:native.promptKey,
      userId:native.userId,response:native.goalResponse||'',rawExact:native.goalRawExact===true,nativeVerified:true});
  return {ok:true,pending:false};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if(message?.type==='CHATGPT_GOAL_SUPPLEMENT_BIND') {
    const url=messageChatUrl(message,sender);
    if(!url){sendResponse?.({ok:false});return false;}
    bindNativeManualSupplement(sender.tab.id,url).then(sendResponse).catch(()=>sendResponse?.({ok:false,pending:true}));return true;
  }
  if(message?.type==='CHATGPT_GOAL_INLINE') {
    const tabId=sender.tab?.id,source=ChatGPTGoalPolicy.pageUrl(sender.tab?.url);
    const requested=ChatGPTGoalPolicy.pageUrl(message.url);
    const actions=['get','arm','disarm','intent','bind','start','pause','resume','stop'];
    if(sender.frameId>0||typeof tabId!=='number'||!source||!requested||!actions.includes(message.action)) {
      sendResponse?.({ok:false,error:'Goal chat binding mismatch'});return false;
    }
    (async()=>{
      const live=ChatGPTGoalPolicy.pageUrl((await chrome.tabs.get(tabId)).url);
      const pending=await goalController.composerGet({tabId});
      const allocatedIntent=['intent','bind'].includes(message.action)&&requested==='https://chatgpt.com/'&&
        pending?.url===requested&&Boolean(ChatGPTGoalPolicy.canonical(live));
      if((source!==requested||live!==requested)&&!allocatedIntent)throw Error('Чат изменился');
      let result;
      if(message.action==='bind')return bindNativeComposerGoal(tabId,live,message.armId);
      if(message.action==='get'&&pending?.phase==='intent'&&ChatGPTGoalPolicy.canonical(live))
        return bindNativeComposerGoal(tabId,live,pending.id);
      if(message.action==='arm')result=await goalController.composerArm({tabId,url:live,rules:message.rules,
        maxContinuations:message.maxContinuations,maxMinutes:message.maxMinutes});
      else if(message.action==='disarm')result=await goalController.composerDisarm({tabId,armId:message.armId});
      else if(message.action==='intent')result=await goalController.composerIntent({tabId,url:requested,
        armId:message.armId,eventAt:message.eventAt,text:message.text,baselineKey:message.baselineKey});
      else if(message.action==='start') {
        if(!ChatGPTGoalPolicy.canonical(live))throw Error('Используйте Goal рядом с полем нового сообщения');
        return {...await goalController.start({url:live,tabId,goal:message.goal,rules:message.rules,
          maxContinuations:message.maxContinuations,maxMinutes:message.maxMinutes}),tabId,url:live};
      } else if(message.action!=='get') {
        if(!ChatGPTGoalPolicy.canonical(live))throw Error('Goal ещё ожидает первое сообщение');
        return {...await goalController.control({action:message.action,url:live,tabId}),tabId,url:live};
      }
      if(result?.ok===false)return result;
      const url=ChatGPTGoalPolicy.canonical(live);
      if(message.action==='get'&&url&&typeof reconcileNativeGoalAcknowledgement==='function')
        await reconcileNativeGoalAcknowledgement(tabId,url);
      if(message.action==='get'&&url&&typeof reconcileAcceptedHandoffGoal==='function')
        await reconcileAcceptedHandoffGoal(tabId,url);
      if(message.action==='get'&&url&&typeof reconcileGoalPreparation==='function')
        await reconcileGoalPreparation(tabId,url);
      return {ok:true,tabId,url:live,record:url?await goalController.get(url):null,
        composer:result?.record||await goalController.composerGet({tabId})};
    })().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));return true;
  }
  if(message?.type==='CHATGPT_GOAL_CONTROL') {
    if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html')) {
      sendResponse?.({ok:false,error:'Goal управляется только из popup расширения'});
      return false;
    }
    (async()=>{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const url=ChatGPTGoalPolicy.canonical(tab?.url);
      if(typeof tab?.id!=='number'||!url)throw Error('Откройте сохранённый чат ChatGPT');
      if(message.action==='get')return {ok:true,record:await goalController.get(url),tabId:tab.id,url};
      if(message.expectedTabId!==tab.id||message.expectedUrl!==url)
        throw Error('Активный чат изменился после открытия popup; откройте меню расширения ещё раз');
      if(message.action==='start')return goalController.start({url,tabId:tab.id,goal:message.goal,rules:message.rules,
        maxContinuations:message.maxContinuations,maxMinutes:message.maxMinutes});
      return goalController.control({action:message.action,url,tabId:tab.id});
    })().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if(['CHATGPT_GOAL_CONTEXT','CHATGPT_GOAL_CHECK','CHATGPT_GOAL_INTENT',
      'CHATGPT_GOAL_STATUS','CHATGPT_GOAL_MANUAL','CHATGPT_GOAL_RECOVER'].includes(message?.type)) {
    const tabId=sender.tab?.id,url=ChatGPTGoalPolicy.canonical(sender.tab?.url);
    if(sender.frameId>0||typeof tabId!=='number'||!url||
        ChatGPTGoalPolicy.canonical(message.url)!==url) {
      sendResponse?.({ok:false,error:'Goal chat binding mismatch'});
      return false;
    }
    (async()=>{
      if(ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
      if(message.type==='CHATGPT_GOAL_RECOVER'){await bindNativeManualSupplement(tabId,url);await reconcileGoalPromptBinding(tabId,url);return goalController.recoverTab({id:tabId,url});}
      if(message.type==='CHATGPT_GOAL_CONTEXT'){await bindNativeManualSupplement(tabId,url);return {ok:true,text:await goalController.context(url)};}
      if(message.type==='CHATGPT_GOAL_CHECK')return goalController.check({
        url,tabId,id:message.goalId,operationId:message.operationId});
      if(message.type==='CHATGPT_GOAL_INTENT')return goalController.intent({
        url,tabId,id:message.goalId,operationId:message.operationId,text:message.text,baselineKey:message.baselineKey});
      if(message.type==='CHATGPT_GOAL_STATUS'&&message.status==='confirmed')return confirmNativeGoalSend({
        url,tabId,id:message.goalId,operationId:message.operationId,requestId:message.requestId,startedAt:message.startedAt});
      if(message.type==='CHATGPT_GOAL_STATUS')return goalController.report({
        url,tabId,id:message.goalId,operationId:message.operationId,status:message.status,
        reason:message.reason,newPromptKey:message.newPromptKey});
      return goalController.manual({url,tabId});
    })().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));
    return true;
  }
  if (['CHATGPT_HANDOFF_TITLE_INFO','CHATGPT_HANDOFF_RENAME_RECOVER'].includes(message?.type)) {
    if (sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('popup.html')) {
      sendResponse({ok:false,reason:'Восстановление доступно только из меню расширения'});
      return false;
    }
    (async()=>{
      const unavailable=()=>message.type==='CHATGPT_HANDOFF_TITLE_INFO'?{ok:true,available:false}:
        {ok:false,reason:'Восстановление больше недоступно; откройте меню расширения заново'};
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const targetUrl=ChatGPTHandoffTitle.chatUrl(tab?.url);
      if(typeof tab?.id!=='number'||!targetUrl)return unavailable();
      const record=(await chrome.storage.local.get(handoffKey(tab.id)))[handoffKey(tab.id)];
      let alias='';
      try {
        const oldTarget=new URL(record?.targetUrl);
        const match=oldTarget.pathname.match(/^\/c\/([^/]+)\/?$/);
        const value=match&&decodeURIComponent(match[1]);
        if(oldTarget.origin==='https://chatgpt.com'&&/^local-chatgpt:[a-z0-9-]+$/.test(value||''))alias=value;
      } catch {}
      if(typeof record?.id!=='string'||!record.id||record.stage!=='sent'||record.titleStatus!=='failed'||!alias||
          record.titleReason!=='Открыт другой чат; переименование отменено'||
          Object.hasOwn(record,'previousTitle')||Object.hasOwn(record,'titleSaveStartedAt'))return unavailable();
      try {ChatGPTHandoffTitle.confirm(record.naming,targetUrl);} catch {return unavailable();}
      const info={ok:true,available:true,operationId:record.id,tabId:tab.id,targetUrl,desiredTitle:record.naming.title};
      if(message.type==='CHATGPT_HANDOFF_TITLE_INFO')return info;
      // Bind the explicit click to the title and destination shown by this
      // popup. A switched tab or replaced handoff needs a fresh user action.
      if(message.operationId!==info.operationId||message.tabId!==info.tabId||message.targetUrl!==info.targetUrl||message.desiredTitle!==info.desiredTitle) {
        return {ok:false,reason:'Чат или название изменились; откройте меню расширения заново'};
      }
      return renameSavedHandoff(tab.id,record.id,{recoverTemporaryTarget:true});
    })().then(sendResponse).catch(error=>sendResponse({ok:false,reason:String(error.message||error)}));
    return true;
  }
  if (message?.type==='CHATGPT_RETRY_STATE') {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId>0 || !message.url?.startsWith('https://chatgpt.com/')) return;
    const url=retryDraftUrl(message.url);
    if(!url||retryDraftUrl(sender.tab.url)!==url)return;
    recoverNoClickRetry(sender.tab.id,url).then(state=>sendResponse({ok:true,state})).catch(error=>sendResponse({ok:false,error:String(error.message||error)}));
    return true;
  }
  if(['CHATGPT_RETRY_DRAFT_GET','CHATGPT_RETRY_DRAFT_CLAIM'].includes(message?.type)) {
    const url=retryDraftUrl(message.url),tabId=sender.tab?.id;
    if(sender.frameId>0||typeof tabId!=='number'||!url||retryDraftUrl(sender.tab.url)!==url){sendResponse?.({ok:false});return false;}
    (async()=>{
      if(retryDraftUrl((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
      if(message.type==='CHATGPT_RETRY_DRAFT_GET')return {ok:true,record:await readRetryDraft(url)};
      return claimRetryDraft(url,message.operationId,message.savedSequence,sender.tab);
    })().then(sendResponse).catch(()=>sendResponse?.({ok:false,claimed:false}));
    return true;
  }
  if (message?.type==='CHATGPT_HANDOFF_RENAME') {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId>0) return;
    renameSavedHandoff(sender.tab.id,message.id).then(sendResponse).catch(error=>sendResponse({ok:false,reason:String(error.message||error)}));
    return true;
  }
  if (message?.type === 'CHATGPT_WAIT') {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId > 0) return;
    const delay = Number.isFinite(message.delayMs) ? Math.max(20,Math.min(3000,message.delayMs)) : 250;
    setTimeout(()=>sendResponse({ok:true}),delay);
    return true;
  }
  if (message?.type === 'CHATGPT_STOP_RECOVERY') {
    const url=messageChatUrl(message,sender);
    if(!url||!message.operationId||typeof message.promptKey!=='string'||!message.promptKey||typeof message.attemptId!=='string'){
      sendResponse?.({ok:false,reason:'Не подтверждён запрос для остановки'});return false;
    }
    const refuse=async reason=>{await appendJournal({kind:'recovery.stop_refused',operationId:message.operationId,sourceUrl:url,attemptId:message.attemptId,requestId:message.requestId,reason},sender.tab);return {ok:false,reason};};
    const matches=request=>!request||String(request.startedAt)===message.attemptId&&(!request.requestId||request.requestId===message.requestId)&&(!request.url||request.url===url);
    (async()=>{
      const initial=await latestRequestReceipt(sender.tab.id);
      if(!matches(initial))return refuse('Запрос перед остановкой изменился');
      await appendJournal({kind:'recovery.stop_intent',operationId:message.operationId,sourceUrl:url,attemptId:message.attemptId,requestId:message.requestId,promptKey:message.promptKey,recoveryBinding:message.recoveryBinding||null},sender.tab);
      const [runtime]=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'ISOLATED',func:()=>({attemptId:globalThis.__chatgptNotifierAttemptId||'',requestId:globalThis.__chatgptNotifierRequestId||null})});
      const tab=await chrome.tabs.get(sender.tab.id),current=manualRequestReceiptsByTab.get(sender.tab.id)||null;
      if(ChatGPTHandoffTitle.chatUrl(tab.url)!==url||current!==initial||!matches(current)||
          runtime?.result?.attemptId!==message.attemptId||(runtime.result.requestId||null)!==(message.requestId||null))return refuse('Запрос перед остановкой изменился');
      const results=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:inspectChatError,
        args:[message.alertIndex,false,'stop-recovery',message.url,message.promptKey,message.recoveryBinding||null]});
      const result=results[0]?.result || {ok:false,reason:'Нет подтверждения остановки'};
      await appendJournal({kind:result.ok&&(result.stopped===true||result.idle===true)?'recovery.stop_result':'recovery.stop_refused',operationId:message.operationId,attemptId:message.attemptId,requestId:message.requestId,stopped:result.stopped,idle:result.idle,proof:result.proof,recoveryBinding:result.recoveryBinding,reason:result.reason},sender.tab);
      return result;
    })().then(sendResponse).catch(error=>sendResponse({ok:false,reason:String(error.message || error)}));
    return true;
  }
  if (message?.type === 'CHATGPT_COMPOSER_CONTROL') {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId > 0) return;
    let pageDispatchStarted=false;
    let retryBinding=null;
    (async () => {
      const options = message.options;
      if (!['inspect','inspect-mode','send'].includes(options?.action)) throw new Error('Неизвестное действие редактора');
      if (options.action === 'send') {
        const meta = (await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
        const active = meta?.active?.[sender.tab.id];
        if (!active || active.operationId !== options.operationId || Date.now() - active.at > 15000) throw new Error('Нет сохранённого разрешения на эту автоматическую отправку');
        if (active.kind === 'retry.send_intent') {
          if (options.text !== 'доделай е2е' || options.fileName || options.requireMax || options.expectedEffort !== undefined || options.expectedModel !== undefined) throw new Error('Автоповтор может отправлять только команду «доделай е2е»');
          if(!active.sourceUrl||active.sourceUrl!==retryDraftUrl(options.url)||typeof active.promptKey!=='string'||!active.promptKey)throw new Error('Исходный запрос автоповтора не подтверждён');
          retryBinding={sourceUrl:active.sourceUrl,promptKey:active.promptKey};
        } else if (active.kind === 'goal.send_intent') {
          if(options.requireMax||options.expectedEffort!==undefined||options.expectedModel!==undefined||options.fileName)throw new Error('Goal не разрешает вложения или смену уровня модели');
          const grant=await goalController.authorize({url:options.url,tabId:sender.tab.id,
            id:active.goalId,operationId:options.operationId,text:options.text});
          if(!grant?.ok)throw new Error('Goal более не разрешает отправку');
        } else if (active.kind === 'handoff.sending') {
          const key = handoffKey(sender.tab.id);
          const record = (await chrome.storage.local.get(key))[key];
          if (!record || record.stage !== 'sending' || record.id !== options.operationId || record.prompt !== options.text || typeof record.reasoningEffort !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(record.reasoningEffort) || options.expectedEffort !== record.reasoningEffort || typeof record.reasoningModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(record.reasoningModel) || options.expectedModel !== record.reasoningModel || options.requireMax ||
              (options.fileName || null) !== (record.asFile ? record.fileName : null)) throw new Error('Текст не совпадает с сохранённой передачей');
        } else throw new Error('Отправка пользовательского черновика запрещена');
        await appendJournal({kind:'send.authorized',operationId:options.operationId,text:options.text,sourceUrl:options.url},sender.tab);
        if(active.kind==='goal.send_intent'){
          const fresh=await goalController.authorize({url:options.url,tabId:sender.tab.id,
            id:active.goalId,operationId:options.operationId,text:options.text});
          if(!fresh?.ok)throw new Error('Goal приостановлен перед отправкой');
        }
      }
      pageDispatchStarted=options.action==='send';
      return chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:controlChatComposer,args:[options]});
    })()
      .then(async results=>{
        const result=results[0]?.result || {ok:false,unknown:pageDispatchStarted,reason:'Редактор недоступен'};
        if(pageDispatchStarted&&retryBinding&&result.ok===false&&!result.clicked&&!result.unknown) {
          await appendJournal({kind:'send.not_clicked',operationId:message.options.operationId,...retryBinding},sender.tab);
        }
        if(result.clicked) {
          // Preserve the actual native serialization, independently of the
          // content-script lifetime. A missing reply never authorizes a resend.
          try {
            const stored=(await chrome.storage.local.get(handoffKey(sender.tab.id)))[handoffKey(sender.tab.id)];
            if(stored?.id===message.options.operationId&&['sending','awaiting-confirmation'].includes(stored.stage)) {
              await handleHandoffMessage({type:'HANDOFF_CLICK_RECEIPT',id:stored.id,receipt:{operationId:stored.id,
                submittedText:result.submittedText,clickedAt:result.clickedAt,sendUrl:message.options.url,conversationAlias:result.conversationAlias||''}},sender.tab.id);
            }
          } catch {result.receiptError=true;}
          try {await appendJournal({kind:'send.dispatched',operationId:message.options.operationId,sourceUrl:message.options.url,
            text:result.submittedText,requestedText:message.options.text,promptChars:result.promptChars},sender.tab);}
          catch {result.auditError=true;}
        }
        sendResponse(result);
      })
      .catch(error=>sendResponse({ok:false,unknown:pageDispatchStarted,...(error.code==='RETRY_DUPLICATE'?{duplicate:true}:{}),reason:String(error.message || error)}));
    return true;
  }
  if (message?.type === 'CHATGPT_JOURNAL_READ') {
    if (sender.tab?.url?.startsWith('https://chatgpt.com/')) return;
    readJournal().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error.message || error)}));
    return true;
  }
  if (message?.type === 'CHATGPT_LOG_EVENT') {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId > 0) return;
    const event = message.event;
    if (!event || typeof event.kind !== 'string') return;
    if(['retry.manual_reset','retry.preparation_superseded','retry.preparation_recovered'].includes(event.kind)) {
      sendResponse({ok:false,error:'Сброс требует подтверждённой ручной отправки'});return false;
    }
    const prepareEvent=async()=>{
      if(event.kind!=='retry.planned'||!chrome.scripting?.executeScript||typeof inspectCompletedTurn!=='function')return event;
      const url=ChatGPTHandoffTitle.chatUrl(event.sourceUrl||sender.tab.url);
      const [checked]=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',
        func:inspectCompletedTurn,args:[url]});
      const native=checked?.result;
      if(!native?.ok||native.isLatest!==true||native.isReadOnly!==false||
          !native.userId||native.promptKey!==event.promptKey||
          ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(sender.tab.id)).url)!==url)
        return event; // Legacy/temporarily unavailable native data retains the existing guarded claim.
      return {...event,retryUserId:native.userId};
    };
    prepareEvent().then(verified=>appendJournal(verified,sender.tab)).then(async result=>{
      if(!result.superseded&&['retry.planned','retry.confirmed','retry.failed','retry.blocked','draft.restore_failed'].includes(event.kind)) {
        const observed=event.kind==='retry.confirmed'?await latestRequestReceipt(sender.tab.id):null;
        const confirmedAttempt=observed?.operationId===event.operationId&&Number.isFinite(observed.startedAt)
          ?String(observed.startedAt):event.attemptId;
        await goalController.retry({url:event.sourceUrl||sender.tab.url,tabId:sender.tab.id,kind:event.kind,
          promptKey:event.newPromptKey,attemptId:confirmedAttempt,goalHandoff:event.goalHandoff===true});
      }
      sendResponse(result);
    }).catch(error=>sendResponse({ok:false,...(error.code==='RETRY_DUPLICATE'?{duplicate:true}:{}),error:String(error.message || error)}));
    return true;
  }
  if (message?.type === 'CHATGPT_INSPECT_HANDOFF_SEED') {
    const tabId=sender.tab?.id;
    if(sender.frameId>0||typeof tabId!=='number'||typeof message.url!=='string'||typeof message.text!=='string') {
      sendResponse?.({ok:false});return false;
    }
    (async()=>{
      const live=(await chrome.tabs.get(tabId)).url;
      const record=(await chrome.storage.local.get(handoffKey(tabId)))[handoffKey(tabId)];
      if(live!==message.url||sender.tab.url!==live||!live.startsWith('https://chatgpt.com/')||
          !record||record.id!==message.id||!['navigating','preparing'].includes(record.stage)||
          live===record.sourceUrl||typeof record.lastUserText!=='string'||!record.lastUserText||
          record.targetUrl&&record.targetUrl!==live)return {ok:false};
      const fileName=message.allowHistoryFile===true&&record.asFile?record.fileName:null;
      const [result]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatComposer,
        args:[{action:'inspect-seed',url:live,text:message.text,nativeText:record.lastUserText,fileName}]});
      const current=(await chrome.storage.local.get(handoffKey(tabId)))[handoffKey(tabId)];
      if((await chrome.tabs.get(tabId)).url!==live||current?.id!==record.id||
          !['navigating','preparing'].includes(current.stage))return {ok:false};
      return result?.result||{ok:false};
    })().then(sendResponse).catch(()=>sendResponse({ok:false}));
    return true;
  }
  if (message?.type === 'CHATGPT_INSPECT_ATTACHMENT') {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId > 0) return;
    chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN',
      func: inspectChatAttachment, args: [message.fileName]
    }).then((results) => sendResponse({ ok: true, ...results[0]?.result }))
      .catch(() => sendResponse({ ok: false, status: 'unknown' }));
    return true;
  }
  if (message?.type === 'CHATGPT_INSPECT_ERROR') {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId > 0) return;
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id }, world: 'MAIN', func: inspectChatError,
      args: [message.alertIndex, Boolean(message.captureHistory),null,'','',null,Boolean(message.captureRetryHistory)]
    }).then((results) => sendResponse({ ok: true, ...results[0]?.result }))
      .catch(() => sendResponse({ ok: false, action: 'unknown' }));
    return true;
  }
  if (['CHATGPT_HANDOFF_GET', 'CHATGPT_HANDOFF_BEGIN', 'CHATGPT_HANDOFF_UPDATE','CHATGPT_HANDOFF_RECONCILE','CHATGPT_HANDOFF_DRAFT_CLAIM'].includes(message?.type)) {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId > 0) return;
    handleHandoffMessage(message, sender.tab.id).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === 'CHATGPT_HANDOFF_DOWNLOAD') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      const record = (await chrome.storage.local.get(handoffKey(tab.id)))[handoffKey(tab.id)];
      sendResponse({ ok: Boolean(record), text: record?.text || '', draft: record?.draft || '' });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if(message?.type==='CHATGPT_RECONCILE_LEGACY_HANDOFF_STATUS') {
    const url=messageChatUrl(message,sender);
    if(!url){sendResponse?.({ok:false});return false;}
    reconcileLegacyHandoffStatus(sender.tab.id,url).then(view=>sendResponse?.({ok:true,changed:Boolean(view),...(view||{})})).catch(()=>sendResponse?.({ok:false}));
    return true;
  }
  if(message?.type==='CHATGPT_RECONCILE_FAILED_COMPLETION') {
    const url=messageChatUrl(message,sender);
    if(!url){sendResponse?.({ok:false});return false;}
    reconcileFailedCompletionLoading(sender.tab.id,url).then(value=>sendResponse?.({ok:true,...value})).catch(()=>sendResponse?.({ok:false}));
    return true;
  }
  if(message?.type==='CHATGPT_COMPLETION_CHECKPOINT') {
    const tabId=sender.tab?.id,url=completionCheckpointUrl(sender.tab?.url);
    if(sender.frameId>0||typeof tabId!=='number'||!url||completionCheckpointUrl(message.url)!==url){sendResponse?.({ok:false});return false;}
    (async()=>{
      if(message.action==='intent')return {ok:await completionCheckpointIntent(tabId,{url,baselineKey:message.baselineKey,at:message.at})};
      if(message.action==='update')return {ok:await completionCheckpointUpdate(tabId,{url,startedAt:message.startedAt,requestId:message.requestId,baselineKey:message.baselineKey,promptKey:message.promptKey,httpCompleted:message.httpCompleted})};
      const rollback=await reconcileFailedCompletionLoading(tabId,url);
      if(rollback.changed)return {ok:false,rollback};
      let record=await completionCheckpointRead(tabId);
      if(record?.state==='active'&&record.baselineKey===null) {
        const view=await readChatStatus(url),known=await latestRequestReceipt(tabId);
        if(view.status?.kind!=='loading'||view.status.eventAt!==record.startedAt||
            !known||known.startedAt!==record.startedAt||known.requestId!==record.requestId||
            completionCheckpointUrl((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
        const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
          func:inspectCompletedTurn,args:[url]});
        const native=checked?.result;
        if(!native?.ok||native.url!==url||native.isLatest!==true||native.isReadOnly!==false||
            native.turnStatus!=='in_progress'||native.generating!==true||native.hasError||
            !native.promptKey||!native.userId)return {ok:false};
        const fresh=await latestRequestReceipt(tabId),status=await readChatStatus(url);
        if(fresh?.requestId!==known.requestId||fresh.startedAt!==known.startedAt||
            status.status?.kind!=='loading'||status.status.eventAt!==record.startedAt||
            completionCheckpointUrl((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
        const rebound={...record,url,baselineKey:'',promptKey:native.promptKey};
        if(!await completionCheckpointChange(tabId,current=>JSON.stringify(current)===JSON.stringify(record)?
            {record:rebound,value:true}:{value:false}))return {ok:false};
        record=rebound;
      }
      if(!record||record.state!=='active'||typeof record.baselineKey!=='string')return {ok:false};
      const view=await readChatStatus(url),tab=await chrome.tabs.get(tabId);
      const request=await latestRequestReceipt(tabId);
      if(completionCheckpointUrl(tab.url)!==url||view.status?.kind!=='loading'||view.status.eventAt!==record.startedAt||request&&(request.startedAt!==record.startedAt||request.requestId!==record.requestId))return {ok:false};
      if(record.url!==url){
        const initial=manualRequestReceiptsByTab.get(tabId);
        const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url]});
        const allocation=completionAllocationEvidence(record,url,checked?.result);
        if(!allocation)return {ok:false,pending:record.url==='https://chatgpt.com/'&&record.baselineKey===''&&!record.promptKey&&
          ['turn-missing','native-turn-missing','bound-messages-missing'].includes(checked?.result?.reason)};
        const live=await readChatStatus(url),current=await completionCheckpointRead(tabId);
        if(manualRequestReceiptsByTab.get(tabId)!==initial||
            live.revision!==view.revision||live.status?.kind!=='loading'||live.status.eventAt!==record.startedAt||
            completionCheckpointUrl((await chrome.tabs.get(tabId)).url)!==url||JSON.stringify(current)!==JSON.stringify(record))return {ok:false};
        if(!await completionCheckpointUpdate(tabId,{...allocation,startedAt:record.startedAt,requestId:record.requestId}))return {ok:false};
        record={...record,...allocation};
        journalInBackground({kind:'completion.url_allocated',sourceUrl:url,requestId:record.requestId,attemptId:record.attemptId,promptKey:record.promptKey},{id:tabId,url});
      }
      if(record.promptKey?.includes('|fallback-turn-')) {
        const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
          func:inspectCompletedTurn,args:[url]});
        const rebound=completionPromptRebindEvidence(record,url,checked?.result);
        if(rebound) {
          const latest=await latestRequestReceipt(tabId),live=await readChatStatus(url);
          if(latest&&(latest.startedAt!==record.startedAt||latest.requestId!==record.requestId)||
              live.status?.kind!=='loading'||live.status.eventAt!==record.startedAt||
              completionCheckpointUrl((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
          const changed=await completionCheckpointChange(tabId,current=>
            JSON.stringify(current)===JSON.stringify(record)?
              {record:{...current,...rebound},value:true}:{value:false});
          if(!changed)return {ok:false};
          record={...record,...rebound};
          journalInBackground({kind:'completion.prompt_rebound',sourceUrl:url,attemptId:record.attemptId,
            promptKey:record.promptKey,proof:'native-user-time'}, {id:tabId,url});
        }
      }
      const current=await completionCheckpointRead(tabId);
      if(current?.state!=='active'||current.startedAt!==record.startedAt||current.requestId!==record.requestId||current.url!==url)return {ok:false};
      return {ok:true,record:{...record,receipt:request?.receipt||view.status.receipt}};
    })().then(sendResponse).catch(()=>sendResponse?.({ok:false}));return true;
  }
  if(message?.type==='CHATGPT_COMPLETION_PROBE') {
    const url=messageChatUrl(message,sender),initial=manualRequestReceiptsByTab.get(sender.tab?.id);
    if(!url||!Number.isFinite(message.startedAt)||message.startedAt<=0||initial&&(initial.startedAt!==message.startedAt||initial.requestId&&initial.requestId!==message.requestId||initial.url&&initial.url!==url&&initial.url!=='https://chatgpt.com/')){
      sendResponse?.({ok:false,reason:'attempt-changed'});return false;
    }
    (async()=>{
      // A worker upgrade loses the in-memory request map. Recover UI observation
      // from the same durable loading generation and live native progress. An
      // already-bound content watcher may also prove its exact final answer.
      const before=initial?null:await readChatStatus(url);
      const checkpoint=await completionCheckpointRead(sender.tab.id);
      if(checkpoint&&(checkpoint.state!=='active'||checkpoint.startedAt!==message.startedAt||checkpoint.requestId&&checkpoint.requestId!==message.requestId||checkpoint.url!==url))return {ok:false,reason:'checkpoint-changed'};
      if(initial?.url==='https://chatgpt.com/'&&(!checkpoint?.promptKey||
          checkpoint.promptKey!==message.boundPromptKey||checkpoint.baselineKey!==''))return {ok:false,reason:'allocation-unbound'};
      if(!initial&&(before.status?.kind!=='loading'||before.status.eventAt!==message.startedAt))return {ok:false,reason:'attempt-changed'};
      const results=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:inspectCompletedTurn,args:[url]});
      const native=results[0]?.result||{ok:false,reason:'native-turn-missing'};
      const tab=await chrome.tabs.get(sender.tab.id);
      if(manualRequestReceiptsByTab.get(sender.tab.id)!==initial||ChatGPTHandoffTitle.chatUrl(tab.url)!==url)return {ok:false,reason:'attempt-changed'};
      if(!initial){
        const liveProgress=native.turnStatus==='in_progress'&&native.generating===true;
        const boundFinal=typeof message.boundPromptKey==='string'&&message.boundPromptKey&&message.boundPromptKey===native.promptKey&&
          native.turnStatus==='complete'&&native.generating===false&&native.assistantCompleted===true&&
          native.assistantPhase==='final_answer'&&Boolean(native.assistantId)&&Boolean(native.assistantKey);
        const boundReasoningFailure=checkpoint?.state==='active'&&checkpoint.promptKey===message.boundPromptKey&&
          native.promptKey===checkpoint.promptKey&&native.reasoningFailed===true&&native.generating===false;
        if(!native.ok||(!liveProgress&&!boundFinal&&!boundReasoningFailure)||native.isLatest!==true||native.isReadOnly!==false||native.hasError!==false||!native.promptKey||!native.userId)return {ok:false,reason:'unbound-existing-request'};
        const runtime=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'ISOLATED',func:()=>({attempt:globalThis.__chatgptNotifierAttemptId,startedAt:globalThis.__chatgptNotifierRequestStartedAt})});
        const current=await readChatStatus(url);
        if(runtime[0]?.result?.attempt!==String(message.startedAt)||runtime[0]?.result?.startedAt!==message.startedAt||
            current.revision!==before.revision||current.status?.kind!=='loading'||current.status.eventAt!==message.startedAt||
            manualRequestReceiptsByTab.has(sender.tab.id)||ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(sender.tab.id)).url)!==url)return {ok:false,reason:'attempt-changed'};
        if(manualRequestReceiptsByTab.has(sender.tab.id))return {ok:false,reason:'attempt-changed'};
        manualRequestReceiptsByTab.set(sender.tab.id,{startedAt:message.startedAt,requestId:checkpoint?.requestId||null,receipt:current.status.receipt,url,consumed:true,recoveredPromptKey:native.promptKey});
        journalInBackground({kind:'completion.request_recovered',attemptId:String(message.startedAt),sourceUrl:url,promptKey:native.promptKey,proof:boundFinal?'bound-native-final':'native-progress'},sender.tab);
      }
      const bound=manualRequestReceiptsByTab.get(sender.tab.id);
      if(message.boundPromptKey&&message.boundPromptKey!==native.promptKey)return {ok:false,reason:'prompt-changed'};
      if(bound?.recoveredPromptKey&&bound.recoveredPromptKey!==native.promptKey)return {ok:false,reason:'prompt-changed'};
      if(!checkpoint&&native.ok&&native.turnStatus==='in_progress'&&native.generating===true&&native.isLatest===true&&native.isReadOnly===false&&!native.hasError&&native.promptKey){
        const view=await readChatStatus(url),request=manualRequestReceiptsByTab.get(sender.tab.id);
        if(view.status?.kind==='loading'&&view.status.eventAt===message.startedAt&&request?.startedAt===message.startedAt){
          await completionCheckpointChange(sender.tab.id,current=>current?{value:false}:{record:{schema:1,state:'active',url,startedAt:message.startedAt,attemptId:String(message.startedAt),requestId:request.requestId||null,baselineKey:'',promptKey:native.promptKey,httpCompleted:false},value:true});
        }
      }
      return native;
    })().then(sendResponse).catch(()=>sendResponse?.({ok:false,reason:'probe-unavailable'}));
    return true;
  }
  if (['CHATGPT_RESPONSE_COMPLETE','CHATGPT_RESPONSE_ERROR','CHATGPT_OPERATION_WARNING'].includes(message?.type)) {
    const isWarning=message.type==='CHATGPT_OPERATION_WARNING';
    const isError = message.type === 'CHATGPT_RESPONSE_ERROR';
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/')||sender.frameId>0) return;
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return;
    // Capture the conversation before any notification or sound awaits. A
    // later SPA route must not reattribute this event to another chat.
    const receipt=statusReceipt(),eventAt=Date.now();
    void (async()=>{
    let sourceUrl=ChatGPTHandoffTitle.chatUrl(sender.tab.url),movedWarning=false;
    if(message.url&&ChatGPTHandoffTitle.chatUrl(message.url)!==sourceUrl){
      if(!isWarning)return;
      const target=ChatGPTHandoffTitle.chatUrl(message.url);
      const saved=(await chrome.storage.local.get(handoffKey(tabId)))[handoffKey(tabId)];
      if(!target||!message.operationId||saved?.id!==message.operationId||ChatGPTHandoffTitle.chatUrl(saved.targetUrl)!==target)return;
      sourceUrl=target;movedWarning=true;
    }
    const completionRequest=isWarning?manualRequestReceiptsByTab.get(tabId)||null:await latestRequestReceipt(tabId);
    if(isError&&message.requestId&&completionRequest?.requestId!==message.requestId)return;
    if(!isError&&!isWarning&&(!completionRequest||completionRequest.startedAt!==message.completionStartedAt||
        String(completionRequest.startedAt)!==message.attemptId||
        completionRequest.requestId&&message.requestId!==completionRequest.requestId)){
      journalInBackground({kind:'completion.delivery_refused',sourceUrl,attemptId:message.attemptId,
        reason:!completionRequest?'missing-request':completionRequest.startedAt!==message.completionStartedAt?'request-time-changed':
          String(completionRequest.startedAt)!==message.attemptId?'attempt-changed':'request-id-changed'},sender.tab);
      return;
    }

    if(!isError&&!isWarning&&completionRequest.url&&completionRequest.url!==sourceUrl) {
      // The first request can start on the empty composer. Its durable
      // checkpoint adopts the permanent URL only after native turn binding.
      if(completionRequest.url!=='https://chatgpt.com/'||!sourceUrl||message.goalNativeVerified!==true)return;
      const allocated=await completionCheckpointRead(tabId);
      if(allocated?.state!=='active'||allocated.url!==sourceUrl||allocated.baselineKey!==''||
          allocated.startedAt!==message.completionStartedAt||allocated.requestId!==message.requestId||
          !allocated.promptKey||allocated.promptKey!==message.goalPromptKey||
          ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==sourceUrl||
          await latestRequestReceipt(tabId)!==completionRequest)return;
    }

    const fingerprint = String(message.fingerprint || '');
    const rawCompletionKey=String(message.completionKey||fingerprint);
    const completionKey = rawCompletionKey?`${sourceUrl}|${rawCompletionKey}`:'';
    if (!isError&&!isWarning && completionKey && lastNotificationFingerprintByTab.get(tabId) === completionKey) return;
    if (!isError&&!isWarning && completionKey) lastNotificationFingerprintByTab.set(tabId, completionKey);

    if(!isError&&!isWarning) {
      const goalAnswer={url:sourceUrl,tabId,completionKey:rawCompletionKey,
        promptKey:message.goalPromptKey,response:message.response,nativeVerified:message.goalNativeVerified,
        rawExact:message.goalRawExact,userId:message.goalNativeUserId};
      try {
        await reconcileNativeGoalAcknowledgement(tabId,sourceUrl);
        await bindNativeManualSupplement(tabId,sourceUrl);
        const armed=await goalController.composerGet({tabId});
        if(armed?.phase==='intent')await bindNativeComposerGoal(tabId,sourceUrl,armed.id);
        if(goalAnswer.nativeVerified===true&&typeof message.response==='string'&&
            !goalAnswer.rawExact&&message.response.startsWith(ChatGPTGoalPolicy.MARKER)) {
          const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
            func:inspectCompletedTurn,args:[sourceUrl,true]});
          const native=checked?.result;
          if(native?.ok&&native.isLatest===true&&native.isReadOnly===false&&!native.hasError&&!native.generating&&
              native.turnStatus==='complete'&&native.assistantCompleted===true&&native.assistantPhase==='final_answer'&&
              native.userId===goalAnswer.userId&&native.promptKey===goalAnswer.promptKey&&
              native.promptKey+'|'+native.assistantKey===rawCompletionKey&&native.goalRawExact===true&&
              native.goalResponse===ChatGPTGoalPolicy.MARKER) {
            goalAnswer.response=native.goalResponse;
            goalAnswer.rawExact=true;
          }
        }
        const handoff=(await chrome.storage.local.get(handoffKey(tabId)))[handoffKey(tabId)];
        if(handoff?.id&&['sending','awaiting-confirmation','sent'].includes(handoff.stage)&&
            ChatGPTGoalPolicy.canonical(handoff.sourceUrl)!==sourceUrl&&
            ChatGPTGoalPolicy.canonical(sourceUrl)) {
          await goalController.stageHandoffCompletion({sourceUrl:handoff.sourceUrl,
            targetUrl:sourceUrl,handoffId:handoff.id,...goalAnswer});
          if(handoff.stage==='sent')await goalController.handoffConfirm({sourceUrl:handoff.sourceUrl,
            targetUrl:sourceUrl,handoffId:handoff.id,tabId,acceptedUserId:handoff.acceptance?.messageId});
        }
        await goalController.completion(goalAnswer);
      } catch(error) { console.error('Goal completion reconciliation failed',error); }
    }
    journalInBackground({kind:isWarning?'operation.warning':isError?'notification.requested':'response.complete', response:message.response,
      sourceUrl,warningKind:message.warningKind,operationId:message.operationId,durationMs:message.durationMs,retryReason:message.retryReason,attemptId:message.attemptId},sender.tab);
    const notification={tabId,title:`${isWarning?'⚠️ ':isError?'❌ ':''}${cleanSessionTitle(message.sessionTitle)}`,
      message:truncateResponse(message.response),isError,isWarning,durationMs:message.durationMs,retryReason:message.retryReason||''};
    if(movedWarning){await emitBoth(notification);return;}
    const reserve=(!isWarning&&!isError?completionCheckpointRead(tabId).then(record=>!record||record.state==='active'&&record.startedAt===message.completionStartedAt&&(!record.requestId||record.requestId===message.requestId)):Promise.resolve(true))
      .then(accepted=>accepted&&sourceUrl?reserveChatNotification(sourceUrl,tabId,isWarning?'warning':isError?'error':'success',eventAt,receipt):null);

    await reserve.then(reserved=>{
      if(!reserved)return;
      if(!isWarning&&!isError){
        const current=reserved.view.status?.receipt;
        if(current?.epoch!==receipt.epoch||current.order!==receipt.order){void completeChatNotification(reserved.ticket,false);return;}
        // Persist terminal status first. If the worker dies between these two
        // writes, that status itself fences checkpoint restoration.
        void completionCheckpointFinish(tabId,message.completionStartedAt,'complete',completionRequest?.requestId).catch(()=>{});
      }
      if(reserved&&!isWarning)void broadcastChatStatus(reserved.view).catch(()=>{});
      // A foreground result is already visible. Only its captured generation
      // is acknowledged; OS dismissal still follows an actual visit event.
      if(reserved&&!isWarning)void seeVisibleResult(sourceUrl,receipt).catch(()=>{});
      return emitBoth({...notification,ticket:reserved.ticket});
    },async error=>{
      console.error('Prompt-Bound Alert: status reservation failed',error);
      // Storage failure must not silence the only alert. Keep this unbound:
      // no invented status or notification receipt, and no fallback resend.
      const tab=await chrome.tabs.get(tabId);
      if(ChatGPTHandoffTitle.chatUrl(tab.url)!==sourceUrl||!isWarning&&(manualRequestReceiptsByTab.get(tabId)||null)!==completionRequest)return;
      await emitBoth(notification);
    });
    })().then(()=>sendResponse?.({ok:true})).catch((error) => {
      console.error('Prompt-Bound Alert: completion alert failed', error);
      sendResponse?.({ok:false});
    });
    return true;
  }

  if(message?.type==='CHATGPT_DEFERRED_PROBE') {
    const url=messageChatUrl(message,sender);
    if(!url){sendResponse?.({ok:false});return false;}
    (async()=>{
      if(ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(sender.tab.id)).url)!==url)return {ok:false};
      const [result]=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:ChatGPTDeferredTaskStatus.inspect,args:[]});
      const snapshot=result?.result;
      if(!snapshot||ChatGPTHandoffTitle.chatUrl(snapshot.url)!==url||ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(sender.tab.id)).url)!==url)return {ok:false};
      return {ok:true,snapshot};
    })().then(sendResponse).catch(()=>sendResponse?.({ok:false}));return true;
  }
  if(message?.type==='CHATGPT_DEFERRED_TASK') {
    const url=messageChatUrl(message,sender),receipt=statusReceipt();
    if(!url){sendResponse?.({ok:false});return false;}
    (async()=>{
      const tab=await chrome.tabs.get(sender.tab.id);
      if(ChatGPTHandoffTitle.chatUrl(tab.url)!==url)return {ok:false};
      const view=await updateDeferredChat(url,message.event||{},receipt);
      journalInBackground({kind:'deferred.'+String(message.event?.phase||'unknown'),sourceUrl:url,cardKey:message.event?.cardKey,anchorKey:message.event?.anchorKey,taskId:message.event?.taskId,reason:message.event?.reason},sender.tab);
      void broadcastChatStatus(view).catch(()=>{});return {ok:true,...view};
    })().then(sendResponse).catch(()=>sendResponse?.({ok:false}));return true;
  }

  if (['CHATGPT_PAGE_RETURNED','CHATGPT_STATUS_GET','CHATGPT_MANUAL_SEND','CHATGPT_GENERATION_STOPPED'].includes(message?.type)) {
    const url=messageChatUrl(message,sender);
    let receipt=statusReceipt();
    if(!url){sendResponse?.({ok:false,reason:'Чат изменился'});return false;}
    if(message.type==='CHATGPT_GENERATION_STOPPED')cancelLegacyHandoffStatus(sender.tab.id);
    (async()=>{
      const tab=await chrome.tabs.get(sender.tab.id);
      if(ChatGPTHandoffTitle.chatUrl(tab.url)!==url)return {ok:false,reason:'Чат изменился'};
      if(message.type==='CHATGPT_MANUAL_SEND') {
        if(!Number.isFinite(message.startedAt))return {ok:false};
        const request=await readRequestReceipt(sender.tab.id,{requestId:message.requestId,startedAt:message.startedAt,url,consume:true});
        if(!request)return {ok:false,reason:'Ручная отправка не подтверждена запросом'};
        receipt=request.receipt;
        await appendJournal({kind:'retry.preparation_superseded',sourceUrl:url,requestId:message.requestId,startedAt:message.startedAt},sender.tab);
        await goalController.manual({url,tabId:sender.tab.id,startedAt:message.startedAt,requestId:message.requestId,
          eventAt:message.eventAt,text:message.text,baselineKey:message.baselineKey});
        void bindNativeManualSupplement(sender.tab.id,url).catch(()=>{});
      }
      if(message.type==='CHATGPT_STATUS_GET'){
        let view=await readChatStatus(url);
        if(message.generating===true&&!view.status&&view.revision===0){
          const request=await latestRequestReceipt(sender.tab.id);
          const known=request?.startedAt===message.startedAt&&(!request.requestId||request.requestId===message.requestId);
          view=await observeChatLoading(url,Number.isFinite(message.startedAt)&&message.startedAt>0?message.startedAt:Date.now(),known?request.receipt:receipt);
        }
        statusAnimation.set(sender.tab.id,url,view.status?.kind==='loading');
        return {ok:true,...view};
      }
      if(message.type==='CHATGPT_GENERATION_STOPPED'){
        const request=await readRequestReceipt(sender.tab.id,{requestId:message.requestId,startedAt:message.startedAt,url});
        const current=await readChatStatus(url);
        const supplied=message.startReceipt;
        const nativeReceipt=!message.requestId&&supplied&&current.status?.kind==='loading'&&current.status.eventAt===message.startedAt&&
          supplied.epoch===current.status.receipt?.epoch&&supplied.order===current.status.receipt?.order?supplied:null;
        const startReceipt=request?.receipt||nativeReceipt;
        if(startReceipt)await completionCheckpointFinish(sender.tab.id,message.startedAt,'stopped',request?.requestId);
        const view=await stopChatLoading(url,message.startedAt,receipt,startReceipt);
        void broadcastChatStatus(view).catch(()=>{});
        return {ok:true,...view};
      }
      if(message.type==='CHATGPT_MANUAL_SEND') {
        const view=await visitChatNotifications(url,receipt,{manual:true,startedAt:message.startedAt});
        void broadcastChatStatus(view).catch(()=>{});
        return {ok:true,...view};
      }
      await visitVisibleChat(sender.tab.id,url,receipt);
      return {ok:true,...await readChatStatus(url)};
    })().then(result=>sendResponse?.(result)).catch(error=>sendResponse?.({ok:false,reason:String(error.message||error)}));
    return true;
  }

  if (message?.type === 'TEST_BOTH') {
    emitBoth({
      isTest: true,
      message: 'If you heard the chime and saw this notification, both output channels work.'
    }).then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void goalController.composerDisarm({tabId}).catch(()=>{});
  journalInBackground({kind:'tab.closed',tabId});
  lastNotificationFingerprintByTab.delete(tabId);
  legacyHandoffStatusFences.delete(tabId);
  manualRequestReceiptsByTab.delete(tabId);
  void forgetRequestReceipts(tabId).catch(()=>{});
  statusAnimation.remove(tabId);
});

async function restoreStatusAnimation() {
  const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
  await Promise.allSettled(tabs.map(async tab=>{
    const url=ChatGPTHandoffTitle.chatUrl(tab.url);
    if(!url)return;
    const current=await chrome.tabs.get(tab.id);
    if(ChatGPTHandoffTitle.chatUrl(current.url)!==url)return;
    const view=await readChatStatus(url);
    statusAnimation.set(tab.id,url,view.status?.kind==='loading');
  }));
}
void restoreStatusAnimation().catch(error=>console.warn('Prompt-Bound Alert: animation recovery failed',error));

chrome.tabs.onActivated?.addListener(({tabId})=>{
  const receipt=statusReceipt();
  void chrome.tabs.get(tabId).then(tab=>visitVisibleChat(tabId,ChatGPTHandoffTitle.chatUrl(tab.url),receipt)).catch(()=>{});
});
chrome.windows?.onFocusChanged?.addListener(windowId=>{
  statusFocusEventSeen=true;
  statusAnimation.setEnabled(windowId>=0);
  if(windowId<0)return;
  const receipt=statusReceipt();
  void chrome.tabs.query({active:true,windowId}).then(([tab])=>tab&&visitVisibleChat(tab.id,ChatGPTHandoffTitle.chatUrl(tab.url),receipt)).catch(()=>{});
});

chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
  if (!tab.url?.startsWith('https://chatgpt.com/')) return;
  if (change.url || change.discarded !== undefined || change.frozen !== undefined) {
    journalInBackground({kind:'tab.updated',changes:change},tab);
  }
  if(change.url)statusAnimation.remove(tabId);
  if(change.url)void chrome.tabs.sendMessage(tabId,{type:'CHATGPT_HANDOFF_ROUTE_CHANGED'}).catch(()=>{});
  if(change.url)void visitVisibleChat(tabId,ChatGPTHandoffTitle.chatUrl(tab.url),statusReceipt()).catch(()=>{});
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const match = /^chatgpt-prompt-bound:(\d+):/.exec(notificationId);
  if (!match) return;
  const tabId = Number(match[1]);
  try {
    const tab = await chrome.tabs.get(tabId);
    const url=ChatGPTHandoffTitle.chatUrl(tab.url);
    if(!url)return;
    await migrateChatStatuses();
    const record=(await chrome.storage.local.get(statusKey(url)))[statusKey(url)];
    if(!record?.notifications?.some(item=>item.id===notificationId))return;
    await chrome.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === 'number') await chrome.windows.update(tab.windowId, { focused: true });
    await visitVisibleChat(tabId,url,statusReceipt());
  } catch (error) {
    console.warn('Prompt-Bound Alert: source tab no longer exists', error);
  } finally {
    chrome.notifications.clear(notificationId).catch(() => {});
  }
});

chrome.notifications.onClosed?.addListener(notificationId=>{
  const match=/^chatgpt-prompt-bound:\d+:\d+:\d+:(.+)$/.exec(notificationId);
  if(!match)return;
  let url;
  try {url=decodeURIComponent(match[1]);}catch{return;}
  if(ChatGPTHandoffTitle.chatUrl(url)!==url)return;
  void closeChatNotification(url,notificationId).catch(()=>{});
});
