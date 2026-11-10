'use strict';
importScripts('page-probe.js');
importScripts('completion-probe.js');
importScripts('reply-probe.js');
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
importScripts('goal-lineage.js');
importScripts('goal-store.js');
importScripts('goal-request-proof.js');
const goalController=ChatGPTGoalStore.create({storage:chrome.storage.local,tabs:chrome.tabs,appendJournal:async(event,tab)=>{
  const result=await appendJournal(event,tab);
  if(event.kind==='goal.marker_pending'&&Number.isInteger(tab?.id))void chrome.tabs.sendMessage(tab.id,{type:'CHATGPT_GOAL_MARKER_PENDING',url:event.sourceUrl}).catch(()=>{});
  return result;
},
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
      if(pending?.phase==='intent'&&pending.request&&pending.request.requestId!==request.requestId)
        await goalController.composerFollowup({tabId:details.tabId,requestId:request.requestId,startedAt:request.startedAt,url:event.sourceUrl,submission:ChatGPTGoalRequestProof.read(details)});
      else if(['armed','intent'].includes(pending?.phase))await goalController.composerRequest({tabId:details.tabId,armId:pending.id,
        requestId:request.requestId,startedAt:request.startedAt,url:event.sourceUrl,submission:ChatGPTGoalRequestProof.read(details)});
      else if(pending?.phase==='bound'&&typeof goalController.composerObserveBlockedRequest==='function')await goalController.composerObserveBlockedRequest({tabId:details.tabId,
        requestId:request.requestId,startedAt:request.startedAt,url:event.sourceUrl,submission:ChatGPTGoalRequestProof.read(details)});
    }
    const url=ChatGPTHandoffTitle.chatUrl(event.sourceUrl);
    if(url)await broadcastChatStatus(await markChatLoading(url,details.timeStamp,receipt));
  }).catch(()=>{});
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    func: (startedAt,requestId,receipt) => { const prior=globalThis.__chatgptNotifierRequestReceipt;if(!(globalThis.__chatgptNotifierRequestStartedAt>startedAt)&&!(prior?.epoch===receipt.epoch&&prior.order>receipt.order)){globalThis.__chatgptNotifierRequestStartedAt = startedAt; globalThis.__chatgptNotifierAttemptId = `${startedAt}`;globalThis.__chatgptNotifierRequestId=requestId;globalThis.__chatgptNotifierRequestReceipt=receipt;} },
    args: [details.timeStamp,request.requestId,receipt]
  }).then(()=>signalConversationRequestEvent(details.tabId,{type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:details.timeStamp,requestId:request.requestId})).catch(() => {});
}, CHATGPT_REQUEST_FILTER, ['requestBody']);

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
    let [probe]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
      func:controlChatComposer,args:[{action:'inspect-empty-handoff',text:'',url:tab.url,fileName:current.asFile?current.fileName:null}]});
    let preservedDraft='';
    if(probe?.result?.ok!==true&&typeof current.lastUserText==='string'&&current.lastUserText&&
        (!current.draft||current.draft===current.lastUserText)) {
      // ChatGPT may seed the new editor with the last submitted message. It
      // could also be an owner's draft: preserve it before replacing the field.
      [probe]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatComposer,
        args:[{action:'inspect-resumable-handoff',text:current.lastUserText,url:tab.url,fileName:current.asFile?current.fileName:null}]});
      if(probe?.result?.ok===true)preservedDraft=current.lastUserText;
    }
    if(probe?.result?.ok!==true)return current;
    // Storage, URL and Goal fences are checked again after the native probe.
    const latest=(await chrome.storage.local.get(key))[key];
    if(latest?.id!==current.id||latest.stage!=='failed'||(await chrome.tabs.get(tabId)).url!==tab.url)return latest;
    const goal=await goalController.handoffPreparationReady({sourceUrl:current.sourceUrl,handoffId:current.id,tabId});
    if(!goal.ok||(await chrome.tabs.get(tabId)).url!==tab.url)return current;
    const record={...current,...(preservedDraft?{draft:preservedDraft}:{}),stage:'navigating',reason:'',preparationRecoveries:(current.preparationRecoveries||0)+1};
    await appendJournal({kind:'handoff.preparation_recovered',operationId:current.id,
      sourceUrl:current.sourceUrl,targetUrl:tab.url,recoveries:record.preparationRecoveries},{id:tabId});
    await chrome.storage.local.set({[key]:record});
    return record;
  });
  handoffWrites.set(tabId,write);
  try{return await write;}finally{if(handoffWrites.get(tabId)===write)handoffWrites.delete(tabId);}
}

// A positively refused pre-navigation action may retry its native navigation,
// never its message send. The same handoff and durable one-click claim survive.
async function recoverHandoffNavigation(tabId,expected) {
  const previous=handoffWrites.get(tabId)||Promise.resolve();
  const work=previous.catch(()=>{}).then(async()=>{
    const key=handoffKey(tabId),h=(await chrome.storage.local.get(key))[key];
    if(h?.id!==expected.id||h.stage!=='failed'||h.reason!=='Кнопка нового чата недоступна'||
        h.sendReceipt||(h.navigationRecoveries||0)>=1)return {ok:false,record:h};
    const t=await chrome.tabs.get(tabId),u=ChatGPTGoalPolicy.canonical(t.url);
    if(u!==h.sourceUrl||t.status!=='complete')return {ok:false,record:h};
    const j=await readJournal();
    if(!j.ok||j.storageError)return {ok:false,record:h};
    if(j.meta?.active?.[tabId]||j.meta?.retryPreparingByChat?.[u]||
        Object.values(j.meta?.active||{}).some(a=>a.chatUrl===u||a.sourceUrl===u))return {ok:false,record:h};
    const own=j.events.filter(e=>e.operationId===h.id),request=await latestRequestReceipt(tabId);
    if(!own.some(e=>e.kind==='handoff.navigating'&&e.sourceUrl===u)||
        !own.some(e=>e.kind==='handoff.failed'&&e.reason===h.reason)||
        own.some(e=>e.kind==='handoff.sending'||e.kind==='handoff.sent'||e.kind==='handoff.awaiting-confirmation'||
          e.kind==='handoff.navigation_intent'||e.kind==='handoff.navigation_clicked'||e.kind==='handoff.clicked'||e.kind.startsWith('send.')||e.kind==='request.started')||
        j.events.some(e=>e.tabId===tabId&&e.kind==='request.started'&&e.recordedAt>=h.createdAt))return {ok:false,record:h};
    const [a]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[u,true]});
    const n=a?.result;
    const [b]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectChatError,args:[0,true]});
    const [c]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatComposer,
      args:[{action:'inspect-plain-retry-draft',url:u,text:h.draft||''}]});
    const p=c?.result;
    if(!n?.ok||n.isLatest!==true||n.isReadOnly!==false||n.generating!==false||!n.hasError||
        b?.result?.action!=='new-chat'||b.result.incomplete||!n.userId||n.userText!==h.lastUserText||
        !p?.ok||!p.matches||p.effort!==h.reasoningEffort||p.model!==h.reasoningModel)return {ok:false,record:h};
    const [fresh]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[u,true]});
    if(JSON.stringify((await chrome.storage.local.get(key))[key])!==JSON.stringify(h)||
        (await chrome.tabs.get(tabId)).url!==u||JSON.stringify(await latestRequestReceipt(tabId))!==JSON.stringify(request)||
        !fresh?.result?.ok||fresh.result.isLatest!==true||fresh.result.isReadOnly!==false||
        fresh.result.userId!==n.userId||fresh.result.userText!==n.userText||fresh.result.promptKey!==n.promptKey||
        fresh.result.userSentAtMs!==n.userSentAtMs||fresh.result.generating!==false||!fresh.result.hasError)return {ok:false,record:h};
    const ready=await goalController.handoffPreparationReady({sourceUrl:u,handoffId:h.id,tabId,reason:h.reason});
    if(!ready.ok)return {ok:false,record:h};
    const record={...h,stage:'navigating',reason:'',navigationRecoveries:1,
      navigationRecovery:{url:u,promptKey:n.promptKey,userId:n.userId,requestId:request?.requestId||null,startedAt:request?.startedAt||null}};
    await appendJournal({kind:'handoff.navigation_recovered',operationId:h.id,sourceUrl:u,
      promptKey:n.promptKey,userId:n.userId,reason:'Подтверждён отказ до перехода; отправка сообщения не повторяется'},{id:tabId});
    await chrome.storage.local.set({[key]:record});
    return {ok:true,record};
  });
  handoffWrites.set(tabId,work);
  let result;try{result=await work;}finally{if(handoffWrites.get(tabId)===work)handoffWrites.delete(tabId);}
  if(result.ok)void chrome.tabs.sendMessage(tabId,{type:'CHATGPT_HANDOFF_NAVIGATION_READY',id:result.record.id,url:result.record.sourceUrl}).catch(()=>{});
  return result;
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
      ...(['editor','upload','reasoning'].includes(message.preparationPhase)?{preparationPhase:message.preparationPhase}:{}),
      ...(message.stage==='awaiting-confirmation'?{awaitingNotifiedAt:current.awaitingNotifiedAt||Date.now()}:{}),
      ...(acceptance?{acceptance:{messageId:acceptance.messageId,entryId:acceptance.entryId,targetUrl:acceptance.targetUrl,confirmedAt:Date.now()}}:{}),
      ...(message.stage==='sent'?{sentAt:Date.now()}: {}) };
    await appendJournal({kind:`handoff.${message.stage}`,operationId:record.id,sourceUrl:record.sourceUrl,
      targetUrl:record.targetUrl,reason:record.reason,...(record.preparationPhase?{preparationPhase:record.preparationPhase}:{})}, {id:tabId});
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
  if(!ChatGPTGoalPolicy.canonical(url)||(pending.url!=='https://chatgpt.com/'&&pending.url!==url)||
      !Number.isFinite(pending.intent?.eventAt)||Date.now()-pending.intent.eventAt<30000)return waiting();
  const journal=await readJournal();
  if(!journal.ok||journal.storageError)return waiting();
  const requests=journal.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&!e.operationId&&
    typeof e.requestId==='string'&&e.requestId&&Number.isFinite(e.eventAt));
  const candidates=requests.filter(e=>e.sourceUrl===pending.url&&e.eventAt>=pending.intent.eventAt&&e.eventAt-pending.intent.eventAt<=10000);
  if(candidates.length!==1)return waiting();
  const request=candidates[0];
  const lineage=pending.url==='https://chatgpt.com/'&&pending.intent.baselineKey===''&&
    ChatGPTGoalLineage.trace(journal.events,tabId,{requestId:request.requestId,startedAt:request.eventAt});
  const scheduledRecovery=lineage?.originUrl===url&&lineage.targetUrl===url&&lineage.handoffs.length===0;
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
    func:inspectCompletedTurn,args:[url,true,null,request.eventAt,null,pending.request?.submission?.userText||pending.intent.text,scheduledRecovery]});
  const native=checked?.result,allUsers=native?.recoveryTimeline;
  const start=Array.isArray(allUsers)?allUsers.findIndex(item=>item.userId===native.userId):-1;
  const timeline=start>=0?allUsers.slice(start):null;
  if(native?.ok&&pending.request?.submission&&native.firstTurnMessageIds?.includes(pending.request.submission.userId)) {
    await goalController.composerObserveOrigin({tabId,armId:pending.id,url,requestId:request.requestId,startedAt:request.eventAt,
      userId:native.userId,userText:native.userText,userSentAtMs:native.userSentAtMs,firstMessageVerified:true,nativeVerified:true});
    pending=await goalController.composerGet({tabId});
  }
  if(!native?.ok||native.url!==url||native.isReadOnly!==false||!Array.isArray(timeline)||!timeline.length||
      timeline[0].userId!==native.userId||!ChatGPTGoalPolicy.submittedTextMatches(pending.intent.text,native.userText,native.userVisibleText,pending.intent.linkTargets)||
      !Number.isFinite(native.userSentAtMs)||Math.abs(native.userSentAtMs-request.eventAt)>10000)
    return pending.request?.submission&&typeof restoreMissingComposerGoal==='function'?
      restoreMissingComposerGoal(tabId,url,pending.id):waiting();
  const supplements=[],allRequests=journal.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&e.requestId&&Number.isFinite(e.eventAt));
  const following=allRequests.filter(e=>e.sourceUrl===url&&e.eventAt>request.eventAt)
    .sort((a,b)=>a.eventAt-b.eventAt||a.sequence-b.sequence);
  // Exact ordered one-to-one adoption: overlapping 10-second windows are not identities.
  if(following.length!==timeline.length-1||new Set(following.map(e=>e.requestId)).size!==following.length)return waiting();
  let anchor=null;
  for(const [index,user] of timeline.slice(1).entries()) {
    const found=following[index];
    if(index&&found.eventAt<=following[index-1].eventAt||Math.abs(found.eventAt-user.userSentAtMs)>10000)return waiting();
    const item={...user,requestId:found.requestId,startedAt:found.eventAt};
    if(found.operationId) {
      const sent=journal.events.filter(e=>e.tabId===tabId&&e.operationId===found.operationId&&e.kind==='send.dispatched');
      if(index!==following.length-1||sent.length!==1||sent[0].text!==user.userText)return waiting();
      anchor={...item,operationId:found.operationId};
    } else supplements.push(item);
  }
  const [currentNative]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:scheduledRecovery?[url,true,null,null,null,null,true]:[url,true]});
  const latest=currentNative?.result,last=timeline.at(-1),current=await goalController.composerGet({tabId});
  if(ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url||current?.id!==pending.id||
      current.phase!=='intent'||JSON.stringify(current)!==JSON.stringify(pending)||
      !latest?.ok||latest.isLatest!==true||latest.isReadOnly!==false||latest.userId!==last.userId||
      latest.promptKey!==last.promptKey||latest.userText!==last.userText||latest.userSentAtMs!==last.userSentAtMs)return waiting();
  const result=await goalController.composerBind({tabId,armId:pending.id,url,requestId:request.requestId,startedAt:request.eventAt,
    promptKey:native.promptKey,userId:native.userId,userText:native.userText,userVisibleText:native.userVisibleText,
    userSentAtMs:native.userSentAtMs,firstTurn:native.firstTurn,nativeVerified:true,
    recovery:{nativeVerified:true,firstUserId:timeline[0].userId,supplements,...(anchor?{anchor}: {})}});
  // Only the latest fully completed answer may continue a recovered Goal.
  // Earlier answers are historical context, never independent send triggers.
  if(result.ok&&latest.turnStatus==='complete'&&latest.generating===false&&!latest.hasError&&
      latest.assistantCompleted===true&&latest.assistantPhase==='final_answer'&&latest.assistantKey)
    await goalController.completion({url,tabId,completionKey:latest.promptKey+'|'+latest.assistantKey,
      promptKey:latest.promptKey,userId:latest.userId,response:latest.goalResponse||'',
      rawExact:latest.goalRawExact===true,nativeMarkerPending:latest.goalMarkerPending===true,nativeVerified:true});
  return {ok:result.ok,url,tabId,composer:result.record,record:await goalController.get(url)};
}
// Restoring a legacy intent is a fresh explicit user action. A captured exact
// request body plus the native server message ID can provide automatic consent.
async function restoreMissingComposerGoal(tabId,url,armId,userConfirmed=false) {
  const pending=await goalController.composerGet({tabId}),wait=()=>({ok:true,pending:true,url,composer:pending});
  if(pending?.id!==armId||pending.phase!=='intent'||pending.url!=='https://chatgpt.com/'||
      pending.intent?.baselineKey!==''||!pending.request||!ChatGPTGoalPolicy.canonical(url))return wait();
  const witness=pending.request.submission;
  if(!userConfirmed&&!witness)return wait();
  const j=await readJournal();
  if(!j.ok||j.storageError||j.events.length!==j.meta?.sequence||
      j.events.some((e,i)=>e.sequence!==i+1))return wait();
  const requests=j.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId);
  const initial=requests.filter(e=>!e.operationId&&e.sourceUrl===pending.url&&e.requestId===pending.request.requestId&&
    e.eventAt===pending.request.startedAt&&e.eventAt>=pending.intent.eventAt&&e.eventAt-pending.intent.eventAt<=10000);
  if(initial.length!==1)return wait();
  const lineage=ChatGPTGoalLineage.trace(j.events,tabId,pending.request)||
    (userConfirmed?ChatGPTGoalLineage.traceExplicitManualBridge(j.events,tabId,pending.request):null);
  if(!lineage||lineage.targetUrl!==url||pending.followupOverflow)return wait();
  if(!userConfirmed&&lineage.handoffs.length&&(!pending.originProof||pending.originProof.url!==lineage.originUrl||
      pending.originProof.requestId!==pending.request.requestId||pending.originProof.userId!==witness.userId))return wait();
  const priorManual=requests.filter(e=>!e.operationId&&e.eventAt>initial[0].eventAt&&e.sourceUrl!==url&&
    [lineage.originUrl,...lineage.handoffs.map(h=>h.sourceUrl)].includes(e.sourceUrl)),priorSupplements=[];
  const sourceContexts=lineage.handoffs.map(h=>{const e=j.events.find(e=>e.kind==='handoff.navigating'&&e.operationId===h.id&&e.tabId===tabId);return {url:h.sourceUrl,operationId:h.id,text:e?.text||''};});
  for(const r of priorManual) {
    const saved=(pending.sentFollowups||[]).filter(x=>x.requestId===r.requestId&&x.startedAt===r.eventAt&&x.url===r.sourceUrl);
    if(saved.length===1)priorSupplements.push(saved[0]);
    else if(!userConfirmed||!sourceContexts.some(c=>c.url===r.sourceUrl&&c.text))return wait();
  }
  const probe=async args=>(await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args}))[0]?.result;
  const latest=await probe([url,true]);
  if(!latest?.ok||latest.isLatest!==true||latest.isReadOnly!==false||latest.url!==url||!latest.userId||
      !Number.isFinite(latest.userSentAtMs)||!latest.promptKey||
      !userConfirmed&&!lineage.handoffs.length&&(!latest.firstTurnMessageIds?.includes(witness.userId)||latest.firstTurnResponseConfirmed!==true))return wait();
  const history=await probe([url,true,null,latest.userSentAtMs]),timeline=history?.recoveryTimeline;
  if(!history?.ok||history.url!==url||history.isReadOnly!==false||!Array.isArray(timeline)||!timeline.length||history.userId!==latest.userId)return wait();
  const later=requests.filter(e=>e.sourceUrl===url&&e.eventAt>initial[0].eventAt),supplements=[];
  let anchor=null;const consumed=new Set();
  for(const u of timeline) {
    if(Math.abs(u.userSentAtMs-initial[0].eventAt)<=10000&&
        ChatGPTGoalPolicy.submittedTextMatches(pending.intent.text,u.userText,null))continue;
    const matches=requests.filter(e=>(e.sourceUrl===url||lineage.handoffs.some(h=>h.requestId===e.requestId&&h.targetUrl===url))&&
      Math.abs(e.eventAt-u.userSentAtMs)<=10000);
    if(matches.length!==1)return wait();
    const request=matches[0],item={...u,requestId:request.requestId,startedAt:request.eventAt};
    consumed.add(request.sequence);
    if(request.operationId) {
      const sent=j.events.filter(e=>e.tabId===tabId&&e.operationId===request.operationId&&e.kind==='send.dispatched');
      if(sent.length!==1||sent[0].text!==u.userText)return wait();
      if(u.userId===latest.userId)anchor={...item,automatic:true,operationId:request.operationId};
    }else supplements.push(item);
  }
  const last=anchor||supplements.at(-1);
  if(!last||later.some(e=>!consumed.has(e.sequence))||last.userId!==latest.userId||last.promptKey!==latest.promptKey)return wait();
  const fresh=await probe([url,true]);
  if(!fresh?.ok||fresh.url!==url||fresh.isLatest!==true||fresh.isReadOnly!==false||fresh.userId!==latest.userId||fresh.userText!==latest.userText||fresh.promptKey!==latest.promptKey||
      fresh.userSentAtMs!==latest.userSentAtMs||ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url||
      JSON.stringify(await goalController.composerGet({tabId}))!==JSON.stringify(pending))return wait();
  if(lineage.handoffs.length&&anchor){
    const reconciled=await handleHandoffMessage({type:'CHATGPT_HANDOFF_RECONCILE',id:lineage.handoffs.at(-1).id},tabId);
    if(!reconciled?.confirmed)return wait();
  }
  if(lineage.handoffs.length&&!await supersedeHandoffBySuccessor(tabId,url,lineage,last,anchor,j.events,fresh,userConfirmed))return wait();
  const result=await goalController.composerRestore({tabId,armId,url,expectedComposer:pending,
    requestId:initial[0].requestId,startedAt:initial[0].eventAt,supplements,anchor,originUrl:lineage.originUrl,priorSupplements,sourceContexts,nativeVerified:true,
    userConfirmed,requestBodyConfirmed:!userConfirmed});
  if(result.ok){
    await chrome.tabs.sendMessage(tabId,{type:'CHATGPT_HANDOFF_ROUTE_CHANGED'}).catch(()=>{});
    const h=(await chrome.storage.local.get(handoffKey(tabId)))[handoffKey(tabId)];
    if(h?.stage==='superseded')await chrome.tabs.sendMessage(tabId,{type:'CHATGPT_HANDOFF_SUPERSEDED',id:h.id,url,recheck:true}).catch(()=>{});
  }
  if(result.ok&&fresh.turnStatus==='complete'&&fresh.generating===false&&!fresh.hasError&&fresh.assistantCompleted===true&&
      fresh.assistantPhase==='final_answer'&&fresh.assistantKey)
    await goalController.completion({url,tabId,completionKey:fresh.promptKey+'|'+fresh.assistantKey,promptKey:fresh.promptKey,
      userId:fresh.userId,response:fresh.goalResponse||'',rawExact:fresh.goalRawExact===true,nativeMarkerPending:fresh.goalMarkerPending===true,nativeVerified:true});
  return {...result,url,tabId,record:await goalController.get(url)};
}
// A positively accepted later manual message supersedes an old uncertain
// handoff grant without declaring that handoff sent or ever replaying it.
async function supersedeHandoffBySuccessor(tabId,url,lineage,last,anchor,events,native,userConfirmed=false,acceptedManuals=null,recheck=false) {
  const hop=lineage.handoffs.at(-1),key=handoffKey(tabId),previous=handoffWrites.get(tabId)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
    const h=(await chrome.storage.local.get(key))[key];
    if(!h||h.id!==hop.id||h.sourceUrl!==hop.sourceUrl)return false;
    if(h.stage==='sent')return h.targetUrl===url&&h.acceptance?.targetUrl===url&&Boolean(h.acceptance.messageId);
    if(h.stage==='superseded'&&h.successorGoalBoundAt)return h.supersededBy?.url===url;
    if(!userConfirmed)return false; // No exact acceptance: only a fresh explicit owner restore may supersede this legacy send.
    if(ChatGPTGoalPolicy.canonical(h.targetUrl)&&ChatGPTGoalPolicy.canonical(h.targetUrl)!==url)return false;
    const sourceGoal=await goalController.get(h.sourceUrl),targetGoal=await goalController.get(url);
    const movingGoal=sourceGoal&&sourceGoal.handoffId===h.id&&['handoff','moved'].includes(sourceGoal.phase);
    if(!['sending','awaiting-confirmation','superseded'].includes(h.stage)||h.sendReceipt?.operationId!==h.id||
        !Number.isFinite(h.sendReceipt.clickedAt)||sourceGoal&&!movingGoal&&!['completed','stopped'].includes(sourceGoal.phase)||
        movingGoal&&targetGoal&&targetGoal.id!==sourceGoal.id)return false;
    if(anchor)return false; // Its own receipt must use ordinary native acceptance.
    const manual=events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&!e.operationId&&
      e.sourceUrl===url&&e.requestId===last.requestId&&e.eventAt===last.startedAt);
    if(manual.length!==1||last.startedAt<=h.sendReceipt.clickedAt||native.userId!==last.userId||
        native.promptKey!==last.promptKey||native.userText!==last.userText||
        native.userSentAtMs!==last.userSentAtMs||ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)return false;
    const [fresh]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
    if(!fresh?.result?.ok||fresh.result.userId!==last.userId||fresh.result.userText!==last.userText||
        fresh.result.userSentAtMs!==last.userSentAtMs||fresh.result.promptKey!==last.promptKey||
        fresh.result.isLatest!==true||fresh.result.isReadOnly!==false)return false;
    const successor={url,tabId,requestId:last.requestId,startedAt:last.startedAt,userId:last.userId,promptKey:last.promptKey,userText:last.userText,userSentAtMs:last.userSentAtMs};
    await appendJournal({kind:'handoff.superseded',sourceUrl:h.sourceUrl,targetUrl:url,operationId:h.id,
      manualRequestId:last.requestId,manualStartedAt:last.startedAt,userId:last.userId,promptKey:last.promptKey,nativeVerified:true},{id:tabId});
    const record={...h,stage:'superseded',supersededBy:successor,
      reason:'Подтверждено последующее ручное сообщение; исходная отправка переноса не повторяется'};
    const archiveKey='chatgpt-handoff-archive:'+h.id,archived=(await chrome.storage.local.get(archiveKey))[archiveKey];
    await chrome.storage.local.set({[key]:record,...(!archived?{[archiveKey]:h}:{})});
    await chrome.tabs.sendMessage(tabId,{type:'CHATGPT_HANDOFF_SUPERSEDED',id:h.id,url}).catch(()=>{});
    if(movingGoal) {
      await goalController.handoffConfirm({sourceUrl:h.sourceUrl,targetUrl:url,handoffId:h.id,tabId,acceptedUserId:last.userId});
      const carried=await goalController.get(url);
      if(carried?.id!==sourceGoal.id)return false;
      const manuals=acceptedManuals||[successor];
      if(!manuals.length||manuals.at(-1).userId!==successor.userId)return false;
      for(const u of manuals) {
        const saved=(await goalController.get(url))?.supplements||[],same=saved.find(s=>s.requestId===u.requestId||s.userId===u.userId);
        if(same){
          if(same.requestId!==u.requestId||same.userId!==u.userId||same.startedAt!==u.startedAt||same.userSentAtMs!==u.userSentAtMs||same.userText!==u.userText||same.promptKey!==u.promptKey)return false;
          continue;
        }
        const eventAt=Math.min(u.startedAt,u.userSentAtMs);
        const staged=await goalController.manual({url,tabId,requestId:u.requestId,startedAt:u.startedAt,eventAt,text:u.userText,baselineKey:''});
        if(!staged?.ok)return false;
        const bound=await goalController.manualBind({url,tabId,id:carried.id,requestId:u.requestId,startedAt:u.startedAt,
          promptKey:u.promptKey,userId:u.userId,userText:u.userText,userSentAtMs:u.userSentAtMs,nativeVerified:true});
        if(!bound?.ok)return false;
      }
    }
    await chrome.storage.local.set({[key]:{...record,successorGoalBoundAt:Date.now()}});
    if(recheck)await chrome.tabs.sendMessage(tabId,{type:'CHATGPT_HANDOFF_SUPERSEDED',id:h.id,url,recheck:true}).catch(()=>{});
    return true;
  });
  handoffWrites.set(tabId,task);
  try{return await task;}finally{if(handoffWrites.get(tabId)===task)handoffWrites.delete(tabId);}
}

async function recoverHandoffSuccessor(tabId,url,userConfirmed=false) {
  const key=handoffKey(tabId),h=(await chrome.storage.local.get(key))[key];
  if(!h||!['sending','awaiting-confirmation','superseded'].includes(h.stage))return {ok:true,record:h||null};
  if(h.stage==='superseded'&&h.successorGoalBoundAt)return {ok:true,record:h};
  const j=await readJournal(),hop=ChatGPTGoalLineage.handoffTarget(j.events,tabId,h.id,h.sourceUrl);
  if(!j.ok||j.storageError||!hop||hop.targetUrl!==url)return {ok:false,reason:'Цепочка предыдущего переноса не подтверждена'};
  const [r]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
  const n=r?.result;
  if(!n?.ok||n.isLatest!==true||n.isReadOnly!==false||n.url!==url||!n.userId||!n.promptKey||!Number.isFinite(n.userSentAtMs)||typeof n.userText!=='string')
    return {ok:false,reason:'Последующее отправленное сообщение не подтверждено'};
  const matches=j.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&!e.operationId&&e.sourceUrl===url&&Math.abs(e.eventAt-n.userSentAtMs)<=10000);
  if(matches.length!==1||j.events.some(e=>e.kind==='request.started'&&e.tabId===tabId&&e.sequence>matches[0].sequence))return {ok:false,reason:'Последующий запрос изменился'};
  const last={userId:n.userId,userText:n.userText,userSentAtMs:n.userSentAtMs,promptKey:n.promptKey,requestId:matches[0].requestId,startedAt:matches[0].eventAt};
  const [history]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true,null,n.userSentAtMs]});
  const timeline=history?.result?.recoveryTimeline,manuals=[];
  if(!Array.isArray(timeline))return {ok:false,reason:'История отправленных дополнений недоступна'};
  for(const u of timeline) {
    const found=j.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&e.sourceUrl===url&&!e.operationId&&Math.abs(e.eventAt-u.userSentAtMs)<=10000);
    if(found.length===1)manuals.push({...u,url,tabId,requestId:found[0].requestId,startedAt:found[0].eventAt});
    else if(!j.events.some(e=>e.kind==='request.started'&&e.tabId===tabId&&e.requestId===hop.requestId&&Math.abs(e.eventAt-u.userSentAtMs)<=10000))return {ok:false,reason:'Дополнение пользователя не подтверждено'};
  }
  const sentManuals=j.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&!e.operationId&&e.sourceUrl===url);
  if(manuals.length!==sentManuals.length)return {ok:false,reason:'Не все отправленные дополнения доступны'};
  const ok=await supersedeHandoffBySuccessor(tabId,url,{handoffs:[hop]},last,null,j.events,n,userConfirmed,manuals,true);
  return {ok,record:(await chrome.storage.local.get(key))[key],...(!ok?{reason:'Предыдущая передача ожидает подтверждения'}:{})};
}

// Restore a previously bound Goal only when every manual request after a
// failed no-click handoff has a durable submitted-body witness and the live
// latest native turn is the same request. Never replay the handoff itself.
async function reconcileBlockedManualHandoff(tabId,url) {
  const target=ChatGPTGoalPolicy.canonical(url),composer=await goalController.composerGet({tabId});
  const source=ChatGPTGoalPolicy.canonical(composer?.binding?.url);
  if(!target||!source||source===target||composer?.phase!=='bound'||composer.blockedFollowupOverflow)return {ok:false};
  const goalKey='chatgpt-goal:'+source,old=(await chrome.storage.local.get(goalKey))[goalKey];
  if(!old||old.id!==composer.id||old.phase!=='blocked'||old.handoffTabId!==tabId||!old.handoffId||
      old.reason!=='Передача Goal остановлена: Не удалось дождаться готовности нового чата'||
      old.operation||old.manualPending||old.stopRequested||old.pauseRequested||old.preHandoffPhase==='paused'||Date.now()>=old.deadlineAt)return {ok:false};
  const journal=await readJournal();
  if(!journal.ok||journal.storageError||journal.events.length!==journal.meta?.sequence||
      journal.events.some((e,i)=>e.sequence!==i+1))return {ok:false};
  const path=ChatGPTGoalLineage.traceManualSuccessor(journal.events,tabId,source,old.handoffId);
  if(!path||path.targetUrl!==target||path.handoffs.length>19)return {ok:false};
  const sourceContexts=[{url:source,id:old.handoffId},...path.handoffs.map(h=>({url:h.sourceUrl,id:h.id}))].map(h=>{
    const event=journal.events.find(e=>e.kind==='handoff.navigating'&&e.tabId===tabId&&e.operationId===h.id&&e.sourceUrl===h.url);
    return {url:h.url,text:event?.text||''};
  });
  if(sourceContexts.some(c=>!c.text||c.text.length>200000))return {ok:false};
  const first=journal.events.find(e=>e.kind==='request.started'&&e.tabId===tabId&&!e.operationId&&
    e.requestId===path.manualRequestId&&e.eventAt===path.manualStartedAt);
  if(!first)return {ok:false};
  const rows=journal.events.filter(e=>e.tabId===tabId&&e.sequence>=first.sequence),manual=rows.filter(e=>
    e.kind==='request.started'&&!e.operationId&&[path.firstTargetUrl,...path.handoffs.map(h=>h.targetUrl),'https://chatgpt.com/'].includes(e.sourceUrl));
  if(rows.some(e=>e.kind==='request.started'&&!e.operationId&&!manual.includes(e))||
      manual.some(e=>e.sourceUrl==='https://chatgpt.com/'&&e.requestId!==path.manualRequestId))return {ok:false};
  const witnesses=composer.blockedFollowups||[];
  if(!manual.length||manual.length>100||manual.some(e=>witnesses.filter(w=>w.requestId===e.requestId&&w.startedAt===e.eventAt&&w.url===e.sourceUrl).length!==1))return {ok:false};
  const last=manual.at(-1),witness=witnesses.find(w=>w.requestId===last.requestId&&w.startedAt===last.eventAt);
  if(!(last.sourceUrl===target||last.requestId===path.manualRequestId&&path.firstTargetUrl===target)||
      rows.some(e=>e.kind==='request.started'&&e.sequence>last.sequence))return {ok:false};
  const probe=async()=>(await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[target,true]}))[0]?.result;
  const native=await probe();
  if(!native?.ok||native.url!==target||native.isLatest!==true||native.isReadOnly!==false||native.userId!==witness.userId||
      native.userText!==witness.userText||!Number.isFinite(native.userSentAtMs)||Math.abs(native.userSentAtMs-last.eventAt)>10000||!native.promptKey)return {ok:false};
  // Prior submissions must also occur in the actual saved native history.
  // Otherwise retain the blocked Goal and its copies for explicit recovery.
  const currentSupplements=[];
  for(const e of manual.slice(0,-1)) {
    const w=witnesses.find(x=>x.requestId===e.requestId&&x.startedAt===e.eventAt);
    const chat=e.requestId===path.manualRequestId?path.firstTargetUrl:e.sourceUrl;
    if(chat===target) {
      const history=(await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[target,true,null,e.eventAt]}))[0]?.result;
      if(!history?.ok||history.userId!==w.userId||history.userText!==w.userText||!history.promptKey||
          !Number.isFinite(history.userSentAtMs)||Math.abs(history.userSentAtMs-e.eventAt)>10000)return {ok:false};
      currentSupplements.push({url:target,userId:history.userId,userText:history.userText,userSentAtMs:history.userSentAtMs,
        promptKey:history.promptKey,requestId:e.requestId,startedAt:e.eventAt});
    } else if(!sourceContexts.some(c=>c.url===chat&&c.text.includes(w.userText)))return {ok:false};
  }
  const fresh=await probe();
  if(!fresh?.ok||fresh.url!==target||fresh.isLatest!==true||fresh.isReadOnly!==false||fresh.userId!==native.userId||
      fresh.userText!==native.userText||fresh.userSentAtMs!==native.userSentAtMs||fresh.promptKey!==native.promptKey||
      ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==target)return {ok:false};
  const finalJournal=await readJournal();
  if(!finalJournal.ok||finalJournal.storageError||finalJournal.meta?.sequence!==journal.meta.sequence||
      finalJournal.events.length!==journal.events.length)return {ok:false};
  const latest={url:target,userId:native.userId,userText:native.userText,userSentAtMs:native.userSentAtMs,
    promptKey:native.promptKey,requestId:last.requestId,startedAt:last.eventAt};
  const result=await goalController.restoreBoundHandoff({tabId,sourceUrl:source,targetUrl:target,handoffId:old.handoffId,
    expectedGoal:old,expectedComposer:composer,sourceContexts,supplements:[...currentSupplements,latest],latest,nativeVerified:true});
  if(result.ok&&fresh.turnStatus==='complete'&&fresh.generating===false&&!fresh.hasError&&fresh.assistantCompleted===true&&
      fresh.assistantPhase==='final_answer'&&fresh.assistantKey)
    await goalController.completion({url:target,tabId,completionKey:fresh.promptKey+'|'+fresh.assistantKey,promptKey:fresh.promptKey,
      userId:fresh.userId,response:fresh.goalResponse||'',rawExact:fresh.goalRawExact===true,nativeMarkerPending:fresh.goalMarkerPending===true,nativeVerified:true});
  return result;
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
  if(latest&&pending.request&&latest.requestId!==pending.request.requestId)
    return recoverNativeComposerGoal(tabId,canonical||currentUrl,pending);
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
  if(pending.url==='https://chatgpt.com/'&&(Math.abs(native.userSentAtMs-request.startedAt)>10000||
      !ChatGPTGoalPolicy.submittedTextMatches(pending.intent.text,native.userText,native.userVisibleText,pending.intent.linkTargets)))
    return typeof recoverNativeComposerGoal==='function'?recoverNativeComposerGoal(tabId,canonical,pending):waiting();
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
      userId:native.userId,response:native.goalResponse||'',rawExact:native.goalRawExact===true,nativeMarkerPending:native.goalMarkerPending===true,nativeVerified:true});
  }
  return {ok:result.ok,url:canonical,tabId,composer:result.record,record:await goalController.get(canonical)};
}

// An initial native conversation may retain its local alias after receiving a
// permanent URL. Only the persisted, accepted first Goal message can bind it.
async function inspectBoundNativeTurn(tabId,url) {
  const [first]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
  const native=first?.result||{ok:false,reason:'native-turn-missing'};
  if(!native.ok||native.nativeConversationInactive||native.nativeTurnStatus!=='complete'||native.assistantId||
      native.hasError||native.generating!==false||native.isLatest!==true||native.isReadOnly!==false||
      !/^local-chatgpt:[a-z0-9-]+$/.test(native.nativeConversationId||''))return native;
  const goal=await goalController.get(url),binding=goal?.manualStart,checkpoint=await completionCheckpointRead(tabId);
  if(!binding||binding.url!==url||binding.tabId!==tabId||binding.userId!==native.userId||
      binding.userText!==native.userText||binding.userSentAtMs!==native.userSentAtMs||
      checkpoint?.state!=='active'||checkpoint.url!==url||checkpoint.promptKey!==native.promptKey||
      checkpoint.requestId!==binding.requestId||checkpoint.startedAt!==binding.startedAt||checkpoint.httpCompleted!==true)return native;
  const proof={url,alias:native.nativeConversationId,userId:binding.userId,userText:binding.userText,userSentAtMs:binding.userSentAtMs};
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true,null,null,proof]});
  if(JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(checkpoint)||
      ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url||checked?.result?.userId!==native.userId)return native;
  return checked.result;
}

// A completed native reply can remain after ChatGPT drops its user item.
// Observe that reply against one exact request; never turn this into a missing
// payload acceptance, a handoff confirmation, or permission to replay a send.
const detachedReplyRecoveries=new Map();
function reconcileDetachedReply(tabId,url) {
  if(detachedReplyRecoveries.has(tabId))return detachedReplyRecoveries.get(tabId);
  const task=(async()=>{
    const checkpoint=await completionCheckpointRead(tabId),view=await readChatStatus(url);
    if(checkpoint?.state!=='active'||view.status?.kind!=='loading'||view.status.eventAt!==checkpoint.startedAt||
        ![url,'https://chatgpt.com/'].includes(checkpoint.url))return {changed:false};
    const [initial]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url]});
    if(initial?.result?.reason!=='bound-messages-missing')return {changed:false};
    const journal=await readJournal();
    const requests=journal.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&e.requestId===checkpoint.requestId&&e.eventAt===checkpoint.startedAt);
    if(!journal.ok||journal.storageError||requests.length!==1||journal.events.some(e=>e.kind==='request.started'&&
        (e.tabId===tabId||e.sourceUrl===url)&&e.sequence>requests[0].sequence))return {changed:false};
    const [observed]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectDetachedUserReply,args:[url,checkpoint.startedAt]});
    const reply=observed?.result;
    if(!reply?.ok||reply.url!==url||JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(checkpoint)||
        ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url)return {changed:false};
    const live=await readChatStatus(url);
    if(live.revision!==view.revision)return {changed:false};
    const goal=await goalController.get(url),binding=goal?.manualStart;
    const known=await latestRequestReceipt(tabId);
    if(known&&(known.requestId!==checkpoint.requestId||known.startedAt!==checkpoint.startedAt)||
        JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(checkpoint)||
        (await readChatStatus(url)).revision!==view.revision)return {changed:false};
    let continued=false,blocked=false,goalTerminal=false;
    // A saved native first-message binding remains authoritative after its DOM
    // item disappears. Do not invent a native user ID for an unknown handoff.
    if(goal?.phase==='waiting'&&!goal.operation&&binding?.url===url&&binding.tabId===tabId&&
        binding.requestId===checkpoint.requestId&&binding.startedAt===checkpoint.startedAt&&
        binding.userId&&binding.promptKey===goal.expectedPromptKey) {
      const result=await goalController.completion({url,tabId,promptKey:binding.promptKey,userId:binding.userId,
        completionKey:binding.promptKey+'|'+reply.assistantKey,response:reply.goalResponse,
        rawExact:reply.goalRawExact===true,nativeMarkerPending:reply.goalMarkerPending===true,nativeVerified:true});
      if(result.pendingMarker)return {changed:false,pendingMarker:true};
      if(result.ok){goalTerminal=['completed','blocked','stopped'].includes(result.record?.phase);continued=!goalTerminal;blocked=['blocked','stopped'].includes(result.record?.phase);}
    }
    const handoff=(await chrome.storage.local.get(handoffKey(tabId)))[handoffKey(tabId)],uncertain=handoff&&['sending','awaiting-confirmation'].includes(handoff.stage);
    const receipt=statusReceipt(),reserved=await reserveChatNotification(url,tabId,blocked||uncertain?'error':'success',Date.now(),receipt,
      {revision:view.revision,startedAt:checkpoint.startedAt,receipt:view.status.receipt});
    if(!reserved)return {changed:continued}; // A continuation/new manual send won the generation race.
    await completionCheckpointFinish(tabId,checkpoint.startedAt,'complete',checkpoint.requestId);
    await appendJournal({kind:'completion.detached_user_reconciled',sourceUrl:url,requestId:checkpoint.requestId,
      operationId:requests[0].operationId||null,assistantId:reply.assistantId,proof:reply.proof,
      handoffUnconfirmed:Boolean(uncertain),goalContinued:continued},{id:tabId});
    await broadcastChatStatus(reserved.view);
    if(continued||goal&&!['completed','stopped','blocked','moved'].includes(goal.phase)&&!goalTerminal&&!uncertain)await completeChatNotification(reserved.ticket,false);
    else await emitBoth({tabId,title:(blocked||uncertain?'❌ ':'')+cleanSessionTitle((await chrome.tabs.get(tabId)).title),
      message:uncertain?'Ответ получен. Подтверждение исходного сообщения переноса недоступно; повторная отправка заблокирована.':truncateResponse(reply.response),
      isError:Boolean(blocked||uncertain),ticket:reserved.ticket,durationMs:null});
    return {changed:true};
  })().finally(()=>detachedReplyRecoveries.delete(tabId));
  detachedReplyRecoveries.set(tabId,task);return task;
}

// Re-read the exact already-finished answer while its terminal marker settles.
// A candidate is never interpreted as permission to request another answer.
async function reconcileGoalMarker(tabId,url) {
  const goal=await goalController.get(url),p=goal?.markerPending;
  if(!p||!['waiting','paused'].includes(goal.phase)||goal.operation||p.tabId!==tabId)return null;
  const pending=()=>({ok:true,pending:true,canRetry:true});
  const checkpoint=await completionCheckpointRead(tabId),view=await readChatStatus(url),request=await latestRequestReceipt(tabId);
  let n;try{n=await inspectBoundNativeTurn(tabId,url);}catch{return pending();}
  if(n?.reason==='bound-messages-missing'){
    await reconcileDetachedReply(tabId,url);
    return (await goalController.get(url))?.markerPending?pending():{ok:true,pending:false};
  }
  if(!n?.ok||n.isLatest!==true||n.isReadOnly!==false||n.generating!==false||n.hasError||
      n.turnStatus!=='complete'||!n.assistantCompleted||n.assistantPhase!=='final_answer'||n.userId!==p.userId||
      n.promptKey!==p.promptKey||n.promptKey+'|'+n.assistantKey!==p.completionKey||
      ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url)return pending();
  const currentGoal=await goalController.get(url),currentRequest=await latestRequestReceipt(tabId);
  if(currentGoal?.id!==goal.id||currentGoal.expectedPromptKey!==goal.expectedPromptKey||
      JSON.stringify(currentGoal.markerPending)!==JSON.stringify(p)||
      JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(checkpoint)||
      JSON.stringify(currentRequest)!==JSON.stringify(request)||
      ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url)return pending();
  const result=await goalController.completion({url,tabId,completionKey:p.completionKey,promptKey:p.promptKey,userId:p.userId,
    response:n.goalResponse||'',rawExact:n.goalRawExact===true,nativeVerified:true,nativeMarkerPending:n.goalMarkerPending===true});
  if(result.pendingMarker)return pending();
  if(result.ok&&['completed','blocked','stopped'].includes(result.record?.phase)&&view.status) {
    const receipt=statusReceipt(),error=result.record.phase!=='completed';
    const reserved=await reserveChatNotification(url,tabId,error?'error':'success',Date.now(),receipt,
      {kind:view.status.kind,revision:view.revision,startedAt:view.status.eventAt,receipt:view.status.receipt});
    if(reserved){
      if(checkpoint?.state==='active')await completionCheckpointFinish(tabId,checkpoint.startedAt,'complete',checkpoint.requestId);
      await appendJournal({kind:'goal.marker_reconciled',sourceUrl:url,goalId:goal.id,operationId:goal.id,
        promptKey:p.promptKey,completionKey:p.completionKey,phase:result.record.phase},{id:tabId});
      await broadcastChatStatus(reserved.view);void seeVisibleResult(url,receipt).catch(()=>{});
      await emitBoth({tabId,title:(error?'❌ ':'')+cleanSessionTitle((await chrome.tabs.get(tabId)).title),
        message:error&&result.record.phase==='stopped'?result.record.reason:n.goalResponse,isError:error,ticket:reserved.ticket,durationMs:null});
    }
  }
  return {ok:true,pending:false};
}

// Stable native identity is observation metadata; it never authorizes a send.
async function bindCompletionNativeIdentity(tabId,url,record) {
  if(!record||record.nativeUserId||record.state!=='active'||record.url!==url||!record.promptKey||
      record.promptKey===record.baselineKey)return false;
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url]});
  const n=checked?.result;
  if(!n?.ok||n.isLatest!==true||n.isReadOnly!==false||n.promptKey!==record.promptKey||!n.userId||
      !Number.isFinite(n.lastUserSentAtMs)||Math.abs(n.lastUserSentAtMs-record.startedAt)>10000)return false;
  return completionCheckpointChange(tabId,current=>JSON.stringify(current)===JSON.stringify(record)?
    {record:{...current,nativeUserId:n.userId,nativeUserSentAtMs:n.lastUserSentAtMs},value:true}:{value:false});
}

// Legacy checkpoints need an independently accepted sender payload before a
// reused numeric DOM key can be rebound to a different visual row number.
async function recoverCompletionSenderIdentity(tabId,url,record,native) {
  if(!record||!native?.ok||record.nativeUserId||native.promptKey!==record.baselineKey)return null;
  const j=await readJournal(),requests=j.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&e.sourceUrl===url&&
    e.requestId===record.requestId&&e.eventAt===record.startedAt);
  if(!j.ok||j.storageError||requests.length!==1||!requests[0].operationId)return null;
  const request=requests[0],own=j.events.filter(e=>e.operationId===request.operationId&&e.tabId===tabId&&e.sourceUrl===url),
    sends=own.filter(e=>e.kind==='send.dispatched'),started=own.filter(e=>e.kind==='request.started');
  if(sends.length!==1||started.length!==1||typeof sends[0].text!=='string'||
      j.events.some(e=>e.kind==='request.started'&&(e.tabId===tabId||e.sourceUrl===url)&&e.sequence>request.sequence))return null;
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,
    args:[url,true,null,record.startedAt]});
  const n=checked?.result;
  if(!n?.ok||n.isLatest!==true||n.isReadOnly!==false||n.userId!==native.userId||n.promptKey!==native.promptKey||
      n.userText!==sends[0].text||!Number.isFinite(n.userSentAtMs)||n.userSentAtMs!==native.lastUserSentAtMs||
      JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(record)||(await chrome.tabs.get(tabId)).url!==url)return null;
  return {nativeUserId:n.userId,nativeUserSentAtMs:n.userSentAtMs};
}

// Notification-only recovery. A lost MV3 receipt must not suppress a proven
// terminal error, but this proof never releases any retry or unknown-send lock.
async function readRestartErrorReceipt(tabId,url,message) {
  if(!url||ChatGPTHandoffTitle.chatUrl(url)!==url||!message.requestId||typeof message.attemptId!=='string')return null;
  const checkpoint=await completionCheckpointRead(tabId),before=await readChatStatus(url);
  if(checkpoint?.state!=='active'||checkpoint.url!==url||!checkpoint.promptKey||
      checkpoint.requestId!==message.requestId||String(checkpoint.startedAt)!==message.attemptId||
      before.status?.kind!=='loading'||before.status.eventAt!==checkpoint.startedAt)return null;
  const native=await inspectBoundNativeTurn(tabId,url);
  if(!native?.ok||native.isLatest!==true||native.isReadOnly!==false||!(native.hasError===true||
        checkpoint.httpCompleted===true&&native.terminalEmptyResponse===true&&native.nativeConversationInactive===true)||
      native.generating!==false||native.turnStatus!=='complete'||!native.userId||native.promptKey!==checkpoint.promptKey||
      !Number.isFinite(native.lastUserSentAtMs)||Math.abs(native.lastUserSentAtMs-checkpoint.startedAt)>10000)return null;
  const current=await completionCheckpointRead(tabId),view=await readChatStatus(url);
  if(JSON.stringify(current)!==JSON.stringify(checkpoint)||view.revision!==before.revision||
      view.status?.kind!=='loading'||view.status.eventAt!==checkpoint.startedAt||
      ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url||await latestRequestReceipt(tabId))return null;
  return {url,startedAt:checkpoint.startedAt,requestId:checkpoint.requestId,receipt:view.status.receipt,
    notificationOnly:true};
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

  let operationId='',requestAt=0;
  // A manually submitted Goal (or verified follow-up) has a durable native
  // message ID and exact request receipt, but no goal.confirmed auto-send.
  const manual=[goal.manualSupplementBinding,goal.manualStart].find(value=>value?.requestId&&
    value.userId===native.userId&&value.userText===native.userText&&
    value.userSentAtMs===native.userSentAtMs&&Number.isFinite(value.startedAt)&&
    (value.promptKey===goal.expectedPromptKey||
      goal.confirmedPromptBinding?.operationId==='manual:'+value.requestId&&
      goal.confirmedPromptBinding.userId===native.userId));
  if(manual) {
    const requests=journal.events.filter(e=>e.kind==='request.started'&&!e.operationId&&e.tabId===tabId&&
      e.requestId===manual.requestId&&e.eventAt===manual.startedAt&&e.sourceUrl===(manual.sourceUrl||url));
    if(manual.tabId!==tabId||Math.abs(manual.startedAt-native.userSentAtMs)>10000||requests.length!==1||
        journal.events.some(e=>e.kind==='request.started'&&(e.tabId===tabId||e.sourceUrl===url)&&
          e.sequence>requests[0].sequence)||ChatGPTHandoffTitle.chatUrl((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
    operationId='manual:'+manual.requestId;
    requestAt=manual.startedAt;
  } else {
    let confirmed=journal.events.filter(e=>e.sourceUrl===url&&e.goalId===goal.id&&e.kind==='goal.confirmed').at(-1);
    // A guarded retry can become the prompt Goal is waiting for. Its durable
    // request and bound checkpoint establish the old key across a DOM remount.
    if(!confirmed) {
      const bound=journal.events.filter(e=>e.kind==='completion.bound'&&e.tabId===tabId&&e.sourceUrl===url&&
        e.promptKey===goal.expectedPromptKey);
      if(bound.length===1) {
        const requests=journal.events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&e.sourceUrl===url&&
          e.operationId&&String(e.eventAt)===String(bound[0].attemptId));
        if(requests.length===1) {
          const retry=journal.events.filter(e=>e.kind==='retry.confirmed'&&e.tabId===tabId&&
            e.sourceUrl===url&&e.operationId===requests[0].operationId);
          if(retry.length===1)confirmed={...retry[0],promptKey:bound[0].promptKey};
        }
      }
    }
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
    operationId=confirmed.operationId;
    requestAt=requests[0].eventAt;
  }

  const result=await goalController.rebindPrompt({url,tabId,id:goal.id,oldPromptKey:goal.expectedPromptKey,
    promptKey:native.promptKey,userId:native.userId,operationId});
  if(!result.ok)return result;
  await completionCheckpointChange(tabId,current=>current?.url===url&&current.state==='active'&&
    current.promptKey===goal.expectedPromptKey&&current.startedAt===requestAt
      ?{record:{...current,promptKey:native.promptKey},value:true}:{value:false});
  const receipt=manualRequestReceiptsByTab.get(tabId);
  if(receipt?.url===url&&receipt.startedAt===requestAt&&receipt.recoveredPromptKey===goal.expectedPromptKey)
    manualRequestReceiptsByTab.set(tabId,{...receipt,recoveredPromptKey:native.promptKey});
  // Rebinding alone never authorizes a send; a completed native answer is
  // reconciled through the same guarded Goal coordinator as before.
  if(native.turnStatus==='complete'&&native.generating===false&&native.assistantCompleted===true&&
      native.assistantPhase==='final_answer'&&native.assistantKey)
    await goalController.completion({url,tabId,promptKey:native.promptKey,
      completionKey:native.promptKey+'|'+native.assistantKey,userId:native.userId,
      response:native.goalResponse||'',rawExact:native.goalRawExact===true,nativeMarkerPending:native.goalMarkerPending===true,nativeVerified:true});
  return {ok:true,promptKey:native.promptKey,userId:native.userId};
}

// A route-only key from a virtualized first turn is not itself an identity.
// This proof is read-only: it does not clear a retry fence or authorize a send.
function proveHandoffRetryIdentity({url,tabId,planned,native,checkpoint,handoff,journal}) {
  const events=journal?.events;
  if(!url||!planned||planned.promptKey!==new URL(url).pathname||!planned.requestId||
      !native?.ok||native.isLatest!==true||native.isReadOnly!==false||!native.hasError||
      native.generating!==false||!native.userId||!native.promptKey?.startsWith(new URL(url).pathname+'|')||
      !Number.isFinite(native.lastUserSentAtMs)||Math.abs(native.lastUserSentAtMs-Number(planned.attemptId))>10000||
      checkpoint?.state!=='active'||![url,'https://chatgpt.com/'].includes(checkpoint.url)||checkpoint.requestId!==planned.requestId||
      String(checkpoint.startedAt)!==planned.attemptId||!Number.isFinite(checkpoint.requestFailedAt)||
      handoff?.stage!=='sent'||handoff.targetUrl!==url||handoff.acceptance?.messageId!==native.userId||
      handoff.acceptance?.targetUrl!==url||!handoff.id||journal?.ok!==true||journal.storageError||
      !Array.isArray(events)||events.length!==journal.meta?.sequence||
      events.some((e,i)=>e.sequence!==i+1))return false;
  const requests=events.filter(e=>e.kind==='request.started'&&e.tabId===tabId&&e.requestId===planned.requestId&&e.operationId===handoff.id);
  const sends=events.filter(e=>e.kind==='send.dispatched'&&e.tabId===tabId&&e.operationId===handoff.id);
  return requests.length===1&&sends.length===1&&Number(requests[0].eventAt)===Number(planned.attemptId)&&
    typeof native.userText==='string'&&native.userText!==''&&sends[0].text===native.userText&&
    !events.some(e=>e.kind==='request.started'&&(e.tabId===tabId||e.sourceUrl===url)&&e.sequence>requests[0].sequence);
}

const retryReadinessRecoveries=new Map();
async function recoverNoClickRetry(tabId,url) {
  if(retryReadinessRecoveries.has(url))return retryReadinessRecoveries.get(url);
  const work=(async()=>{
    const state=await readRetryState(url);
    if(!state?.blocked||state.terminal||(state.preparationRecoveries||0)>=2||state.remainingRetries===0||
        !state.lastPromptKey||!state.blockedAttemptId)return state;
    const carriedDraft=await readRetryDraft(url);
    const journal=await readJournal();
    if(!journal.ok||journal.storageError)return state;
    const failures=journal.events.filter(e=>e.sourceUrl===url&&['retry.failed','draft.restore_failed'].includes(e.kind));
    const failed=failures.at(-1);
    if(!['retry.failed','draft.restore_failed'].includes(failed?.kind)||failed.tabId!==tabId||!failed.operationId||failed.kind==='retry.failed'&&failed.clicked!==false||failed.attemptId!==state.blockedAttemptId||
        (failed.error||failed.reason)!==state.reason)return state;
    const events=journal.events.filter(e=>e.operationId===failed.operationId);
    if(carriedDraft&&(carriedDraft.operationId!==failed.operationId||carriedDraft.claimedAt||
        !['saved','not-clicked'].includes(carriedDraft.phase)||typeof carriedDraft.draft!=='string'||
        !carriedDraft.draft||carriedDraft.attemptId!==failed.attemptId))return state;
    const planned=events.find(e=>e.kind==='retry.planned');
    const cleanupOnly=failed.kind==='draft.restore_failed'&&!events.some(e=>e.kind==='draft.saved');
    if(failed.kind==='draft.restore_failed'&&!cleanupOnly||planned?.attemptId!==failed.attemptId||
        !events.some(e=>e.kind==='retry.finished'&&e.clicked===false)||
        events.some(e=>e.kind==='send.dispatched'||e.kind==='retry.clicked'||e.kind==='request.started')||
        events.some(e=>e.kind==='retry.send_intent'||e.kind==='send.authorized')&&!events.some(e=>e.kind==='send.not_clicked')||
        journal.events.some(e=>(e.tabId===tabId||e.sourceUrl===url)&&e.kind==='request.started'&&e.recordedAt>planned.recordedAt))return state;
    const tab=await chrome.tabs.get(tabId);
    if(tab.url!==url||tab.status!=='complete')return state;
    const native=await inspectBoundNativeTurn(tabId,url);
    const failedRequest=await completionCheckpointRead(tabId);
    const handoff=(await chrome.storage.local.get(handoffKey(tabId)))[handoffKey(tabId)];
    const rebound=planned.promptKey!==state.lastPromptKey&&native?.promptKey===state.lastPromptKey&&
      proveHandoffRetryIdentity({url,tabId,planned,native,checkpoint:failedRequest,handoff,journal});
    if(planned.promptKey!==state.lastPromptKey&&!rebound)return state;
    const goal=await goalController.get(url);
    const protectingGoal=goal&&!(goal.phase==='completed'&&goal.expectedPromptKey!==planned.promptKey);
    if(protectingGoal&&(goal.operation||goal.pauseRequested||goal.stopRequested||goal.manualPending||Date.now()>=goal.deadlineAt||
        !(goal.phase==='blocked'&&goal.reason==='Восстановление запроса завершилось ошибкой'||
          rebound&&goal.phase==='waiting'&&!goal.expectedPromptKey)))return state;
    const checkpoint=native?.hasError?null:await completionCheckpointRead(tabId);
    const terminalEmpty=checkpoint?.state==='active'&&checkpoint.url===url&&checkpoint.promptKey===planned.promptKey&&
      checkpoint.startedAt===Number(planned.attemptId)&&checkpoint.requestId===planned.requestId&&checkpoint.httpCompleted===true&&
      native?.terminalEmptyResponse===true&&native.nativeConversationInactive===true;
    if(cleanupOnly&&!terminalEmpty)return state;
    const [delivery]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectChatError,args:[0,false]});
    const deliveryIdle=delivery?.result?.action==='retry'&&Number.isFinite(delivery.result.deliveryUserSentAtMs)&&
      delivery.result.deliveryUserSentAtMs===native?.lastUserSentAtMs&&native?.hasError===true&&
      failedRequest?.state==='active'&&(rebound||failedRequest.url===url&&failedRequest.promptKey===planned.promptKey)&&
      failedRequest.requestId===planned.requestId&&String(failedRequest.startedAt)===planned.attemptId&&
      (failedRequest.httpCompleted===true||Number.isFinite(failedRequest.requestFailedAt));
    let verifiedIdle=native?.generating===false&&(native.nativeConversationInactive===true||deliveryIdle);
    if(rebound&&!deliveryIdle)return state;
    if(carriedDraft&&!verifiedIdle) {
      const bound=events.filter(e=>e.kind==='recovery.stop_intent').at(-1)?.recoveryBinding;
      if(bound?.kind!=='user'||bound.userId!==native?.userId)return state;
      const message={url,alertIndex:0,attemptId:planned.attemptId,requestId:planned.requestId,promptKey:planned.promptKey,recoveryBinding:bound};
      const [surface]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectChatError,
        args:[0,false,'inspect-recovery',url,planned.promptKey,bound]});
      verifiedIdle=Boolean(await proveInactiveRecoveryIdle(tabId,url,message,await latestRequestReceipt(tabId),surface?.result||{}));
    }
    if(carriedDraft&&!verifiedIdle)return state;
    if(!native?.ok||native.isLatest!==true||native.isReadOnly!==false||(!native.hasError&&!terminalEmpty)||!native.userId||
        native.promptKey!==(rebound?state.lastPromptKey:planned.promptKey)||planned.retryUserId&&native.userId!==planned.retryUserId||Math.abs(native.lastUserSentAtMs-Number(planned.attemptId))>10000||
        !Number.isFinite(native.lastUserSentAtMs))return state;
    const [error]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectChatError,args:[0,false]});
    if(!terminalEmpty&&error?.result?.action!=='retry')return state;
    const [empty]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatComposer,
      args:[{action:carriedDraft||terminalEmpty&&cleanupOnly?'inspect-plain-retry-draft':'inspect-empty-retry',text:'',url}]});
    if(empty?.result?.ok!==true)return state;
    const [runtime]=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',
      func:()=>({attemptId:globalThis.__chatgptNotifierAttemptId||'',requestId:globalThis.__chatgptNotifierRequestId||null})});
    const runtimeMatches=runtime?.result?.attemptId===planned.attemptId&&(runtime.result.requestId||null)===(planned.requestId||null);
    if(!runtimeMatches) {
      const saved=await completionCheckpointRead(tabId);
      if(runtime?.result?.attemptId||runtime?.result?.requestId||!verifiedIdle||
          saved?.state!=='active'||!rebound&&(saved.url!==url||saved.promptKey!==planned.promptKey)||
          saved.requestId!==planned.requestId||String(saved.startedAt)!==planned.attemptId||!Number.isFinite(saved.requestFailedAt))return state;
      const [bound]=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',
        func:function restoreNoClickAttemptBinding(binding) {
          if(location.origin+location.pathname!==binding.url||globalThis.__chatgptNotifierAttemptId||globalThis.__chatgptNotifierRequestId)return false;
          globalThis.__chatgptNotifierAttemptId=binding.attemptId;
          globalThis.__chatgptNotifierRequestStartedAt=binding.startedAt;
          globalThis.__chatgptNotifierRequestId=binding.requestId;
          return true;
        },args:[{url,attemptId:planned.attemptId,startedAt:saved.startedAt,requestId:planned.requestId}]});
      if(bound?.result!==true||JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(saved))return state;
    }
    if((await chrome.tabs.get(tabId)).url!==url)return state;
    if(deliveryIdle) {
      const [fresh]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectChatError,args:[0,false]});
      if(fresh?.result?.action!=='retry'||fresh.result.deliveryUserSentAtMs!==delivery.result.deliveryUserSentAtMs||
          JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(failedRequest))return state;
    }
    if(JSON.stringify(await readRetryDraft(url))!==JSON.stringify(carriedDraft))return state;
    if(rebound) {
      const freshJournal=await readJournal(),freshNative=await inspectBoundNativeTurn(tabId,url),freshCheckpoint=await completionCheckpointRead(tabId);
      const freshHandoff=(await chrome.storage.local.get(handoffKey(tabId)))[handoffKey(tabId)];
      if(!proveHandoffRetryIdentity({url,tabId,planned,native:freshNative,checkpoint:freshCheckpoint,handoff:freshHandoff,journal:freshJournal})||
          freshNative.promptKey!==state.lastPromptKey||JSON.stringify(await goalController.get(url))!==JSON.stringify(goal))return state;
    }
    await appendJournal({kind:'retry.preparation_recovered',operationId:failed.operationId,sourceUrl:url,
      attemptId:planned.attemptId,promptKey:rebound?state.lastPromptKey:planned.promptKey,requestId:planned.requestId,
      preparationDraftOperationId:carriedDraft?.operationId||null,preparationDraftSequence:carriedDraft?.savedSequence||null},tab);
    await goalController.retry({url,tabId,kind:'retry.preparation_recovered',promptKey:rebound?state.lastPromptKey:planned.promptKey,attemptId:planned.attemptId});
    return readRetryState(url);
  })();
  retryReadinessRecoveries.set(url,work);
  try{return await work;}finally{if(retryReadinessRecoveries.get(url)===work)retryReadinessRecoveries.delete(url);}
}

// Missing voice controls can mean a draft is present, not an active response.
// Reuse exact native request/controller proof; this never clicks Stop or Send.
async function proveInactiveRecoveryIdle(tabId,url,message,initial,surfaceProof={}) {
  if(message.recoveryBinding?.kind!=='user'||!message.recoveryBinding.userId)return null;
  const checkpoint=await completionCheckpointRead(tabId),native=await inspectBoundNativeTurn(tabId,url);
  if(checkpoint?.state!=='active'||checkpoint.url!==url||checkpoint.promptKey!==message.promptKey||
      String(checkpoint.startedAt)!==message.attemptId||checkpoint.requestId!==message.requestId||
      !checkpoint.httpCompleted&&!Number.isFinite(checkpoint.requestFailedAt)||
      !native?.ok||native.isLatest!==true||native.isReadOnly!==false||native.hasError!==true||
      native.generating!==false||native.nativeConversationInactive!==true&&surfaceProof.editorSubmitIdle!==true||native.promptKey!==message.promptKey||
      native.userId!==message.recoveryBinding.userId||!Number.isFinite(native.lastUserSentAtMs)||
      Math.abs(native.lastUserSentAtMs-checkpoint.startedAt)>10000)return null;
  const [editor]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatComposer,
    args:[{action:'inspect-plain-retry-draft',text:'',url}]});
  if(editor?.result?.ok!==true)return null;
  const [fresh]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectChatError,
    args:[message.alertIndex,false,'inspect-recovery',url,message.promptKey,message.recoveryBinding]});
  if(fresh?.result?.needsIdleProof!==true||native.nativeConversationInactive!==true&&fresh.result.editorSubmitIdle!==true||JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(checkpoint)||
      await latestRequestReceipt(tabId)!==initial||(await chrome.tabs.get(tabId)).url!==url)return null;
  return {ok:true,stopped:false,idle:true,proof:'native-inactive-error-editor',recoveryBinding:message.recoveryBinding};
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
  const grants=journal.events.filter(e=>own(e)&&e.kind==='send.authorized');
  const grantAt=grants.length===1?grants[0].recordedAt:null,dispatchAt=sends[0].recordedAt;
  const sendWindow=Number.isFinite(grantAt)&&Number.isFinite(dispatchAt)&&grantAt>=op.createdAt&&
    dispatchAt>=grantAt?{notBefore:grantAt,notAfter:dispatchAt}:null;
  const proof={tabId,url,text:op.text,createdAt:op.createdAt,submittedText:sends[0].text,sendWindow,
    request:{requestId:requests[0].requestId,startedAt:requests[0].eventAt,url,operationId:op.id}};
  goalAckProofs.set(op.id,proof);
  if(goalAckProofs.size>16)goalAckProofs.delete(goalAckProofs.keys().next().value);
  return proof;
}
async function reconcileNativeGoalAcknowledgement(tabId,url) {
  const key='chatgpt-goal:'+url,record=(await chrome.storage.local.get(key))[key],op=record?.operation;
  if(record?.phase!=='blocked'||!op||!['intent','clicked'].includes(op.status)||
      record.pauseRequested||record.stopRequested||record.manualOverride||record.manualPending)return;
  const proof=await readGoalAckProof(op.tabId,url,op);
  if(!proof)return;
  if(op.tabId===tabId) {
    const result=await confirmNativeGoalSend({url,tabId,id:record.id,operationId:op.id,
      requestId:proof.request.requestId,startedAt:proof.request.startedAt});
    if(result?.ok)return result;
  }
  if(!proof.sendWindow)return;
  // A later manual send or a reopened tab does not erase a server-accepted
  // operation. Prove the historical turn and every later sent message first.
  const probe=async args=>(await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args}))[0]?.result;
  const historical=await probe([url,true,null,{...proof.sendWindow,userText:op.text,submittedText:proof.submittedText}]);
  const timeline=historical?.recoveryTimeline;
  if(!historical?.ok||historical.url!==url||historical.nativeConversationId!==new URL(url).pathname.split('/').at(-1)||historical.isReadOnly!==false||
      !historical.userId||historical.promptKey===op.baselineKey||
      ![op.text,proof.submittedText].includes(historical.userText)||!Array.isArray(timeline))return;
  const index=timeline.findIndex(u=>u.userId===historical.userId);
  if(index<0||timeline.filter(u=>u.userId===historical.userId).length!==1)return;
  const latest=await probe([url,true]);
  if(!latest?.ok||latest.url!==url||latest.nativeConversationId!==historical.nativeConversationId||latest.isLatest!==true||latest.isReadOnly!==false||
      timeline.at(-1)?.userId!==latest.userId||timeline.at(-1)?.promptKey!==latest.promptKey)return;
  const journal=await readJournal();
  const later=journal.events.filter(e=>e.kind==='request.started'&&e.sourceUrl===url&&e.eventAt>proof.request.startedAt);
  const suffix=timeline.slice(index+1),supplements=[];
  if(later.length!==suffix.length)return;
  for(let i=0;i<suffix.length;i++) {
    const u=suffix[i],matches=later.filter(e=>!e.operationId&&typeof e.requestId==='string'&&e.requestId&&
      Number.isFinite(e.eventAt)&&Number.isFinite(u.userSentAtMs)&&Math.abs(e.eventAt-u.userSentAtMs)<=10000);
    if(matches.length!==1||later.filter(e=>e.requestId===matches[0].requestId).length!==1)return;
    const request=matches[0];
    if(i&&request.eventAt<=supplements.at(-1).startedAt||typeof u.userText!=='string'||!u.userText.trim())return;
    supplements.push({...u,text:u.userText,tabId:request.tabId,requestId:request.requestId,startedAt:request.eventAt});
  }
  const fresh=await probe([url,true]);
  if(!fresh?.ok||fresh.userId!==latest.userId||fresh.promptKey!==latest.promptKey||fresh.userText!==latest.userText||
      fresh.userSentAtMs!==latest.userSentAtMs||ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)return;
  const result=await goalController.recoverAcknowledgement({url,tabId,expectedRecord:record,operationId:op.id,
    promptKey:historical.promptKey,userId:historical.userId,supplements,nativeVerified:true});
  if(result?.ok&&fresh.turnStatus==='complete'&&fresh.generating===false&&!fresh.hasError&&fresh.assistantCompleted===true&&
      fresh.assistantPhase==='final_answer'&&fresh.assistantKey)
    await goalController.completion({url,tabId,completionKey:fresh.promptKey+'|'+fresh.assistantKey,promptKey:fresh.promptKey,
      userId:fresh.userId,response:fresh.goalResponse||'',rawExact:fresh.goalRawExact===true,nativeMarkerPending:fresh.goalMarkerPending===true,nativeVerified:true});
  return result;
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
    rawExact:native.goalRawExact===true,nativeMarkerPending:native.goalMarkerPending===true,nativeVerified:true});
}
async function reconcileWaitingGoalAnswer(tabId,url) {
  const goal=await goalController.get(url);
  if(goal?.phase!=='waiting'||goal.operation||goal.manualPending||goal.manualOverride||
      goal.stopRequested||goal.pauseRequested||!goal.expectedPromptKey||goal.handoffPending)return;
  const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]});
  const n=checked?.result;
  if(!n?.ok||n.url!==url||n.promptKey!==goal.expectedPromptKey||n.isLatest!==true||n.isReadOnly!==false||
      n.generating!==false||n.hasError||n.turnStatus!=='complete'||n.assistantCompleted!==true||
      n.assistantPhase!=='final_answer'||!n.assistantKey||!n.userId)return;
  const completionKey=n.promptKey+'|'+n.assistantKey;
  if(goal.lastCompletionKey===completionKey||ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url||
      JSON.stringify(await goalController.get(url))!==JSON.stringify(goal))return;
  return goalController.completion({url,tabId,completionKey,promptKey:n.promptKey,userId:n.userId,
    response:n.goalResponse||'',rawExact:n.goalRawExact===true,nativeMarkerPending:n.goalMarkerPending===true,nativeVerified:true});
}

// Recover only the old pre-navigation false block, and only after the exact
// previously submitted native turn has a final answer. A transport failure
// by itself is never evidence that the server stopped or completed the turn.
async function reconcileCompletedSourceHandoff(tabId,url) {
  const goalKey='chatgpt-goal:'+url,key=handoffKey(tabId),values=await chrome.storage.local.get([goalKey,key]);
  const goal=values[goalKey],handoff=values[key];
  if(goal?.phase!=='blocked'||goal.handoffTabId!==tabId||goal.handoffId!==handoff?.id||
      goal.preHandoffPhase!=='waiting'||goal.reason!=='Передача Goal остановлена: В исходном чате идёт генерация; переход отменён'||
      goal.operation||goal.manualPending||goal.manualOverride||goal.pauseRequested||goal.stopRequested||Date.now()>=goal.deadlineAt||
      handoff?.stage!=='failed'||handoff.reason!=='В исходном чате идёт генерация; переход отменён'||
      handoff.sourceUrl!==url||handoff.sendReceipt||!handoff.lastUserText)return {ok:false};
  const probe=async()=>(await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url,true]}))[0]?.result;
  const native=await probe();
  if(!native?.ok||native.url!==url||native.isLatest!==true||native.isReadOnly!==false||native.generating!==false||native.hasError||
      native.turnStatus!=='complete'||native.assistantCompleted!==true||native.assistantPhase!=='final_answer'||
      !native.assistantKey||!native.promptKey||!native.userId||native.userText!==handoff.lastUserText||
      !Number.isFinite(native.userSentAtMs))return {ok:false};
  const journal=await readJournal();
  if(!journal.ok||journal.storageError||journal.events.length!==journal.meta?.sequence||
      journal.events.some((event,index)=>event.sequence!==index+1))return {ok:false};
  const own=journal.events.filter(e=>e.tabId===tabId&&e.operationId===handoff.id),
    navigation=own.filter(e=>e.kind==='handoff.navigating'&&e.sourceUrl===url),
    failed=own.filter(e=>e.kind==='handoff.failed'&&e.reason===handoff.reason);
  if(navigation.length!==1||failed.length!==1||failed[0].sequence<=navigation[0].sequence||
      own.some(e=>['handoff.navigation_intent','handoff.navigation_clicked','handoff.sending','handoff.clicked',
        'handoff.sent','handoff.awaiting-confirmation','request.started'].includes(e.kind)||e.kind.startsWith('send.')))return {ok:false};
  const requests=journal.events.filter(e=>e.tabId===tabId&&e.sourceUrl===url&&e.kind==='request.started'&&
    e.operationId&&Number.isFinite(e.eventAt)&&Math.abs(e.eventAt-native.userSentAtMs)<=10000);
  if(requests.length!==1)return {ok:false};
  const request=requests[0],operation=journal.events.filter(e=>e.tabId===tabId&&e.operationId===request.operationId),
    sends=operation.filter(e=>e.kind==='send.dispatched'),confirmed=operation.filter(e=>e.kind==='retry.confirmed');
  if(!request.requestId||sends.length!==1||sends[0].text!==native.userText||confirmed.length!==1||
      !operation.some(e=>e.kind==='request.failed'&&e.requestId===request.requestId&&e.sequence>request.sequence&&e.sequence<navigation[0].sequence)||
      journal.events.some(e=>e.kind==='request.started'&&(e.tabId===tabId||e.sourceUrl===url)&&e.sequence>request.sequence))return {ok:false};
  const fresh=await probe(),current=await chrome.storage.local.get([goalKey,key]);
  if(!fresh?.ok||fresh.url!==url||fresh.isLatest!==true||fresh.isReadOnly!==false||fresh.generating!==false||fresh.hasError||fresh.turnStatus!=='complete'||
      fresh.assistantCompleted!==true||fresh.assistantPhase!=='final_answer'||fresh.userId!==native.userId||
      fresh.userText!==native.userText||fresh.userSentAtMs!==native.userSentAtMs||fresh.promptKey!==native.promptKey||
      fresh.assistantKey!==native.assistantKey||JSON.stringify(current[goalKey])!==JSON.stringify(goal)||
      JSON.stringify(current[key])!==JSON.stringify(handoff)||ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
  // Recheck the journal after the native probe; any new source request wins.
  const last=await readJournal();
  if(!last.ok||last.storageError||last.events.length!==last.meta?.sequence||
      last.events.some((event,index)=>event.sequence!==index+1)||
      last.events.some(e=>e.kind==='request.started'&&(e.tabId===tabId||e.sourceUrl===url)&&e.sequence>request.sequence))return {ok:false};
  const restored=await goalController.handoffSourceCompleted({sourceUrl:url,handoffId:handoff.id,tabId,goalId:goal.id,
    oldPromptKey:goal.expectedPromptKey,promptKey:native.promptKey,userId:native.userId});
  if(!restored.ok)return restored;
  return await reconcileWaitingGoalAnswer(tabId,url)||{ok:true};
}

async function reconcileGoalPreparation(tabId,url) {
  const key='chatgpt-goal:'+url,goal=(await chrome.storage.local.get(key))[key],op=goal?.operation;
  if(goal?.phase!=='blocked'||!['reserved','intent'].includes(op?.status)||op.tabId!==tabId||goal.pauseRequested||goal.stopRequested)return;
  const meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
  const ownGrant=entry=>entry?.kind==='goal.send_intent'&&entry.operationId===op.id&&
    entry.goalId===goal.id&&entry.chatUrl===url&&entry.consumed!==true;
  const foreignGrant=m=>Object.entries(m.active||{}).some(([owner,a])=>
    (a.operationId===op.id||a.chatUrl===url)&&!(Number(owner)===tabId&&ownGrant(a)));
  if(!meta||meta.active?.[tabId]&&!ownGrant(meta.active[tabId])||foreignGrant(meta))return;
  // intent is persisted before journal admission. A positively failed
  // pre-admission write is recoverable only with a complete, gap-free journal.
  const noGrant=async()=>{
    const j=await readJournal();
    if(!j.ok||j.storageError||j.events.length!==j.meta?.sequence||
        j.events.some((e,i)=>e.sequence!==i+1))return false;
    const own=j.events.filter(e=>e.operationId===op.id);
    const intents=own.filter(e=>e.kind==='goal.send_intent');
    const releaseSafe=!intents.length||intents.length===1&&ownGrant(j.meta.active?.[tabId])&&
      own.some(e=>e.kind==='draft.not_clicked'&&e.sequence>intents[0].sequence);
    return releaseSafe&&own.some(e=>e.kind==='goal.blocked')&&own.some(e=>e.kind==='goal.dispatch_failed')&&
      !own.some(e=>['send.authorized','send.dispatched','request.started'].includes(e.kind))&&
      !j.events.some(e=>e.kind==='request.started'&&e.sourceUrl===url&&e.eventAt>=op.createdAt);
  };
  if(!await noGrant())return;
  const ready=await chrome.tabs.sendMessage(tabId,{type:'CHATGPT_GOAL_READINESS',url});
  if(!ready?.ok||ready.idle!==true||ChatGPTGoalPolicy.canonical((await chrome.tabs.get(tabId)).url)!==url)return;
  const current=(await chrome.storage.local.get(key))[key];
  const freshMeta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
  if(JSON.stringify(current)!==JSON.stringify(goal)||!freshMeta||
      freshMeta.active?.[tabId]&&!ownGrant(freshMeta.active[tabId])||foreignGrant(freshMeta))return;
  if(!await noGrant())return;
  if(ownGrant(freshMeta.active?.[tabId])) {
    await appendJournal({kind:'goal.unsent_release',sourceUrl:url,goalId:goal.id,operationId:op.id}, {id:tabId,url});
  }
  return goalController.retryPreparation({url,tabId,id:goal.id,operationId:op.id,noGrantVerified:op.status==='intent'});
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
      !Number.isFinite(native.userSentAtMs)||!(Math.abs(native.userSentAtMs-startedAt)<=10000||
        proof?.sendWindow&&native.userSentAtMs>=proof.sendWindow.notBefore&&native.userSentAtMs<=proof.sendWindow.notAfter)||
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
      rawExact:native.goalRawExact===true,nativeMarkerPending:native.goalMarkerPending===true,nativeVerified:true});
  return result;
}

async function bindNativeManualSupplement(tabId,url) {
  // Drain persisted requests chronologically; never drop an older unbound
  // clarification when a newer request supersedes the volatile receipt.
  for(let count=0;count<100;count++) {
    const result=await bindNextNativeManualSupplement(tabId,url);
    if(result.pending||result.ok===false)return result;
    if(!(await goalController.get(url))?.manualPending)return result;
  }
  return {ok:true,pending:true};
}
async function bindNextNativeManualSupplement(tabId,url) {
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
      func:inspectCompletedTurn,args:[url,true,null,pending.startedAt,null,pending.text]});
    const native=checked?.result,current=await goalController.get(url);
    if(!native?.ok||native.historicalUserBound!==true||native.isReadOnly!==false||native.url!==url||!native.userId||!native.promptKey||
        !Number.isFinite(native.userSentAtMs)||Math.abs(native.userSentAtMs-pending.startedAt)>10000||
        !ChatGPTGoalPolicy.submittedTextMatches(pending.text,native.userText,native.userVisibleText,pending.linkTargets)||
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
      userId:native.userId,response:native.goalResponse||'',rawExact:native.goalRawExact===true,nativeMarkerPending:native.goalMarkerPending===true,nativeVerified:true});
  return {ok:true,pending:false};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if(message?.type==='CHATGPT_HANDOFF_SUCCESSOR') {
    const url=messageChatUrl(message,sender);
    if(!url){sendResponse?.({ok:false});return false;}
    recoverHandoffSuccessor(sender.tab.id,url).then(sendResponse).catch(e=>sendResponse?.({ok:false,reason:String(e?.message||e)}));return true;
  }
  if(message?.type==='CHATGPT_GOAL_SUPPLEMENT_BIND') {
    const url=messageChatUrl(message,sender);
    if(!url){sendResponse?.({ok:false});return false;}
    bindNativeManualSupplement(sender.tab.id,url).then(sendResponse).catch(()=>sendResponse?.({ok:false,pending:true}));return true;
  }
  if(message?.type==='CHATGPT_GOAL_INLINE') {
    const tabId=sender.tab?.id,source=ChatGPTGoalPolicy.pageUrl(sender.tab?.url);
    const requested=ChatGPTGoalPolicy.pageUrl(message.url);
    const actions=['get','arm','disarm','intent','bind','restore','start','pause','resume','stop'];
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
      if(message.action==='restore')return restoreMissingComposerGoal(tabId,live,message.armId,true);
      if(message.action==='arm')result=await goalController.composerArm({tabId,url:live,rules:message.rules,
        maxContinuations:message.maxContinuations,maxMinutes:message.maxMinutes});
      else if(message.action==='disarm')result=await goalController.composerDisarm({tabId,armId:message.armId});
      else if(message.action==='intent')result=await goalController.composerIntent({tabId,url:requested,
        armId:message.armId,eventAt:message.eventAt,text:message.text,baselineKey:message.baselineKey,linkTargets:message.linkTargets});
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
      if(message.action==='get'&&url) {
        const record=await goalController.get(url);
        // The panel needs a current snapshot immediately. Slow page probes and
        // recovery keep running separately and publish changes through storage.
        setTimeout(async()=>{
          try {
            if(pending?.phase==='intent')await bindNativeComposerGoal(tabId,url,pending.id);
            if(typeof reconcileBlockedManualHandoff==='function')await reconcileBlockedManualHandoff(tabId,url);
            if(typeof reconcileCompletedSourceHandoff==='function')await reconcileCompletedSourceHandoff(tabId,url);
            if(typeof reconcileNativeGoalAcknowledgement==='function')await reconcileNativeGoalAcknowledgement(tabId,url);
            if(typeof reconcileAcceptedHandoffGoal==='function')await reconcileAcceptedHandoffGoal(tabId,url);
            if(typeof reconcileGoalPreparation==='function')await reconcileGoalPreparation(tabId,url);
          } catch {}
        },0);
        return {ok:true,tabId,url:live,record,composer:pending};
      }
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
      if(message.type==='CHATGPT_GOAL_RECOVER'){
        const pending=await goalController.composerGet({tabId});
        if(pending?.phase==='intent') {
          if(ChatGPTGoalPolicy.canonical(url)){try{await bindNativeComposerGoal(tabId,url,pending.id);}catch{/* Keep a readable exact-body intent observable; never replay its original send. */}}
          const current=await goalController.composerGet({tabId});
          if(current?.phase==='bound'){const marker=await reconcileGoalMarker(tabId,url);if(marker)return marker;}
          return {ok:true,pending:current?.phase==='intent',armId:current?.id,
            canRetry:current?.phase==='intent'&&!current.requestCandidateAmbiguous&&Boolean(current.request?.requestId)&&
              Date.now()<current.request.startedAt+current.config.maxMinutes*60000};
        }
        if(typeof reconcileBlockedManualHandoff==='function')await reconcileBlockedManualHandoff(tabId,url);
        if(typeof reconcileCompletedSourceHandoff==='function')await reconcileCompletedSourceHandoff(tabId,url);
        const marker=await reconcileGoalMarker(tabId,url);if(marker)return marker;
        const answer=await reconcileWaitingGoalAnswer(tabId,url);if(answer?.ok||answer?.pendingMarker)return answer;
        const goal=await goalController.get(url);
        if(goal?.phase==='blocked'&&goal.operation?.status==='reserved'&&
            ['Отправка отменена: Чат занят или другой механизм восстановления активен',
              'Отправка отменена: Поле сообщения недоступно',
              'Отправка отменена: Черновик или вложение пользователя имеют приоритет; Goal остановлен без изменения ввода'].includes(goal.reason)&&
            !goal.pauseRequested&&!goal.stopRequested&&!goal.manualPending&&!goal.manualOverride&&Date.now()<goal.deadlineAt) {
          const recovered=await reconcileGoalPreparation(tabId,url);
          if(!recovered?.ok)return {ok:true,pending:true,canRetry:true};
          return {ok:true};
        }
        // Unavailable native probes must not hide a persisted Goal. The
        // coordinator still enforces pending and unknown-send fences.
        await bindNativeManualSupplement(tabId,url).catch(()=>({ok:false,pending:true}));
        await reconcileGoalPromptBinding(tabId,url).catch(()=>({ok:false}));
        return goalController.recoverTab({id:tabId,url});
      }
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
      let result=results[0]?.result || {ok:false,reason:'Нет подтверждения остановки'};
      if(result.needsIdleProof===true)result=await proveInactiveRecoveryIdle(sender.tab.id,url,message,initial,result)||result;
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
          const key=ChatGPTGoalPolicy.RETRY_MESSAGE_KEY;
          const configured=ChatGPTGoalPolicy.retryMessage((await chrome.storage.local.get(key))[key]);
          if (options.text !== configured || options.text !== ChatGPTGoalPolicy.retryMessage(active.retryText) || options.fileName || options.requireMax || options.expectedEffort !== undefined || options.expectedModel !== undefined) throw new Error('The retry message changed or does not match the authorized text');
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
        if(active.kind==='retry.send_intent'){
          const currentGoal=await goalController.get(options.url);
          if(currentGoal&&(currentGoal.stopRequested||currentGoal.pauseRequested||['stopped','paused'].includes(currentGoal.phase)))
            throw new Error('Goal остановлен или приостановлен перед повторной отправкой');
        }
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
    if(['retry.manual_reset','retry.preparation_superseded','retry.preparation_recovered','handoff.superseded','goal.unsent_release'].includes(event.kind)) {
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
    prepareEvent().catch(()=>event).then(verified=>appendJournal(verified,sender.tab)).then(async result=>{
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
      func: controlChatComposer, args: [{action:'inspect-attachment',fileName:message.fileName,url:sender.tab.url}]
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
      if(message.action==='update') {
        const ok=await completionCheckpointUpdate(tabId,{url,startedAt:message.startedAt,requestId:message.requestId,baselineKey:message.baselineKey,promptKey:message.promptKey,httpCompleted:message.httpCompleted});
        if(ok)await bindCompletionNativeIdentity(tabId,url,await completionCheckpointRead(tabId));
        return {ok};
      }
      const detached=await reconcileDetachedReply(tabId,url);
      if(detached.changed)return {ok:false,detached};
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
            !native.promptKey||!native.userId||!Number.isFinite(native.lastUserSentAtMs)||
            Math.abs(native.lastUserSentAtMs-record.startedAt)>10000)return {ok:false};
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
        const identity=await recoverCompletionSenderIdentity(tabId,url,record,checked?.result);
        const rebound=completionPromptRebindEvidence({...record,...identity},url,checked?.result);
        if(rebound) {
          const latest=await latestRequestReceipt(tabId),live=await readChatStatus(url);
          if(latest&&(latest.startedAt!==record.startedAt||latest.requestId!==record.requestId)||
              live.status?.kind!=='loading'||live.status.eventAt!==record.startedAt||
              completionCheckpointUrl((await chrome.tabs.get(tabId)).url)!==url)return {ok:false};
          const changed=await completionCheckpointChange(tabId,current=>
            JSON.stringify(current)===JSON.stringify(record)?
              {record:{...current,...identity,...rebound},value:true}:{value:false});
          if(!changed)return {ok:false};
          record={...record,...identity,...rebound};
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
      const native=await inspectBoundNativeTurn(sender.tab.id,url);
      const tab=await chrome.tabs.get(sender.tab.id);
      if(manualRequestReceiptsByTab.get(sender.tab.id)!==initial||ChatGPTHandoffTitle.chatUrl(tab.url)!==url)return {ok:false,reason:'attempt-changed'};
      if(!initial){
        const liveProgress=native.turnStatus==='in_progress'&&native.generating===true;
        const boundFinal=typeof message.boundPromptKey==='string'&&message.boundPromptKey&&message.boundPromptKey===native.promptKey&&
          native.turnStatus==='complete'&&native.generating===false&&native.assistantCompleted===true&&
          native.assistantPhase==='final_answer'&&Boolean(native.assistantId)&&Boolean(native.assistantKey);
        const boundReasoningFailure=checkpoint?.state==='active'&&checkpoint.promptKey===message.boundPromptKey&&
          native.promptKey===checkpoint.promptKey&&native.reasoningFailed===true&&native.generating===false;
        const boundEmptyFailure=checkpoint?.httpCompleted===true&&checkpoint.promptKey===message.boundPromptKey&&
          native.promptKey===checkpoint.promptKey&&native.terminalEmptyResponse===true&&native.nativeConversationInactive===true&&native.generating===false;
        if(!native.ok||(!liveProgress&&!boundFinal&&!boundReasoningFailure&&!boundEmptyFailure)||native.isLatest!==true||native.isReadOnly!==false||native.hasError!==false||!native.promptKey||!native.userId)return {ok:false,reason:'unbound-existing-request'};
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
    let completionRequest=isWarning?manualRequestReceiptsByTab.get(tabId)||null:await latestRequestReceipt(tabId);
    if(isError&&!completionRequest)completionRequest=await readRestartErrorReceipt(tabId,sourceUrl,message);
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

    let suppressGoalNotice=false,acceptedGoalMarker=false,goalAnswerIncomplete=false,goalBlocked=false;
    if(!isError&&!isWarning) {
      const goalAnswer={url:sourceUrl,tabId,completionKey:rawCompletionKey,
        promptKey:message.goalPromptKey,response:message.response,nativeVerified:message.goalNativeVerified,
        rawExact:message.goalRawExact,userId:message.goalNativeUserId,nativeMarkerPending:message.goalNativeMarkerPending===true};
      try {
        await reconcileNativeGoalAcknowledgement(tabId,sourceUrl).catch(()=>null);
        await bindNativeManualSupplement(tabId,sourceUrl).catch(()=>({ok:false,pending:true}));
        const armed=await goalController.composerGet({tabId});
        if(armed?.phase==='intent')await bindNativeComposerGoal(tabId,sourceUrl,armed.id);
        if(goalAnswer.nativeVerified===true&&typeof message.response==='string'&&
            ([ChatGPTGoalPolicy.MARKER,ChatGPTGoalPolicy.BLOCKED_MARKER].some(m=>message.response.startsWith(m))||goalAnswer.nativeMarkerPending)) {
          const [checked]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[sourceUrl,true]});
          const native=checked?.result;
          goalAnswer.rawExact=false;goalAnswer.nativeMarkerPending=true;
          if(native?.ok&&native.isLatest===true&&native.isReadOnly===false&&!native.hasError&&!native.generating&&
              native.turnStatus==='complete'&&native.assistantCompleted===true&&native.assistantPhase==='final_answer'&&
              native.userId===goalAnswer.userId&&native.promptKey===goalAnswer.promptKey&&
              native.promptKey+'|'+native.assistantKey===rawCompletionKey) {
            goalAnswer.nativeMarkerPending=native.goalMarkerPending===true;
            if(native.goalRawExact===true&&ChatGPTGoalPolicy.terminalMarker(native.goalResponse,true,true)) {
              goalAnswer.response=native.goalResponse;goalAnswer.rawExact=true;
            }
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
        const goalResult=await goalController.completion(goalAnswer);
        if(goalResult?.pendingMarker){
          if(lastNotificationFingerprintByTab.get(tabId)===completionKey)lastNotificationFingerprintByTab.delete(tabId);
          return; // The durable marker witness wakes shared Goal observation; no success notice or continuation yet.
        }
        goalAnswerIncomplete=goalResult?.ok===true&&goalResult.record?.phase!=='completed';
        acceptedGoalMarker=goalResult?.ok===true&&ChatGPTGoalPolicy.terminalMarker(goalAnswer.response,goalAnswer.rawExact,goalAnswer.nativeVerified);
        goalBlocked=goalResult?.ok===true&&ChatGPTGoalPolicy.exactBlockedMarker(goalAnswer.response,goalAnswer.rawExact,goalAnswer.nativeVerified);
      } catch(error) { console.error('Goal completion reconciliation failed',error); }
      const currentGoal=sourceUrl?await goalController.get(sourceUrl):null;
      // handoffConfirm may already have consumed this exact terminal answer.
      // Reuse its persisted result, never a different previously blocked Goal.
      if(currentGoal&&currentGoal.lastCompletionKey===rawCompletionKey&&currentGoal.expectedPromptKey===goalAnswer.promptKey&&
          ['completed','blocked'].includes(currentGoal.phase)&&ChatGPTGoalPolicy.terminalMarker(goalAnswer.response,goalAnswer.rawExact,goalAnswer.nativeVerified)) {
        acceptedGoalMarker=true;
        goalBlocked=currentGoal.phase==='blocked'&&ChatGPTGoalPolicy.exactBlockedMarker(goalAnswer.response,goalAnswer.rawExact,goalAnswer.nativeVerified);
      }
      suppressGoalNotice=Boolean((goalAnswerIncomplete||currentGoal&&!['completed','stopped'].includes(currentGoal.phase))&&!acceptedGoalMarker);
      if(suppressGoalNotice)journalInBackground({kind:'goal.notification_suppressed',sourceUrl,goalId:currentGoal.id,reason:'goal-incomplete'},sender.tab);
    }
    journalInBackground({kind:isWarning?'operation.warning':isError?'notification.requested':'response.complete', response:message.response,
      sourceUrl,warningKind:message.warningKind,operationId:message.operationId,durationMs:message.durationMs,retryReason:message.retryReason,attemptId:message.attemptId},sender.tab);
    const notification={tabId,title:`${isWarning?'⚠️ ':isError||goalBlocked?'❌ ':''}${cleanSessionTitle(message.sessionTitle)}`,
      message:truncateResponse(message.response),isError:isError||goalBlocked,isWarning,durationMs:message.durationMs,retryReason:message.retryReason||''};
    if(movedWarning){await emitBoth(notification);return;}
    const reserve=(!isWarning&&!isError?completionCheckpointRead(tabId).then(record=>!record||record.state==='active'&&record.startedAt===message.completionStartedAt&&(!record.requestId||record.requestId===message.requestId)):Promise.resolve(true))
      .then(accepted=>accepted&&sourceUrl?reserveChatNotification(sourceUrl,tabId,isWarning?'warning':isError||goalBlocked?'error':'success',eventAt,receipt):null);

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
      if(suppressGoalNotice)return completeChatNotification(reserved.ticket,false);
      return emitBoth({...notification,ticket:reserved.ticket});
    },async error=>{
      console.error('Prompt-Bound Alert: status reservation failed',error);
      // Storage failure must not silence the only alert. Keep this unbound:
      // no invented status or notification receipt, and no fallback resend.
      const tab=await chrome.tabs.get(tabId);
      if(ChatGPTHandoffTitle.chatUrl(tab.url)!==sourceUrl||!isWarning&&(manualRequestReceiptsByTab.get(tabId)||null)!==completionRequest)return;
      if(!suppressGoalNotice)await emitBoth(notification);
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
          eventAt:message.eventAt,text:message.text,baselineKey:message.baselineKey,linkTargets:message.linkTargets});
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
