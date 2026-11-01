'use strict';

const titleJobs = new Map();
const pendingTitles = new Map();
const titleRequests = new Map();
const TITLE_REQUEST_FILTER = {urls:['https://chatgpt.com/backend-api/*']};
chrome.webRequest.onBeforeRequest.addListener(details=>{
  const pending=pendingTitles.get(details.tabId);
  if (!pending || !['PATCH','POST'].includes(details.method)) return;
  const id=journalChatId(pending.url);
  if (new URL(details.url).pathname!==`/backend-api/conversation/${id}`) return;
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

function renameSavedHandoff(tabId,id) {
  if (titleJobs.has(tabId)) return titleJobs.get(tabId);
  const job=(async()=>{
    const key=handoffKey(tabId);
    let record=(await chrome.storage.local.get(key))[key];
    if (!record || record.id!==id || record.stage!=='sent' || !record.naming || record.titleStatus==='confirmed' || record.titleStatus==='failed') return {ok:true,skipped:true};
    if (record.titleStatus==='saving') return {ok:false,reason:'Предыдущая попытка переименования не подтверждена; повторная запись отключена'};
    const url=ChatGPTHandoffTitle.chatUrl(record.targetUrl);
    if (!url || url===record.sourceUrl) return {ok:false,reason:'Не сохранён адрес нового чата'};
    const pending={id,url,title:record.naming.title,ack:false,failure:''};
    let deadline=0;
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function update(titleStatus,extra={}) {
      const current=(await chrome.storage.local.get(key))[key];
      if (current?.id!==id) throw new Error('Передача изменилась');
      record={...current,titleStatus,...extra};
      await appendJournal({kind:`handoff.title_${titleStatus}`,operationId:id,sourceUrl:record.sourceUrl,targetUrl:url,title:pending.title,...extra},{id:tabId});
      await chrome.storage.local.set({[key]:record});
    }
    async function probe(action,extra={}) {
      const tab=await chrome.tabs.get(tabId);
      if (tab.url!==url) throw new Error('Открыт другой чат; переименование отменено');
      const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:controlChatTitle,
        args:[{action,url,operationId:id,title:pending.title,expiresAt:deadline,...extra}]});
      return result[0]?.result||{ok:false,reason:'Страница не ответила'};
    }
    try {
      await update('waiting');
      // A conversation URL may be allocated before the server exposes actions.
      const notBefore=(record.sentAt||Date.now())+10000;
      while(Date.now()<notBefore) await wait(Math.min(1000,notBefore-Date.now()));
      deadline=Date.now()+60000;
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
      await update('saving',{previousTitle});
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
