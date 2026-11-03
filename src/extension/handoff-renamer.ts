"use strict";

// Stateful MV3 handoff title reconciliation. Chrome storage is the authority;
// the MAIN-world adapter is a narrow effect port, never a second sender.
interface RenameRecord {
  id: string;
  stage: string;
  sourceUrl: string;
  targetUrl: string;
  naming: { version: 1; sourceUrl: string; baseTitle: string; part: number; title: string };
  titleStatus?: string;
  titleReason?: string;
  titlePrepareAttempts?: number;
  titlePreparationVersion?: number;
  titleRetryAfter?: number;
  titlePreparationTitle?: string;
  titleRetryable?: boolean;
  titleTargetAlias?: string;
  titleTargetBoundAt?: number;
  titlePreviousTargetUrl?: string;
  titleSaveStartedAt?: number;
  previousTitle?: string;
  sentAt?: number;
}
interface RenamePending {
  id: string;
  url: string;
  title: string;
  ack: boolean;
  failure: string;
}
interface RenameOutcome {
  ok: boolean;
  skipped?: boolean;
  waiting?: boolean;
  retryable?: boolean;
  reason?: string;
  title?: string;
}
interface RenamePageResult {
  pending?:boolean;
  ok: boolean;
  ready?: boolean;
  streaming?: boolean;
  retryable?: boolean;
  clicked?: boolean;
  reason?: string;
  title?: string;
  url?: string;
  conversationId?: string | null;
}
type RenameAction = "inspect" | "open" | "select" | "fill" | "save" | "cancel";
interface RenameWebRequest {
  tabId: number;
  requestId: string;
  method: string;
  url: string;
  requestBody?: { raw?: readonly { bytes?: ArrayBuffer }[] };
}
interface RenameWebResponse {
  tabId: number;
  requestId: string;
  statusCode: number;
  error?: string;
}
interface RenameEvent<T> {
  addListener(callback: (details: T) => void, filter: { urls: readonly string[] }, options?: readonly string[]): void;
}
interface RenameChrome {
  webRequest: {
    onBeforeRequest: RenameEvent<RenameWebRequest>;
    onCompleted: RenameEvent<RenameWebResponse>;
    onErrorOccurred: RenameEvent<RenameWebResponse>;
  };
  storage: { local: {
    get(key: string): Promise<Record<string, RenameRecord | undefined>>;
    set(value: Record<string, unknown>): Promise<unknown>;
  }};
  tabs: { get(tabId: number): Promise<{ url?: string }> };
  scripting: {
    executeScript(options: {
      target: { tabId: number };
      world: "MAIN";
      func: (options: unknown) => RenamePageResult;
      args: readonly Record<string, unknown>[];
    }): Promise<readonly { result?: RenamePageResult }[]>;
  };
}
declare const chrome: RenameChrome;
declare function journalChatId(url: string): string | null;
declare function handoffKey(tabId: number): string;
declare function journalInBackground(row: Record<string, unknown>, tab?: { id: number }): unknown;
declare function appendJournal(row: Record<string, unknown>, tab?: { id: number }): Promise<unknown>;
declare const ChatGPTHandoffTitle: {
  chatUrl(value: string | undefined): string;
  confirm(record: RenameRecord["naming"], targetUrl: string): Record<string, unknown>;
};
declare function controlChatTitle(options: unknown): RenamePageResult;
function renameErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

interface RenameJob { id: string; promise: Promise<RenameOutcome> }
const titleJobs = new Map<number, RenameJob>();
const pendingTitles = new Map<number, RenamePending>();
const titleRequests = new Map<string, RenamePending>();
const TITLE_REQUEST_FILTER = {urls:['https://chatgpt.com/backend-api/*']};
chrome.webRequest.onBeforeRequest.addListener(details=>{
  const pending=pendingTitles.get(details.tabId);
  if (!pending || !['PATCH','POST'].includes(details.method)) return;
  const id=journalChatId(pending.url);
  const pathname=new URL(details.url).pathname;
  const nativeRename=details.method==='POST'&&pathname===`/backend-api/conversation/id/${id}/rename`;
  const legacyRename=pathname===`/backend-api/conversation/${id}`||pathname===`/backend-api/conversations/${id}`;
  if (!nativeRename&&!legacyRename) return;
  const raw=details.requestBody?.raw;
  if (!raw || raw.reduce((sum,item)=>sum+(item.bytes?.byteLength||0),0)>65536) return;
  try {
    const bytes=new Uint8Array(raw.reduce((sum,item)=>sum+(item.bytes?.byteLength||0),0));
    let offset=0;
    for(const item of raw) {if(item.bytes){bytes.set(new Uint8Array(item.bytes),offset);offset+=item.bytes.byteLength;}}
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || !('title' in body) || body.title !== pending.title) return;
    titleRequests.set(details.requestId,pending);
    journalInBackground({kind:'handoff.title_request',operationId:pending.id,targetUrl:pending.url,title:pending.title,requestId:details.requestId},{id:details.tabId});
  } catch {}
},TITLE_REQUEST_FILTER,['requestBody']);
chrome.webRequest.onCompleted.addListener(details=>{
  const pending=titleRequests.get(details.requestId);
  titleRequests.delete(details.requestId);
  if (!pending) return;
  pending.ack=details.statusCode>=200&&details.statusCode<300;
  pending.failure=pending.ack?'':`HTTP ${details.statusCode}`;
  journalInBackground({kind:'handoff.title_response',operationId:pending.id,targetUrl:pending.url,statusCode:details.statusCode,requestId:details.requestId},{id:details.tabId});
},TITLE_REQUEST_FILTER);
chrome.webRequest.onErrorOccurred.addListener(details=>{
  const pending=titleRequests.get(details.requestId);
  titleRequests.delete(details.requestId);
  if (pending) pending.failure=details.error||'request-failed';
},TITLE_REQUEST_FILTER);

function renameSavedHandoff(tabId: number,id: string,{recoverTemporaryTarget=false,goalOperationId=null}: { recoverTemporaryTarget?: boolean;goalOperationId?:string|null }={}): Promise<RenameOutcome> {
  const activeTitleJob=titleJobs.get(tabId);
  if (activeTitleJob) {
    if (activeTitleJob.id===id) return activeTitleJob.promise;
    // Never alias another handoff's result. Once that job settles, inspect
    // the new handoff's own durable record before doing any title effects.
    const retry=()=>renameSavedHandoff(tabId,id,{recoverTemporaryTarget});
    return activeTitleJob.promise.then(retry,retry);
  }
  const job=(async()=>{
    const key=handoffKey(tabId);
    const original=(await chrome.storage.local.get(key))[key];
    if (!original || original.id!==id || original.stage!=='sent' || !original.naming || original.titleStatus==='confirmed') return {ok:true,skipped:true};
    let record: RenameRecord = original;
    if (record.titleStatus==='saving') return {ok:false,reason:'Предыдущая попытка переименования не подтверждена; повторная запись отключена'};
    let url=ChatGPTHandoffTitle.chatUrl(record.targetUrl);
    // A native rename modal cannot interrupt the worker-owned Goal sender.
    const goalUrl=ChatGPTHandoffTitle.chatUrl(record.targetUrl);
    const goalKey=goalUrl&&'chatgpt-goal:'+goalUrl;
    const goalRaw=goalKey?(await chrome.storage.local.get(goalKey))[goalKey]:null;
    const goal=goalRaw as unknown as {phase?:string;operation?:{id:string;status:string}|null}|null;
    const goalPreparing=goal?.phase==='preparing'&&goal.operation?.status==='reserved';
    if(goalOperationId&&(!goalPreparing||goal.operation?.id!==goalOperationId)||
        !goalOperationId&&goal?.operation&&['preparing','sending','clicked'].includes(goal.phase||''))
      return {ok:true,waiting:true,retryable:true};
    // Old versions could persist a temporary route. Never infer its server
    // destination from a title or the currently open tab alone.
    let targetAlias='';
    if(!url) {
      try {
        const target=new URL(record.targetUrl);
        const path=target.pathname.match(/^\/c\/([^/]+)\/?$/);
        const alias=path?.[1] ? decodeURIComponent(path[1]) : null;
        if(target.origin==='https://chatgpt.com'&&typeof alias==='string'&&/^local-chatgpt:[a-z0-9-]+$/.test(alias))targetAlias=alias;
      } catch {}
    }
    const noSaveIntent=!Object.hasOwn(record,'previousTitle')&&!Object.hasOwn(record,'titleSaveStartedAt');
    const recoverFailed=record.titleStatus==='failed'&&recoverTemporaryTarget&&targetAlias&&noSaveIntent&&
      record.titleReason==='Открыт другой чат; переименование отменено';
    if(record.titleStatus==='failed'&&!recoverFailed)return {ok:true,skipped:true};
    if(record.titleStatus==='waiting') {
      if(!noSaveIntent||record.titlePreparationVersion!==1)return {ok:false,reason:'Нет подтверждения безопасного продолжения переименования'};
      if((record.titlePrepareAttempts??0)>=3||Date.now()<(record.titleRetryAfter??0))return {ok:true,waiting:true,retryable:(record.titlePrepareAttempts??0)<3};
    }
    if ((!url&&!targetAlias) || url===ChatGPTHandoffTitle.chatUrl(record.sourceUrl)) return {ok:false,reason:'Не сохранён адрес нового чата'};
    if(targetAlias&&!noSaveIntent)return {ok:false,reason:'Предыдущая попытка переименования не подтверждена; повторная запись отключена'};
    const pending: RenamePending={id,url,title:record.naming.title,ack:false,failure:''};
    let deadline=0;
    const previousAttempts=record.titlePrepareAttempts||0;
    const notReady=(reason: string)=>Object.assign(new Error(reason),{titleRetryable:true});
    const wait=(ms: number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
    async function update(titleStatus: string,extra: Partial<RenameRecord>={},additionalRecords: Record<string, unknown>={}) {
      const current=(await chrome.storage.local.get(key))[key];
      if (current?.id!==id) throw new Error('Передача изменилась');
      if (current.targetUrl!==record.targetUrl) throw new Error('Адрес передачи изменился');
      record={...current,titleStatus,...extra};
      await appendJournal({kind:`handoff.title_${titleStatus}`,operationId:id,sourceUrl:record.sourceUrl,targetUrl:url||record.targetUrl,title:pending.title,...extra},{id:tabId});
      await chrome.storage.local.set({...additionalRecords,[key]:record});
    }
    async function probe(action: RenameAction,extra: Record<string, unknown>={}): Promise<RenamePageResult> {
      const tab=await chrome.tabs.get(tabId);
      if (ChatGPTHandoffTitle.chatUrl(tab.url)!==url) throw new Error('Открыт другой чат; переименование отменено');
      const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatTitle,
        args:[{action,url,operationId:id,title:pending.title,expiresAt:deadline,...extra}]});
      return result[0]?.result||{ok:false,reason:'Страница не ответила'};
    }
    try {
      await update('waiting',{titlePreparationVersion:1,titlePrepareAttempts:(record.titlePrepareAttempts||0)+1,titleRetryable:false});
      // A conversation URL may be allocated before the server exposes actions.
      const notBefore=(record.sentAt||Date.now())+10000;
      while(Date.now()<notBefore) await wait(Math.min(1000,notBefore-Date.now()));
      deadline=Date.now()+60000;
      if(targetAlias) {
        const tab=await chrome.tabs.get(tabId);
        const candidate=ChatGPTHandoffTitle.chatUrl(tab.url);
        if(!candidate||candidate===ChatGPTHandoffTitle.chatUrl(record.sourceUrl))throw new Error('Не подтверждён адрес нового чата');
        const results=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatTitle,
          args:[{action:'inspect',url:candidate,operationId:id,title:pending.title,expiresAt:deadline}]});
        const state=results[0]?.result;
        if(!state?.ok||!state.ready||state.conversationId!==targetAlias||ChatGPTHandoffTitle.chatUrl(state.url)!==candidate) {
          throw new Error('Временный адрес не подтверждён текущим чатом');
        }
        url=candidate;pending.url=url;
        // Transfer lineage follows the destination even if its later title
        // save fails. Persist both bindings together and retain the old key.
        const lineage={...record.naming,targetUrl:url,transferred:true,confirmed:false};
        await update('waiting',{targetUrl:url,titlePreviousTargetUrl:record.targetUrl,titleTargetAlias:targetAlias,titleTargetBoundAt:Date.now()},
          {[`chatgpt-handoff-title:${url}`]:lineage});
      }
      let snapshot;
      while(Date.now()<deadline) {
        snapshot=await probe('inspect');
        if(snapshot.ok&&snapshot.streaming===true) {
          // A long first response is not a failed rename preparation. Let a
          // later completion/focus event try again without spending its budget.
          await update('waiting',{titleRetryable:true,titlePrepareAttempts:previousAttempts,titleRetryAfter:0});
          return {ok:true,waiting:true,retryable:true};
        }
        if(snapshot.ok&&snapshot.ready&&typeof snapshot.title==='string') {
          if(!Object.hasOwn(record,'titlePreparationTitle'))await update('waiting',{titlePreparationTitle:snapshot.title});
          else if(snapshot.title!==record.titlePreparationTitle)throw new Error('Название изменилось во время ожидания; переименование отменено');
        }
        if(snapshot.ok&&snapshot.ready)break;
        if(snapshot.ok===false&&snapshot.reason==='chat-changed')throw new Error(snapshot.reason);
        await wait(1000);
      }
      if(!snapshot?.ready || typeof snapshot.title !== 'string')throw notReady('Новый чат ещё не готов к переименованию');
      if(snapshot.title===pending.title)throw new Error('Название уже изменено без подтверждения журнала');
      const previousTitle=snapshot.title;
      for(const action of ['open','select','fill'] as const) {
        if(Date.now()>=deadline)throw notReady('Истекло время подготовки переименования');
        let result;
        do {if(Date.now()>=deadline)throw notReady('Истекло время подготовки переименования');result=await probe(action,{previousTitle});if(!result.ok&&result.retryable)await wait(250);} while(!result.ok&&result.retryable&&Date.now()<deadline);
        if(!result.ok)throw result.retryable?notReady(result.reason||'Не удалось подготовить переименование'):new Error(result.reason);
        await wait(250);
      }
      // Durable intent before one click. A lost reply never causes a second save.
      if(Date.now()>=deadline)throw notReady('Истекло время подготовки переименования');
      await update('saving',{previousTitle,titleSaveStartedAt:Date.now()});
      pendingTitles.set(tabId,pending);
      let saved;
      do {if(Date.now()>=deadline)throw new Error('Истекло время переименования');saved=await probe('save',{previousTitle});if(!saved.ok&&saved.retryable)await wait(250);} while(!saved.ok&&saved.retryable&&Date.now()<deadline);
      if(!saved.ok||!saved.clicked)throw new Error(saved.reason||'Сохранение названия не подтверждено');
      while(Date.now()<deadline) {
        if(pending.failure)throw new Error(pending.failure);
        const state=await probe('inspect');
        if(pending.ack&&state.title===pending.title) {
          const lineage=ChatGPTHandoffTitle.confirm(record.naming,url);
          await chrome.storage.local.set({[`chatgpt-handoff-title:${url}`]:lineage});
          await update('confirmed');
          return {ok:true,title:pending.title};
        }
        await wait(1000);
      }
      throw new Error('Сервер не подтвердил новое название');
    } catch(error) {
      if(error instanceof Error && 'titleRetryable' in error && error.titleRetryable === true && record.titlePreparationVersion===1&&!Object.hasOwn(record,'previousTitle')&&!Object.hasOwn(record,'titleSaveStartedAt')) {
        const retryable=(record.titlePrepareAttempts??0)<3;
        await update('waiting',{titleReason:renameErrorMessage(error),titleRetryable:retryable,titleRetryAfter:Date.now()+10000});
        return {ok:true,waiting:true,retryable,reason:renameErrorMessage(error)};
      }
      await update('failed',{titleReason:renameErrorMessage(error)});
      return {ok:false,reason:renameErrorMessage(error)};
    } finally {
      try {
        for(let cleanup=0;cleanup<8;cleanup++) {
          const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatTitle,
            args:[{action:'cancel',operationId:id,finalCleanup:cleanup===7}]});
          if(!result[0]?.result?.pending)break;
          await wait(250);
        }
      }catch{}
      pendingTitles.delete(tabId);
      for(const [requestId,value]of titleRequests)if(value===pending)titleRequests.delete(requestId);
    }
  })();
  const trackedJob:RenameJob={id,promise:job};
  titleJobs.set(tabId,trackedJob);
  void job.finally(()=>{if(titleJobs.get(tabId)===trackedJob)titleJobs.delete(tabId);}).catch(()=>{});
  return job;
}
