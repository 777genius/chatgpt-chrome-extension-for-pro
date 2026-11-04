'use strict';

// Per-chat status and notification receipts survive service-worker suspension.
// A visit retires a generation, including a notification still being created;
// it preserves the terminal color while acknowledging its unread badge.
// Request starts enter loading; terminal
// results and trusted manual sends are ordered by their captured receipts.
const statusEpoch=`${Date.now()}:${Math.random()}`;
let statusReceiptSequence=0;
const statusWrites=new Map();
const STATUS_MIGRATION_KEY='chatgpt-status:migration';
let statusMigrationPromise=null;
function statusReceipt() { return {epoch:statusEpoch,order:++statusReceiptSequence}; }
function statusKey(url) { return `chatgpt-status:${url}`; }
function migrateChatStatuses() {
  if(statusMigrationPromise)return statusMigrationPromise;
  const migration=(async()=>{
    if((await chrome.storage.local.get(STATUS_MIGRATION_KEY))[STATUS_MIGRATION_KEY]?.schema===1)return;
    const meta=(await chrome.storage.local.get(JOURNAL_META))[JOURNAL_META];
    const through=Number.isSafeInteger(meta?.sequence)&&meta.sequence>=0?meta.sequence:0;
    const active=new Set(Object.keys(await chrome.notifications.getAll?.()||{}));
    const states=new Map(),notices=new Map(),manuals=new Map(),bindings=new Map(),uncertain=new Set();
    const firstChatByTab=new Map(),ambiguousTabs=new Set();
    const at=row=>Number.isFinite(row.eventAt)?row.eventAt:Number.isFinite(row.recordedAt)?row.recordedAt:0;
    const stateFor=url=>{
      if(!states.has(url))states.set(url,{url,revision:0,sequence:0,returnedThrough:0,status:null,notifications:[]});
      return states.get(url);
    };
    for(let first=1;first<=through;first+=50) {
      const keys=Array.from({length:Math.min(50,through-first+1)},(_,index)=>
        `${JOURNAL_PREFIX}${String(first+index).padStart(12,'0')}`);
      const batch=await chrome.storage.local.get(keys);
      for(let index=0;index<keys.length;index++) {
        const row=batch[keys[index]];
        if(!row)continue;
        const sequence=first+index,url=ChatGPTHandoffTitle.chatUrl(row.sourceUrl);
        if(Number.isInteger(row.tabId))for(const candidate of [url,ChatGPTHandoffTitle.chatUrl(row.observedTabUrl),ChatGPTHandoffTitle.chatUrl(row.changes?.url)]) {
          if(!candidate)continue;
          const firstChat=firstChatByTab.get(row.tabId);
          if(firstChat&&firstChat!==candidate)ambiguousTabs.add(row.tabId);
          else if(!firstChat)firstChatByTab.set(row.tabId,candidate);
        }
        if(['notification.requested','response.complete'].includes(row.kind)) {
          const isError=row.kind==='notification.requested';
          if(!url||!Number.isInteger(row.tabId))continue;
          const state=stateFor(url);
          state.sequence=sequence;state.revision=sequence;
          // The old journal proves a result, but cannot prove whether it was
          // viewed. Do not invent unread history while importing it.
          state.status={kind:isError?'error':'success',eventAt:at(row),sequence,receipt:{epoch:'journal',order:sequence},unread:false};
          const pending=notices.get(row.tabId)||[];
          pending.push({url,isError,title:`${isError?'❌ ':''}${cleanSessionTitle(row.title)}`,preview:truncateResponse(row.response)});
          notices.set(row.tabId,pending);
        } else if(row.kind==='retry.manual_reset'&&url&&Number.isInteger(row.tabId)) {
          manuals.set(row.tabId,{url,at:at(row)});
        } else if(row.kind==='request.started'&&row.automatic===false&&url) {
          const manual=manuals.get(row.tabId);
          if(manual?.url===url&&at(row)>=manual.at&&at(row)-manual.at<=10000) {
            manuals.delete(row.tabId);
            const state=states.get(url);
            if(state) {
              state.status=null;state.sequence=sequence;state.revision=sequence;
              state.manualThrough={epoch:'journal',order:sequence};
            }
          }
        } else if(row.kind==='notification.result'&&row.warning!==true&&row.notification==='fulfilled'&&active.has(row.notificationId)&&
            /^chatgpt-prompt-bound:\d+:/.test(row.notificationId)) {
          const pending=notices.get(row.tabId)||[],id=row.notificationId;
          const matches=pending.filter(notice=>url===notice.url&&row.isError===notice.isError&&
            String(row.title||'').replace(/\s+/g,' ').trim()===notice.title&&truncateResponse(row.message)===notice.preview&&
            Number(/^chatgpt-prompt-bound:(\d+):/.exec(id)[1])===row.tabId);
          if(matches.length!==1||bindings.has(id)&&bindings.get(id).url!==url) {
            bindings.delete(id);uncertain.add(id);continue;
          }
          if(uncertain.has(id))continue;
          notices.set(row.tabId,pending.filter(notice=>notice!==matches[0]));
          bindings.set(id,{id,url,tabId:row.tabId,sequence,receipt:{epoch:'journal',order:sequence},state:'created'});
          stateFor(url).sequence=Math.max(stateFor(url).sequence,sequence);
        }
      }
    }
    // Legacy result rows could inherit a tab's later SPA URL. Identical titles
    // and previews do not prove identity once that tab has shown two chats.
    for(const ticket of bindings.values())if(!ambiguousTabs.has(ticket.tabId))stateFor(ticket.url).notifications.push(ticket);
    const records=Array.from(states.values()),writes={};
    // Do not replace a status already created by an earlier extension version.
    // All live status operations await this one migration promise.
    for(let first=0;first<records.length;first+=50) {
      const group=records.slice(first,first+50),keys=group.map(record=>statusKey(record.url));
      const existing=await chrome.storage.local.get(keys);
      for(const record of group)if(!Object.hasOwn(existing,statusKey(record.url))||existing[statusKey(record.url)]==null)writes[statusKey(record.url)]=record;
    }
    await chrome.storage.local.set({...writes,[STATUS_MIGRATION_KEY]:{schema:1,throughSequence:through,migratedAt:Date.now()}});
  })();
  statusMigrationPromise=migration;
  void migration.catch(()=>{if(statusMigrationPromise===migration)statusMigrationPromise=null;});
  return migration;
}
function statusBefore(value,fence) {
  if(!value)return true;
  if(value.epoch===fence.epoch)return value.order<=fence.order;
  // Only this worker's receipts are known to follow retained prior epochs.
  // Two historical workers have no trustworthy ordering after another restart.
  return fence.epoch===statusEpoch&&value.epoch!==statusEpoch;
}
function statusView(record) {
  const pending=record.deferred,status=record.status;
  const newerActive=status&&['loading','error'].includes(status.kind)&&pending&&statusBefore(pending.receipt,status.receipt);
  return {url:record.url,status:pending&&!newerActive?{kind:'deferred',eventAt:pending.eventAt,receipt:pending.receipt,unread:false}:status,revision:record.revision};
}
function consumeDeferredCard(record,key) {
  if(!key)return;
  const keys=(record.consumedDeferredCards||[]).filter(item=>item!==key);
  record.consumedDeferredCards=[...keys,key].slice(-32);
}
function retireDeferredForRequest(record,receipt) {
  if(!record.deferred||!statusBefore(record.deferred.receipt,receipt))return false;
  consumeDeferredCard(record,record.deferred.cardKey);delete record.deferred;record.revision++;return true;
}
function updateDeferredChat(url,event,receipt) {
  return withChatStatus(url,record=>{
    const key=typeof event.cardKey==='string'&&event.cardKey.length<=1000?event.cardKey:'';
    if(!key||!['pending','unknown','resumed','none'].includes(event.phase))return {value:statusView(record)};
    const pendingReceipt=record.deferred?.observedThrough||record.deferred?.receipt;
    if(pendingReceipt&&!statusBefore(pendingReceipt,receipt))return {value:statusView(record)};
    const legacyCard=record.deferred&&event.phase==='none'&&['historical-card','task-disabled'].includes(event.reason)&&
      record.deferred?.anchorKey===event.anchorKey&&record.deferred.cardKey.startsWith(`${event.anchorKey}|`);
    const matching=record.deferred?.cardKey===key||legacyCard;
    if(['pending','unknown'].includes(event.phase)) {
      if((record.consumedDeferredCards||[]).includes(key)||event.phase==='unknown'&&!matching)return {value:statusView(record)};
      if(matching&&record.deferred.phase===event.phase){record.deferred.observedThrough=receipt;return {write:true,value:statusView(record)};}
      record.deferred=matching?{...record.deferred,phase:event.phase,observedThrough:receipt}:{cardKey:key,anchorKey:String(event.anchorKey||'').slice(0,500),taskId:typeof event.taskId==='string'?event.taskId.slice(0,200):null,phase:event.phase,eventAt:Date.now(),receipt,observedThrough:receipt};
      record.revision++;return {write:true,value:statusView(record)};
    }
    if(event.phase==='resumed')consumeDeferredCard(record,key);
    if(!matching)return {write:event.phase==='resumed',value:statusView(record)};
    const newerActive=record.status&&['error','loading'].includes(record.status.kind)&&statusBefore(record.deferred.receipt,record.status.receipt);
    consumeDeferredCard(record,record.deferred.cardKey);consumeDeferredCard(record,key);delete record.deferred;
    if(!newerActive&&event.phase==='resumed'&&event.generating===true&&Number.isFinite(event.startedAt)&&event.startedAt>0&&(!record.status||statusBefore(record.status.receipt,receipt))) {
      record.status={kind:'loading',eventAt:event.startedAt,receipt,observed:true};
    }
    record.revision++;return {write:true,value:statusView(record)};
  });
}
function withChatStatus(url,change) {
  const prior=statusWrites.get(url)||Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{
    await migrateChatStatuses();
    const key=statusKey(url);
    const record=(await chrome.storage.local.get(key))[key]||{url,revision:0,sequence:0,returnedThrough:0,status:null,notifications:[]};
    const legacyTerminal=['error','success'].includes(record.status?.kind)&&typeof record.status.unread!=='boolean';
    if(legacyTerminal)record.status={...record.status,unread:false};
    const result=await change(record);
    if(result.write||legacyTerminal)await chrome.storage.local.set({[key]:record});
    return result.value;
  });
  statusWrites.set(url,next);
  void next.finally(()=>{if(statusWrites.get(url)===next)statusWrites.delete(url);}).catch(()=>{});
  return next;
}
function readChatStatus(url) { return withChatStatus(url,record=>({value:statusView(record)})); }
// A request can start at '/' before ChatGPT allocates its permanent chat URL.
// Native generation controls may seed only a virgin status, never a known result.
function observeChatLoading(url,eventAt,receipt) {
  return withChatStatus(url,record=>{
    if(record.revision!==0||record.status||record.manualThrough||record.loadingStoppedThrough)return {value:statusView(record)};
    record.status={kind:'loading',eventAt,receipt,observed:true};record.revision++;
    return {write:true,value:statusView(record)};
  });
}
function markChatLoading(url,eventAt,receipt) {
  return withChatStatus(url,record=>{
    if(record.loadingStoppedThrough&&statusBefore(receipt,record.loadingStoppedThrough))return {value:statusView(record)};
    if(record.manualThrough&&!statusBefore(record.manualThrough,receipt))return {value:statusView(record)};
    const retired=retireDeferredForRequest(record,receipt);
    if(record.status&&!statusBefore(record.status.receipt,receipt))return {write:retired,value:statusView(record)};
    if(record.status?.kind==='loading'&&record.status.receipt?.epoch===receipt.epoch&&record.status.receipt?.order===receipt.order)return {write:retired,value:statusView(record)};
    record.status={kind:'loading',eventAt,receipt};record.revision++;
    return {write:true,value:statusView(record)};
  });
}
function stopChatLoading(url,startedAt,receipt,startReceipt=null) {
  return withChatStatus(url,record=>{
    // Millisecond timestamps can identify multiple requests. Only the caller's
    // bound generation receipt can authorize a stop; an unbound cancelled send
    // says nothing about a scheduled task that is still waiting.
    const generation=startReceipt;
    if(!generation||typeof generation.epoch!=='string'||!Number.isSafeInteger(generation.order)||generation.order<=0||
        !Number.isFinite(startedAt)||startedAt<=0||!statusBefore(generation,receipt))return {value:statusView(record)};
    const matching=record.status?.kind==='loading'&&record.status.eventAt===startedAt&&
      record.status.receipt?.epoch===generation.epoch&&record.status.receipt?.order===generation.order;
    if(!record.loadingStoppedThrough||!statusBefore(generation,record.loadingStoppedThrough))record.loadingStoppedThrough=generation;
    if(matching&&statusBefore(record.status.receipt,receipt)){record.status=null;record.revision++;}
    return {write:true,value:statusView(record)};
  });
}
function reserveChatNotification(url,tabId,kind,eventAt,receipt,expected=null) {
  return withChatStatus(url,record=>{
    if(expected&&(record.revision!==expected.revision||record.status?.kind!=='loading'||record.status.eventAt!==expected.startedAt||record.status.receipt?.epoch!==expected.receipt?.epoch||record.status.receipt?.order!==expected.receipt?.order))return {value:null};
    const sequence=++record.sequence;
    const ticket={id:`chatgpt-prompt-bound:${tabId}:${eventAt}:${sequence}:${encodeURIComponent(url)}`,
      url,tabId,sequence,receipt,state:'creating'};
    record.notifications.push(ticket);
    if(['error','success'].includes(kind)&&(!record.status||statusBefore(record.status.receipt,receipt))&&(!record.manualThrough||!statusBefore(receipt,record.manualThrough))) {
      record.status={kind,eventAt,sequence,receipt,unread:!record.viewedThrough||!statusBefore(receipt,record.viewedThrough)};
      record.revision++;
    }
    return {write:true,value:{ticket,view:statusView(record)}};
  });
}
async function clearTrackedNotification(url,id) {
  try {await chrome.notifications.clear(id);} catch {return;}
  await withChatStatus(url,record=>{
    // Keep unresolved creates until their callback can apply the visit fence.
    record.notifications=record.notifications.filter(item=>item.id!==id||item.state==='creating');
    return {write:true};
  });
}
async function completeChatNotification(ticket,created) {
  const clear=await withChatStatus(ticket.url,record=>{
    const entry=record.notifications.find(item=>item.id===ticket.id);
    if(!created)record.notifications=record.notifications.filter(item=>item.id!==ticket.id);
    else if(entry)entry.state='created';
    return {write:true,value:created&&(ticket.sequence<=record.returnedThrough||entry?.closed===true)};
  });
  if(clear)await clearTrackedNotification(ticket.url,ticket.id);
}
function closeChatNotification(url,id) {
  return withChatStatus(url,record=>{
    const entry=record.notifications.find(item=>item.id===id);
    if(!entry)return {};
    if(entry.state==='creating')entry.closed=true;
    else record.notifications=record.notifications.filter(item=>item.id!==id);
    return {write:true};
  });
}
function markStatusViewed(record,receipt) {
  if(!record.viewedThrough||!statusBefore(receipt,record.viewedThrough))record.viewedThrough=receipt;
  if(['error','success'].includes(record.status?.kind)&&record.status.unread===true&&statusBefore(record.status.receipt,receipt)) {
    record.status={...record.status,unread:false};record.revision++;
    return true;
  }
  return false;
}
function markChatViewed(url,receipt) {
  return withChatStatus(url,record=>{
    const seenChanged=markStatusViewed(record,receipt);
    return {write:true,value:{...statusView(record),seenChanged}};
  });
}
async function visitChatNotifications(url,receipt,{manual=false,startedAt=null}={}) {
  const result=await withChatStatus(url,record=>{
    const selected=record.notifications.filter(item=>statusBefore(item.receipt,receipt));
    record.returnedThrough=Math.max(record.returnedThrough,...selected.map(item=>item.sequence));
    const seenChanged=markStatusViewed(record,receipt);
    if(manual) {
      retireDeferredForRequest(record,receipt);
      if((!record.status||statusBefore(record.status.receipt,receipt))&&(!record.loadingStoppedThrough||!statusBefore(receipt,record.loadingStoppedThrough)))record.status=Number.isFinite(startedAt)?{kind:'loading',eventAt:startedAt,receipt}:null;
      if(!record.manualThrough||!statusBefore(receipt,record.manualThrough))record.manualThrough=receipt;
      record.revision++;
    }
    return {write:true,value:{ids:selected.map(item=>item.id),view:statusView(record),seenChanged}};
  });
  await Promise.allSettled(result.ids.map(id=>clearTrackedNotification(url,id)));
  return {...result.view,seenChanged:result.seenChanged};
}
