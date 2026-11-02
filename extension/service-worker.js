'use strict';
importScripts('page-probe.js');
importScripts('journal-store.js');
importScripts('handoff-title.js');
importScripts('status-store.js');
importScripts('status-animation.js');
importScripts('chat-title-probe.js');
importScripts('handoff-renamer.js');

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

async function emitBoth({ tabId = null, title = 'ChatGPT', message = 'Response finished.', isTest = false, isError = false, durationMs = null, retryReason = '', ticket = null } = {}) {
  const id = ticket?.id || (isTest
    ? `chatgpt-prompt-bound-test:${Date.now()}`
    : `chatgpt-prompt-bound:${tabId}:${Date.now()}`);

  const [soundResult, notificationResult] = await Promise.allSettled([
    playCompletionSound(),
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: isTest?'icons/icon128.png':isError?'icons/status-error.png':'icons/status-success.png',
      title: isTest ? 'Background alert test' : title,
      message,
      contextMessage: isTest
        ? 'Sound + desktop notification dispatched by the extension'
        : [formatDuration(durationMs, isError), retryReason].filter(Boolean).join(' · '),
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
  journalInBackground({ kind: 'notification.result', tabId, notificationId: id, title, message, isError, durationMs,
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
  if(url&&await visibleChatTab(tabId,url))await visitChatNotifications(url,receipt);
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
      files: ['memory-maintenance.js', 'handoff-title.js', 'status-indicator.js', 'content-script.js']
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
    try { await chrome.scripting.executeScript({target:{tabId:tab.id},files:['memory-maintenance.js','handoff-title.js','status-indicator.js','content-script.js']}); }
    catch (error) { journalInBackground({kind:'watcher.unavailable',reason:String(error.message || error)},tab); }
  }));
}
chrome.runtime.onInstalled.addListener(() => installErrorWatchers().catch(console.warn));
chrome.runtime.onStartup.addListener(() => installErrorWatchers().catch(console.warn));
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  const receipt=statusReceipt();
  manualRequestReceiptsByTab.set(details.tabId,{startedAt:details.timeStamp,receipt,url:ChatGPTHandoffTitle.chatUrl(details.documentUrl)});
  // Use the source captured by the serialized journal, never a later tab URL.
  void journalRequest('request.started',details).then(async event=>{
    const url=ChatGPTHandoffTitle.chatUrl(event.sourceUrl);
    if(url)await broadcastChatStatus(await markChatLoading(url,details.timeStamp,receipt));
  }).catch(()=>{});
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    func: (startedAt) => { globalThis.__chatgptNotifierRequestStartedAt = startedAt; globalThis.__chatgptNotifierAttemptId = `${startedAt}`; },
    args: [details.timeStamp]
  }).then(()=>signalConversationRequestEvent(details.tabId,{type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:details.timeStamp})).catch(() => {});
}, CHATGPT_REQUEST_FILTER);

chrome.webRequest.onCompleted.addListener((details) => {
  if (!isAnswerStreamRequest(details)) return;
  void journalRequest('request.completed',details).catch(()=>{});
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  signalConversationRequestEvent(details.tabId,{type:'CHATGPT_CONVERSATION_REQUEST_COMPLETED'}).catch(() => {});
}, CHATGPT_REQUEST_FILTER);

chrome.webRequest.onErrorOccurred?.addListener((details) => {
  if (isAnswerStreamRequest(details)) void journalRequest('request.failed',details).catch(()=>{});
}, CHATGPT_REQUEST_FILTER);

const handoffWrites = new Map();
function handoffKey(tabId) { return `chatgpt-handoff:${tabId}`; }
async function handleHandoffMessage(message, tabId) {
  const key = handoffKey(tabId);
  if (message.type === 'CHATGPT_HANDOFF_GET') return { ok: true, record: (await chrome.storage.local.get(key))[key] || null };
  const previous = handoffWrites.get(tabId) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const current = (await chrome.storage.local.get(key))[key];
    if (message.type === 'CHATGPT_HANDOFF_BEGIN') {
      if(['sending','awaiting-confirmation'].includes(current?.stage))throw new Error('Предыдущая передача ещё ожидает подтверждения');
      let record = message.record;
      if (!record || typeof record.id !== 'string' || !record.sourceUrl?.startsWith('https://chatgpt.com/c/') || typeof record.text !== 'string') throw new Error('Invalid handoff');
      const marker = `${key}:source:${record.sourceUrl}`;
      if ((await chrome.storage.local.get(marker))[marker]) return { ok: false, error: 'Передача этого чата уже запускалась' };
      const lineageKey=`chatgpt-handoff-title:${ChatGPTHandoffTitle.chatUrl(record.sourceUrl)}`;
      const lineage=(await chrome.storage.local.get(lineageKey))[lineageKey];
      const naming=ChatGPTHandoffTitle.planNext({sourceUrl:record.sourceUrl,sourceTitle:record.sourceTitle,lineage});
      record={...record,naming};
      await appendJournal({kind:'handoff.navigating', operationId:record.id, sourceUrl:record.sourceUrl,
        text:record.text, prompt:record.prompt, asFile:record.asFile, fileName:record.fileName,
        draftChars:record.draft?.length || 0,sourceTitle:record.sourceTitle,naming}, {id:tabId});
      // Save the full text BEFORE navigating away from the source page.
      await chrome.storage.local.set({ [key]: { ...record, stage: 'navigating' }, [marker]: record.id });
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
      if(current.stage==='sent')return {ok:true,record:current,confirmed:true};
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
    return { ok: true, record, notifyAwaiting:message.stage==='awaiting-confirmation'&&!current.awaitingNotifiedAt };
  });
  handoffWrites.set(tabId, write);
  try { return await write; } finally { if (handoffWrites.get(tabId) === write) handoffWrites.delete(tabId); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    readRetryState(message.url).then(state=>sendResponse({ok:true,state})).catch(error=>sendResponse({ok:false,error:String(error.message||error)}));
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
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId > 0) return;
    (async()=>{
      await appendJournal({kind:'recovery.stop_intent',operationId:message.operationId,sourceUrl:message.url},sender.tab);
      const results=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:inspectChatError,
        args:[message.alertIndex,false,'stop-recovery',message.url]});
      const result=results[0]?.result || {ok:false,reason:'Нет подтверждения остановки'};
      await appendJournal({kind:result.ok?'recovery.stop_result':'recovery.stop_refused',operationId:message.operationId,stopped:result.stopped,reason:result.reason},sender.tab);
      return result;
    })().then(sendResponse).catch(error=>sendResponse({ok:false,reason:String(error.message || error)}));
    return true;
  }
  if (message?.type === 'CHATGPT_COMPOSER_CONTROL') {
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/') || sender.frameId > 0) return;
    let pageDispatchStarted=false;
    (async () => {
      const options = message.options;
      if (!['inspect','send'].includes(options?.action)) throw new Error('Неизвестное действие редактора');
      if (options.action === 'send') {
        const meta = (await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
        const active = meta?.active?.[sender.tab.id];
        if (!active || active.operationId !== options.operationId || Date.now() - active.at > 15000) throw new Error('Нет сохранённого разрешения на эту автоматическую отправку');
        if (active.kind === 'retry.send_intent') {
          if (options.text !== 'доделай е2е' || options.fileName) throw new Error('Автоповтор может отправлять только команду «доделай е2е»');
        } else if (active.kind === 'handoff.sending') {
          const key = handoffKey(sender.tab.id);
          const record = (await chrome.storage.local.get(key))[key];
          if (!record || record.stage !== 'sending' || record.id !== options.operationId || record.prompt !== options.text || !options.requireMax ||
              (options.fileName || null) !== (record.asFile ? record.fileName : null)) throw new Error('Текст не совпадает с сохранённой передачей');
        } else throw new Error('Отправка пользовательского черновика запрещена');
        await appendJournal({kind:'send.authorized',operationId:options.operationId,text:options.text,sourceUrl:options.url},sender.tab);
      }
      pageDispatchStarted=options.action==='send';
      return chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:controlChatComposer,args:[options]});
    })()
      .then(async results=>{
        const result=results[0]?.result || {ok:false,unknown:pageDispatchStarted,reason:'Редактор недоступен'};
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
      .catch(error=>sendResponse({ok:false,unknown:pageDispatchStarted,reason:String(error.message || error)}));
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
    appendJournal(event,sender.tab).then(result=>{
      sendResponse(result);
    }).catch(error=>sendResponse({ok:false,error:String(error.message || error)}));
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
      args: [message.alertIndex, Boolean(message.captureHistory)]
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

  if (message?.type === 'CHATGPT_RESPONSE_COMPLETE' || message?.type === 'CHATGPT_RESPONSE_ERROR') {
    const isError = message.type === 'CHATGPT_RESPONSE_ERROR';
    if (!sender.tab?.url?.startsWith('https://chatgpt.com/')||sender.frameId>0) return;
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return;
    // Capture the conversation before any notification or sound awaits. A
    // later SPA route must not reattribute this event to another chat.
    const sourceUrl=ChatGPTHandoffTitle.chatUrl(sender.tab.url);
    if(message.url&&(!message.url.startsWith('https://chatgpt.com/')||ChatGPTHandoffTitle.chatUrl(message.url)!==sourceUrl))return;
    const receipt=statusReceipt(),eventAt=Date.now();

    const fingerprint = String(message.fingerprint || '');
    const rawCompletionKey=String(message.completionKey||fingerprint);
    const completionKey = rawCompletionKey?`${sourceUrl}|${rawCompletionKey}`:'';
    if (!isError && completionKey && lastNotificationFingerprintByTab.get(tabId) === completionKey) return;
    if (!isError && completionKey) lastNotificationFingerprintByTab.set(tabId, completionKey);

    journalInBackground({kind:isError?'notification.requested':'response.complete', response:message.response,
      durationMs:message.durationMs,retryReason:message.retryReason,attemptId:message.attemptId},sender.tab);
    const reserve=sourceUrl?reserveChatNotification(sourceUrl,tabId,isError?'error':'success',eventAt,receipt):Promise.resolve(null);
    reserve.then(reserved=>{
      if(reserved)void broadcastChatStatus(reserved.view).catch(()=>{});
      return emitBoth({
      tabId,
      title: `${isError ? '❌ ' : ''}${cleanSessionTitle(message.sessionTitle)}`,
      message: truncateResponse(message.response),
      isError,
      durationMs: message.durationMs,
      retryReason: message.retryReason || '',ticket:reserved?.ticket||null
      });
    }).catch((error) => {
      console.error('Prompt-Bound Alert: completion alert failed', error);
    });
    return;
  }

  if (['CHATGPT_PAGE_RETURNED','CHATGPT_STATUS_GET','CHATGPT_MANUAL_SEND','CHATGPT_GENERATION_STOPPED'].includes(message?.type)) {
    const url=messageChatUrl(message,sender);
    let receipt=statusReceipt();
    if(!url){sendResponse?.({ok:false,reason:'Чат изменился'});return false;}
    if(message.type==='CHATGPT_MANUAL_SEND') {
      const request=manualRequestReceiptsByTab.get(sender.tab.id);
      if(!request||request.consumed||!Number.isFinite(message.startedAt)||request.startedAt!==message.startedAt||request.url&&request.url!==url) {
        sendResponse?.({ok:false,reason:'Ручная отправка не подтверждена текущим запросом'});return false;
      }
      receipt=request.receipt;
      request.consumed=true;
    }
    (async()=>{
      const tab=await chrome.tabs.get(sender.tab.id);
      if(ChatGPTHandoffTitle.chatUrl(tab.url)!==url)return {ok:false,reason:'Чат изменился'};
      if(message.type==='CHATGPT_STATUS_GET'){
        let view=await readChatStatus(url);
        if(message.generating===true&&!view.status&&view.revision===0){
          const request=manualRequestReceiptsByTab.get(sender.tab.id);
          const known=request?.startedAt===message.startedAt;
          view=await observeChatLoading(url,Number.isFinite(message.startedAt)&&message.startedAt>0?message.startedAt:Date.now(),known?request.receipt:receipt);
        }
        statusAnimation.set(sender.tab.id,url,view.status?.kind==='loading');
        return {ok:true,...view};
      }
      if(message.type==='CHATGPT_GENERATION_STOPPED'){
        const request=manualRequestReceiptsByTab.get(sender.tab.id);
        const startReceipt=request?.startedAt===message.startedAt&&(!request.url||request.url===url)?request.receipt:null;
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
  journalInBackground({kind:'tab.closed',tabId});
  lastNotificationFingerprintByTab.delete(tabId);
  manualRequestReceiptsByTab.delete(tabId);
  statusAnimation.remove(tabId);
});

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
