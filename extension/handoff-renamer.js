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

function renameSavedHandoff(tabId,id,{recoverTemporaryTarget=false}={}) {
  if (titleJobs.has(tabId)) return titleJobs.get(tabId);
  const job=(async()=>{
    const key=handoffKey(tabId);
    let record=(await chrome.storage.local.get(key))[key];
    if (!record || record.id!==id || record.stage!=='sent' || !record.naming || record.titleStatus==='confirmed') return {ok:true,skipped:true};
    if (record.titleStatus==='saving') return {ok:false,reason:'Предыдущая попытка переименования не подтверждена; повторная запись отключена'};
    let url=ChatGPTHandoffTitle.chatUrl(record.targetUrl);
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
    const noSaveIntent=!Object.hasOwn(record,'previousTitle')&&!Object.hasOwn(record,'titleSaveStartedAt');
    const recoverFailed=record.titleStatus==='failed'&&recoverTemporaryTarget&&targetAlias&&noSaveIntent&&
      record.titleReason==='Открыт другой чат; переименование отменено';
    if(record.titleStatus==='failed'&&!recoverFailed)return {ok:true,skipped:true};
    if ((!url&&!targetAlias) || url===ChatGPTHandoffTitle.chatUrl(record.sourceUrl)) return {ok:false,reason:'Не сохранён адрес нового чата'};
    if(targetAlias&&!noSaveIntent)return {ok:false,reason:'Предыдущая попытка переименования не подтверждена; повторная запись отключена'};
    const pending={id,url,title:record.naming.title,ack:false,failure:''};
    let deadline=0;
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
      if(!targetAlias)await update('waiting');
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
        if(snapshot.ok&&snapshot.ready)break;
        if(snapshot.ok===false&&snapshot.reason==='chat-changed')throw new Error(snapshot.reason);
        await wait(1000);
      }
      if(!snapshot?.ready)throw new Error('Новый чат ещё не готов к переименованию');
      if(snapshot.title===pending.title)throw new Error('Название уже изменено без подтверждения журнала');
      const previousTitle=snapshot.title;
      for(const action of ['open','select','fill']) {
        if(Date.now()>=deadline)throw new Error('Истекло время переименования');
        let result;
        do {if(Date.now()>=deadline)throw new Error('Истекло время переименования');result=await probe(action,{previousTitle});if(!result.ok&&result.retryable)await wait(250);} while(!result.ok&&result.retryable&&Date.now()<deadline);
        if(!result.ok)throw new Error(result.reason);
        await wait(250);
      }
      // Durable intent before one click. A lost reply never causes a second save.
      if(Date.now()>=deadline)throw new Error('Истекло время переименования');
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
      await update('failed',{titleReason:String(error.message||error)});
      return {ok:false,reason:String(error.message||error)};
    } finally {
      try {await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatTitle,args:[{action:'cancel',operationId:id}]});}catch{}
      pendingTitles.delete(tabId);
      for(const [requestId,value]of titleRequests)if(value===pending)titleRequests.delete(requestId);
    }
  })();
  titleJobs.set(tabId,job);
  void job.finally(()=>{if(titleJobs.get(tabId)===job)titleJobs.delete(tabId);}).catch(()=>{});
  return job;
}
