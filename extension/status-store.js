'use strict';

// Per-chat status and notification receipts survive service-worker suspension.
// A visit retires a generation, including a notification still being created;
// it never changes the tab status. Only a later trusted manual send resets it.
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
          if(!url||!Number.isInteger(row.tabId)){notices.delete(row.tabId);continue;}
          const state=stateFor(url);
          state.sequence=sequence;state.revision=sequence;
          state.status={kind:isError?'error':'success',eventAt:at(row),sequence,receipt:{epoch:'journal',order:sequence}};
          notices.set(row.tabId,{url,isError,title:`${isError?'❌ ':''}${cleanSessionTitle(row.title)}`,preview:truncateResponse(row.response)});
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
        } else if(row.kind==='notification.result'&&row.notification==='fulfilled'&&active.has(row.notificationId)&&
            /^chatgpt-prompt-bound:\d+:/.test(row.notificationId)) {
          const notice=notices.get(row.tabId),id=row.notificationId;
          const matches=notice&&url===notice.url&&row.isError===notice.isError&&
            String(row.title||'').replace(/\s+/g,' ').trim()===notice.title&&truncateResponse(row.message)===notice.preview&&
            Number(/^chatgpt-prompt-bound:(\d+):/.exec(id)[1])===row.tabId;
          if(!matches||bindings.has(id)&&bindings.get(id).url!==url) {
            bindings.delete(id);uncertain.add(id);continue;
          }
          if(uncertain.has(id))continue;
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
  return value.epoch!==statusEpoch;
}
function statusView(record) { return {url:record.url,status:record.status,revision:record.revision}; }
function withChatStatus(url,change) {
  const prior=statusWrites.get(url)||Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{
    await migrateChatStatuses();
    const key=statusKey(url);
    const record=(await chrome.storage.local.get(key))[key]||{url,revision:0,sequence:0,returnedThrough:0,status:null,notifications:[]};
    const result=await change(record);
    if(result.write)await chrome.storage.local.set({[key]:record});
    return result.value;
  });
  statusWrites.set(url,next);
  void next.finally(()=>{if(statusWrites.get(url)===next)statusWrites.delete(url);}).catch(()=>{});
  return next;
}
function readChatStatus(url) { return withChatStatus(url,record=>({value:statusView(record)})); }
function reserveChatNotification(url,tabId,kind,eventAt,receipt) {
  return withChatStatus(url,record=>{
    const sequence=++record.sequence;
    const ticket={id:`chatgpt-prompt-bound:${tabId}:${eventAt}:${sequence}:${encodeURIComponent(url)}`,
      url,tabId,sequence,receipt,state:'creating'};
    record.notifications.push(ticket);
    if(!record.manualThrough||!statusBefore(receipt,record.manualThrough)) {
      record.status={kind,eventAt,sequence,receipt};
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
async function visitChatNotifications(url,receipt,{manual=false}={}) {
  const result=await withChatStatus(url,record=>{
    const selected=record.notifications.filter(item=>statusBefore(item.receipt,receipt));
    record.returnedThrough=Math.max(record.returnedThrough,...selected.map(item=>item.sequence));
    if(manual) {
      if(!record.status||statusBefore(record.status.receipt,receipt))record.status=null;
      if(!record.manualThrough||!statusBefore(receipt,record.manualThrough))record.manualThrough=receipt;
      record.revision++;
    }
    return {write:true,value:{ids:selected.map(item=>item.id),view:statusView(record)}};
  });
  await Promise.allSettled(result.ids.map(id=>clearTrackedNotification(url,id)));
  return result.view;
}
