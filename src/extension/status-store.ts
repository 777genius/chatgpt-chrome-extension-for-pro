"use strict";

// Per-chat status and notification receipts survive worker suspension. Typed
// in-memory records mirror the existing durable schema; no storage-key changes.
interface StatusReceipt { epoch: string; order: number }
interface StatusValue {
  kind: "loading" | "error" | "success" | "deferred";
  eventAt: number;
  receipt: StatusReceipt;
  unread?: boolean;
  sequence?: number;
  observed?: boolean;
  completionKey?: string;
}
interface DeferredValue {
  cardKey: string;
  anchorKey: string;
  taskId: string | null;
  phase: string;
  eventAt: number;
  receipt: StatusReceipt;
  observedThrough?: StatusReceipt;
}
interface NotificationValue {
  id: string;
  url: string;
  tabId: number;
  sequence: number;
  receipt: StatusReceipt;
  state: "creating" | "created";
  closed?: boolean;
}
interface StatusRecord {
  url: string;
  revision: number;
  sequence: number;
  returnedThrough: number;
  status: StatusValue | null;
  notifications: NotificationValue[];
  deferred?: DeferredValue;
  consumedDeferredCards?: string[];
  manualThrough?: StatusReceipt;
  loadingStoppedThrough?: StatusReceipt;
  viewedThrough?: StatusReceipt;
}
interface StatusView {
  url: string;
  revision: number;
  status: StatusValue | null;
  seenChanged?: boolean;
}
interface JournalRow {
  kind?: string;
  tabId?: number;
  sourceUrl?: string;
  observedTabUrl?: string;
  changes?: { url?: string };
  eventAt?: number;
  recordedAt?: number;
  title?: string;
  response?: string;
  message?: string;
  automatic?: boolean;
  warning?: boolean;
  notification?: string;
  notificationId?: string;
  isError?: boolean;
}
interface StatusMetadata { sequence?: number }
interface DeferredEvent {
  cardKey?: string | null;
  anchorKey?: string | null;
  taskId?: string | null;
  phase: string;
  reason?: string;
  startedAt?: number;
  generating?: boolean;
}
interface PendingNotice { url: string; isError: boolean; title: string; preview: string }
interface StatusChrome {
  storage: { local: {
    get<T = unknown>(keys: string | readonly string[]): Promise<Record<string, T | undefined>>;
    set(value: Record<string, unknown>): Promise<unknown>;
  }};
  notifications: {
    getAll?(): Promise<Record<string, unknown>>;
    clear(id: string): Promise<unknown>;
  };
}
declare const chrome: StatusChrome;
declare const JOURNAL_META: string;
declare const JOURNAL_PREFIX: string;
declare const ChatGPTHandoffTitle: { chatUrl(value: string | undefined): string };
declare function cleanSessionTitle(value: string | undefined): string;
declare function truncateResponse(value: string | undefined): string;
type StatusChangeResult<T> = { write?: boolean; value: T };

// Per-chat status and notification receipts survive service-worker suspension.
// A visit retires a generation, including a notification still being created;
// it preserves the terminal color while acknowledging its unread badge.
// Request starts enter loading; terminal
// results and trusted manual sends are ordered by their captured receipts.
const statusEpoch=`${Date.now()}:${Math.random()}`;
let statusReceiptSequence=0;
const statusWrites=new Map<string, Promise<unknown>>();
const STATUS_MIGRATION_KEY='chatgpt-status:migration';
let statusMigrationPromise: Promise<void> | null=null;
function statusReceipt() { return {epoch:statusEpoch,order:++statusReceiptSequence}; }
function statusKey(url: string) { return `chatgpt-status:${url}`; }
function migrateChatStatuses() {
  if(statusMigrationPromise)return statusMigrationPromise;
  const migration=(async()=>{
    if((await chrome.storage.local.get<{schema?:number}>(STATUS_MIGRATION_KEY))[STATUS_MIGRATION_KEY]?.schema===1)return;
    const meta=(await chrome.storage.local.get<StatusMetadata>(JOURNAL_META))[JOURNAL_META];
    const through=typeof meta?.sequence==='number'&&Number.isSafeInteger(meta.sequence)&&meta.sequence>=0?meta.sequence:0;
    const active=new Set(Object.keys(await chrome.notifications.getAll?.()||{}));
    const states=new Map<string, StatusRecord>(),notices=new Map<number, PendingNotice[]>(),manuals=new Map<number,{url:string;at:number}>(),bindings=new Map<string,NotificationValue>(),uncertain=new Set<string>();
    const firstChatByTab=new Map<number,string>(),ambiguousTabs=new Set<number>();
    const at=(row: JournalRow):number=>Number.isFinite(row.eventAt)?row.eventAt??0:Number.isFinite(row.recordedAt)?row.recordedAt??0:0;
    const stateFor=(url: string):StatusRecord=>{
      let state=states.get(url);
      if(!state){state={url,revision:0,sequence:0,returnedThrough:0,status:null,notifications:[]};states.set(url,state);}
      return state;
    };
    for(let first=1;first<=through;first+=50) {
      const keys=Array.from({length:Math.min(50,through-first+1)},(_,index)=>
        `${JOURNAL_PREFIX}${String(first+index).padStart(12,'0')}`);
      const batch=await chrome.storage.local.get<JournalRow>(keys);
      for(let index=0;index<keys.length;index++) {
        const row=batch[keys[index]!];
        if(!row)continue;
        const sequence=first+index,url=ChatGPTHandoffTitle.chatUrl(row.sourceUrl);
        if(typeof row.tabId==='number'&&Number.isInteger(row.tabId))for(const candidate of [url,ChatGPTHandoffTitle.chatUrl(row.observedTabUrl),ChatGPTHandoffTitle.chatUrl(row.changes?.url)]) {
          if(!candidate)continue;
          const firstChat=firstChatByTab.get(row.tabId);
          if(firstChat&&firstChat!==candidate)ambiguousTabs.add(row.tabId);
          else if(!firstChat)firstChatByTab.set(row.tabId,candidate);
        }
        if(['notification.requested','response.complete'].includes(row.kind||'')) {
          const isError=row.kind==='notification.requested';
          if(!url||typeof row.tabId!=='number'||!Number.isInteger(row.tabId))continue;
          const state=stateFor(url);
          state.sequence=sequence;state.revision=sequence;
          // The old journal proves a result, but cannot prove whether it was
          // viewed. Do not invent unread history while importing it.
          state.status={kind:isError?'error':'success',eventAt:at(row),sequence,receipt:{epoch:'journal',order:sequence},unread:false};
          const pending=notices.get(row.tabId)||[];
          pending.push({url,isError,title:`${isError?'❌ ':''}${cleanSessionTitle(row.title)}`,preview:truncateResponse(row.response)});
          notices.set(row.tabId,pending);
        } else if(row.kind==='retry.manual_reset'&&url&&typeof row.tabId==='number'&&Number.isInteger(row.tabId)) {
          manuals.set(row.tabId,{url,at:at(row)});
        } else if(row.kind==='request.started'&&row.automatic===false&&url&&typeof row.tabId==='number') {
          const manual=typeof row.tabId==='number'?manuals.get(row.tabId):undefined;
          if(manual?.url===url&&at(row)>=manual.at&&at(row)-manual.at<=10000) {
            manuals.delete(row.tabId);
            const state=states.get(url);
            if(state) {
              state.status=null;state.sequence=sequence;state.revision=sequence;
              state.manualThrough={epoch:'journal',order:sequence};
            }
          }
        } else if(row.kind==='notification.result'&&row.warning!==true&&row.notification==='fulfilled'&&typeof row.tabId==='number'&&typeof row.notificationId==='string'&&active.has(row.notificationId)&&
            /^chatgpt-prompt-bound:\d+:/.test(row.notificationId)) {
          const pending=typeof row.tabId==='number'?(notices.get(row.tabId)||[]):[],id=row.notificationId!;
          const matches=pending.filter(notice=>url===notice.url&&row.isError===notice.isError&&
            String(row.title||'').replace(/\s+/g,' ').trim()===notice.title&&truncateResponse(row.message)===notice.preview&&
            Number(/^chatgpt-prompt-bound:(\d+):/.exec(id)?.[1])===row.tabId);
          if(matches.length!==1||bindings.has(id)&&bindings.get(id)?.url!==url) {
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
    const records=Array.from(states.values()),writes:Record<string,StatusRecord>={};
    // Do not replace a status already created by an earlier extension version.
    // All live status operations await this one migration promise.
    for(let first=0;first<records.length;first+=50) {
      const group=records.slice(first,first+50),keys=group.map(record=>statusKey(record.url));
      const existing=await chrome.storage.local.get<StatusRecord>(keys);
      for(const record of group)if(!Object.hasOwn(existing,statusKey(record.url))||existing[statusKey(record.url)]==null)writes[statusKey(record.url)]=record;
    }
    await chrome.storage.local.set({...writes,[STATUS_MIGRATION_KEY]:{schema:1,throughSequence:through,migratedAt:Date.now()}});
  })();
  statusMigrationPromise=migration;
  void migration.catch(()=>{if(statusMigrationPromise===migration)statusMigrationPromise=null;});
  return migration;
}
function statusBefore(value: StatusReceipt | null | undefined,fence: StatusReceipt): boolean {
  if(!value)return true;
  if(value.epoch===fence.epoch)return value.order<=fence.order;
  // Only this worker's receipts are known to follow retained prior epochs.
  // Two historical workers have no trustworthy ordering after another restart.
  return fence.epoch===statusEpoch&&value.epoch!==statusEpoch;
}
function statusView(record: StatusRecord): StatusView {
  const pending=record.deferred,status=record.status;
  const newerActive=status&&['loading','error'].includes(status.kind)&&pending&&statusBefore(pending.receipt,status.receipt);
  const displayed:StatusValue|null=pending&&!newerActive?{kind:'deferred',eventAt:pending.eventAt,receipt:pending.receipt,unread:false}:status;
  return {url:record.url,status:displayed,revision:record.revision};
}
function consumeDeferredCard(record: StatusRecord,key: string | null | undefined): void {
  if(!key)return;
  const keys=(record.consumedDeferredCards||[]).filter(item=>item!==key);
  record.consumedDeferredCards=[...keys,key].slice(-32);
}
function retireDeferredForRequest(record: StatusRecord,receipt: StatusReceipt): boolean {
  if(!record.deferred||!statusBefore(record.deferred.receipt,receipt))return false;
  consumeDeferredCard(record,record.deferred.cardKey);delete record.deferred;record.revision++;return true;
}
function updateDeferredChat(url: string,event: DeferredEvent,receipt: StatusReceipt): Promise<StatusView> {
  return withChatStatus(url,record=>{
    const key=typeof event.cardKey==='string'&&event.cardKey.length<=1000?event.cardKey:'';
    if(!key||!['pending','unknown','resumed','none'].includes(event.phase))return {value:statusView(record)};
    const pendingReceipt=record.deferred?.observedThrough||record.deferred?.receipt;
    if(pendingReceipt&&!statusBefore(pendingReceipt,receipt))return {value:statusView(record)};
    const legacyCard=record.deferred&&event.phase==='none'&&['historical-card','task-disabled'].includes(event.reason||'')&&
      record.deferred?.anchorKey===event.anchorKey&&record.deferred.cardKey.startsWith(`${event.anchorKey}|`);
    const matching=record.deferred?.cardKey===key||legacyCard;
    if(['pending','unknown'].includes(event.phase)) {
      if((record.consumedDeferredCards||[]).includes(key)||event.phase==='unknown'&&!matching)return {value:statusView(record)};
      if(matching&&record.deferred&&record.deferred.phase===event.phase){record.deferred.observedThrough=receipt;return {write:true,value:statusView(record)};}
      record.deferred=matching&&record.deferred?{...record.deferred,phase:event.phase,observedThrough:receipt}:{cardKey:key,anchorKey:String(event.anchorKey||'').slice(0,500),taskId:typeof event.taskId==='string'?event.taskId.slice(0,200):null,phase:event.phase,eventAt:Date.now(),receipt,observedThrough:receipt};
      record.revision++;return {write:true,value:statusView(record)};
    }
    if(event.phase==='resumed')consumeDeferredCard(record,key);
    if(!matching||!record.deferred)return {write:event.phase==='resumed',value:statusView(record)};
    const newerActive=record.status&&record.deferred&&['error','loading'].includes(record.status.kind)&&statusBefore(record.deferred.receipt,record.status.receipt);
    consumeDeferredCard(record,record.deferred.cardKey);consumeDeferredCard(record,key);delete record.deferred;
    if(!newerActive&&event.phase==='resumed'&&event.generating===true&&typeof event.startedAt==='number'&&Number.isFinite(event.startedAt)&&event.startedAt>0&&(!record.status||statusBefore(record.status.receipt,receipt))) {
      record.status={kind:'loading',eventAt:event.startedAt,receipt,observed:true};
    }
    record.revision++;return {write:true,value:statusView(record)};
  });
}
function withChatStatus<T>(url: string,change: (record: StatusRecord)=>StatusChangeResult<T> | Promise<StatusChangeResult<T>>): Promise<T> {
  const prior=statusWrites.get(url)||Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{
    await migrateChatStatuses();
    const key=statusKey(url);
    const record:StatusRecord=(await chrome.storage.local.get<StatusRecord>(key))[key]||{url,revision:0,sequence:0,returnedThrough:0,status:null,notifications:[]};
    const legacyTerminal=Boolean(record.status&&['error','success'].includes(record.status.kind)&&typeof record.status.unread!=='boolean');
    if(legacyTerminal&&record.status)record.status={...record.status,unread:false};
    const result=await change(record);
    if(result.write||legacyTerminal)await chrome.storage.local.set({[key]:record});
    return result.value;
  });
  statusWrites.set(url,next);
  void next.finally(()=>{if(statusWrites.get(url)===next)statusWrites.delete(url);}).catch(()=>{});
  return next;
}
function readChatStatus(url: string): Promise<StatusView> { return withChatStatus(url,record=>({value:statusView(record)})); }
// A request can start at '/' before ChatGPT allocates its permanent chat URL.
// Native generation controls may seed only a virgin status, never a known result.
function observeChatLoading(url: string,eventAt: number,receipt: StatusReceipt): Promise<StatusView> {
  return withChatStatus(url,record=>{
    if(record.revision!==0||record.status||record.manualThrough||record.loadingStoppedThrough)return {value:statusView(record)};
    record.status={kind:'loading',eventAt,receipt,observed:true};record.revision++;
    return {write:true,value:statusView(record)};
  });
}
function markChatLoading(url: string,eventAt: number,receipt: StatusReceipt): Promise<StatusView> {
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
function stopChatLoading(url: string,startedAt: number,receipt: StatusReceipt,startReceipt: StatusReceipt | null=null): Promise<StatusView> {
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
    if(matching&&record.status&&statusBefore(record.status.receipt,receipt)){record.status=null;record.revision++;}
    return {write:true,value:statusView(record)};
  });
}
function reserveChatNotification(url: string,tabId: number,kind: 'error'|'success',eventAt: number,receipt: StatusReceipt) {
  return withChatStatus(url,record=>{
    const sequence=++record.sequence;
    const ticket:NotificationValue={id:`chatgpt-prompt-bound:${tabId}:${eventAt}:${sequence}:${encodeURIComponent(url)}`,
      url,tabId,sequence,receipt,state:'creating'};
    record.notifications.push(ticket);
    if(['error','success'].includes(kind)&&(!record.status||statusBefore(record.status.receipt,receipt))&&(!record.manualThrough||!statusBefore(receipt,record.manualThrough))) {
      record.status={kind,eventAt,sequence,receipt,unread:!record.viewedThrough||!statusBefore(receipt,record.viewedThrough)};
      record.revision++;
    }
    return {write:true,value:{ticket,view:statusView(record)}};
  });
}
async function clearTrackedNotification(url: string,id: string): Promise<void> {
  try {await chrome.notifications.clear(id);} catch {return;}
  await withChatStatus(url,record=>{
    // Keep unresolved creates until their callback can apply the visit fence.
    record.notifications=record.notifications.filter(item=>item.id!==id||item.state==='creating');
    return {write:true,value:undefined};
  });
}
async function completeChatNotification(ticket: NotificationValue,created: boolean): Promise<void> {
  const clear=await withChatStatus(ticket.url,record=>{
    const entry=record.notifications.find(item=>item.id===ticket.id);
    if(!created)record.notifications=record.notifications.filter(item=>item.id!==ticket.id);
    else if(entry)entry.state='created';
    return {write:true,value:created&&(ticket.sequence<=record.returnedThrough||entry?.closed===true)};
  });
  if(clear)await clearTrackedNotification(ticket.url,ticket.id);
}
function closeChatNotification(url: string,id: string) {
  return withChatStatus(url,record=>{
    const entry=record.notifications.find(item=>item.id===id);
    if(!entry)return {value:undefined};
    if(entry.state==='creating')entry.closed=true;
    else record.notifications=record.notifications.filter(item=>item.id!==id);
    return {write:true,value:undefined};
  });
}
function markStatusViewed(record: StatusRecord,receipt: StatusReceipt): boolean {
  if(!record.viewedThrough||!statusBefore(receipt,record.viewedThrough))record.viewedThrough=receipt;
  if(record.status&&['error','success'].includes(record.status.kind)&&record.status.unread===true&&statusBefore(record.status.receipt,receipt)) {
    record.status={...record.status,unread:false};record.revision++;
    return true;
  }
  return false;
}
function markChatViewed(url: string,receipt: StatusReceipt) {
  return withChatStatus(url,record=>{
    const seenChanged=markStatusViewed(record,receipt);
    return {write:true,value:{...statusView(record),seenChanged}};
  });
}
async function visitChatNotifications(url: string,receipt: StatusReceipt,{manual=false,startedAt=null}: {manual?:boolean;startedAt?:number|null}={}) {
  const result=await withChatStatus(url,record=>{
    const selected=record.notifications.filter(item=>statusBefore(item.receipt,receipt));
    record.returnedThrough=Math.max(record.returnedThrough,...selected.map(item=>item.sequence));
    const seenChanged=markStatusViewed(record,receipt);
    if(manual) {
      retireDeferredForRequest(record,receipt);
      if((!record.status||statusBefore(record.status.receipt,receipt))&&(!record.loadingStoppedThrough||!statusBefore(receipt,record.loadingStoppedThrough)))record.status=typeof startedAt==='number'&&Number.isFinite(startedAt)?{kind:'loading',eventAt:startedAt,receipt}:null;
      if(!record.manualThrough||!statusBefore(receipt,record.manualThrough))record.manualThrough=receipt;
      record.revision++;
    }
    return {write:true,value:{ids:selected.map(item=>item.id),view:statusView(record),seenChanged}};
  });
  await Promise.allSettled(result.ids.map(id=>clearTrackedNotification(url,id)));
  return {...result.view,seenChanged:result.seenChanged};
}
