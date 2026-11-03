'use strict';

const titleJobs = new Map();
const pendingTitles = new Map();
const titleRequests = new Map();
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
    const body=JSON.parse(new TextDecoder().decode(bytes));
    if (body.title!==pending.title) return;
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

function renameSavedHandoff(tabId,id,{recoverTemporaryTarget=false,goalOperationId=null}={}) {
  if (titleJobs.has(tabId)) return titleJobs.get(tabId);
  const job=(async()=>{
    const key=handoffKey(tabId);
    let record=(await chrome.storage.local.get(key))[key];
    if (!record || record.id!==id || record.stage!=='sent' || !record.naming || record.titleStatus==='confirmed') return {ok:true,skipped:true};
    if (record.titleStatus==='saving') return {ok:false,reason:'Предыдущая попытка переименования не подтверждена; повторная запись отключена'};
    let url=ChatGPTHandoffTitle.chatUrl(record.targetUrl);
    // Goal continuations and native rename dialogs share the same page. The
    // delivery barrier may own preparation; background rename events may not
    // open a modal over an already preparing/sending Goal.
    const goalUrl=ChatGPTHandoffTitle.chatUrl(record.targetUrl);
    const goalKey=goalUrl&&'chatgpt-goal:'+goalUrl;
    const goal=goalKey?(await chrome.storage.local.get(goalKey))[goalKey]:null;
    const goalPreparing=goal?.phase==='preparing'&&goal.operation?.status==='reserved';
    if(goalOperationId&&(!goalPreparing||goal.operation.id!==goalOperationId)||
        !goalOperationId&&goal?.operation&&['preparing','sending','clicked'].includes(goal.phase))
      return {ok:true,waiting:true,retryable:true};
    // Old versions could persist a temporary route. Never infer its server
    // destination from a title or the currently open tab alone.
    let targetAlias='';
    if(!url) {
      try {
        const target=new URL(record.targetUrl);
        const path=target.pathname.match(/^\/c\/([^/]+)\/?$/);
        const alias=path&&decodeURIComponent(path[1]);
        if(target.origin==='https://chatgpt.com'&&/^local-chatgpt:[a-z0-9-]+$/.test(alias||''))targetAlias=alias;
      } catch {}
    }
    // This native refusal happens before save.click(). Allow a bounded fresh
    // preparation after React replaced the form or the generated title changed.
    if(record.titleStatus==='failed'&&record.titleReason==='title-form-changed'&&
        (record.titleRefusalRetries||0)<2) {
      const next={...record,titleStatus:'waiting',titlePreparationVersion:1,
        titlePrepareAttempts:0,titleRetryAfter:0,titleRefusalRetries:(record.titleRefusalRetries||0)+1};
      delete next.previousTitle;
      delete next.titleSaveStartedAt;
      delete next.titlePreparationTitle;
      await appendJournal({kind:'handoff.title_no_click_recovered',operationId:id,sourceUrl:record.sourceUrl,
        targetUrl:record.targetUrl}, {id:tabId});
      await chrome.storage.local.set({[key]:next});
      record=next;
    }
    const noSaveIntent=!Object.hasOwn(record,'previousTitle')&&!Object.hasOwn(record,'titleSaveStartedAt');
    const recoverFailed=record.titleStatus==='failed'&&recoverTemporaryTarget&&targetAlias&&noSaveIntent&&
      record.titleReason==='Открыт другой чат; переименование отменено';
    if(record.titleStatus==='failed'&&!recoverFailed)return {ok:true,skipped:true};
    if(record.titleStatus==='waiting') {
      if(!noSaveIntent||record.titlePreparationVersion!==1)return {ok:false,reason:'Нет подтверждения безопасного продолжения переименования'};
      if(record.titlePrepareAttempts>=3||Date.now()<record.titleRetryAfter)return {ok:true,waiting:true,retryable:record.titlePrepareAttempts<3};
    }
    if ((!url&&!targetAlias) || url===ChatGPTHandoffTitle.chatUrl(record.sourceUrl)) return {ok:false,reason:'Не сохранён адрес нового чата'};
    if(targetAlias&&!noSaveIntent)return {ok:false,reason:'Предыдущая попытка переименования не подтверждена; повторная запись отключена'};
    const pending={id,url,title:record.naming.title,ack:false,failure:''};
    let deadline=0;
    const previousAttempts=record.titlePrepareAttempts||0;
    const notReady=reason=>Object.assign(new Error(reason),{titleRetryable:true});
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function update(titleStatus,extra={},additionalRecords={}) {
      const current=(await chrome.storage.local.get(key))[key];
      if (current?.id!==id) throw new Error('Передача изменилась');
      if (current.targetUrl!==record.targetUrl) throw new Error('Адрес передачи изменился');
      record={...current,titleStatus,...extra};
      await appendJournal({kind:`handoff.title_${titleStatus}`,operationId:id,sourceUrl:record.sourceUrl,targetUrl:url||record.targetUrl,title:pending.title,...extra},{id:tabId});
      await chrome.storage.local.set({...additionalRecords,[key]:record});
    }
    async function probe(action,extra={}) {
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
      if(!snapshot?.ready)throw notReady('Новый чат ещё не готов к переименованию');
      if(snapshot.title===pending.title)throw new Error('Название уже изменено без подтверждения журнала');
      const previousTitle=snapshot.title;
      for(const action of ['open','select','fill']) {
        if(Date.now()>=deadline)throw notReady('Истекло время подготовки переименования');
        let result;
        do {if(Date.now()>=deadline)throw notReady('Истекло время подготовки переименования');result=await probe(action,{previousTitle});if(!result.ok&&result.retryable)await wait(250);} while(!result.ok&&result.retryable&&Date.now()<deadline);
        if(!result.ok)throw result.retryable?notReady(result.reason):new Error(result.reason);
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
      if(error.titleRetryable&&record.titlePreparationVersion===1&&!Object.hasOwn(record,'previousTitle')&&!Object.hasOwn(record,'titleSaveStartedAt')) {
        const retryable=record.titlePrepareAttempts<3;
        await update('waiting',{titleReason:String(error.message||error),titleRetryable:retryable,titleRetryAfter:Date.now()+10000});
        return {ok:true,waiting:true,retryable,reason:String(error.message||error)};
      }
      await update('failed',{titleReason:String(error.message||error)});
      return {ok:false,reason:String(error.message||error)};
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
  titleJobs.set(tabId,job);
  void job.finally(()=>{if(titleJobs.get(tabId)===job)titleJobs.delete(tabId);}).catch(()=>{});
  return job;
}
