import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const url='https://chatgpt.com/c/notify',other='https://chatgpt.com/c/other';
function boot({failStatus=false,moved=false,legacy=false}={}){
  const events:Record<string,Function>={},notices:any[]=[],cleared:string[]=[];
  let focuses=0,sounds=0;
  const event=(name:string)=>({addListener:(fn:Function)=>{events[name]=fn;}});
  const noticeId='chatgpt-prompt-bound:7:10';
  const storage:Record<string,any>={'chatgpt-status:migration':{schema:1},'chatgpt-journal:meta':{sequence:0,active:{},requests:{},tabs:{}}};
  if(moved)storage['chatgpt-handoff:7']={id:'handoff-op',targetUrl:url};
  if(legacy){
    delete storage['chatgpt-status:migration'];storage['chatgpt-journal:meta'].sequence=2;
    storage['chatgpt-journal:event:000000000001']={kind:'response.complete',sourceUrl:url,tabId:7,title:'Chat',response:'Done',recordedAt:1};
    storage['chatgpt-journal:event:000000000002']={kind:'notification.result',sourceUrl:url,tabId:7,title:'Chat',message:'Done',notificationId:noticeId,notification:'fulfilled',isError:false,recordedAt:2};
  }
  const tab={id:7,url:moved?other:url,windowId:1,active:false};
  const chrome={runtime:{id:'test',getManifest:()=>({version:'test'}),getURL:(p:string)=>'chrome-extension://test/'+p,
    getContexts:async()=>[{}],sendMessage:async()=>{sounds++;},onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},
    storage:{local:{get:async(keys:string|string[]|null)=>Object.fromEntries((keys===null?Object.keys(storage):Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(storage[key])])),
      set:async(value:Record<string,unknown>)=>{if(failStatus&&Object.keys(value).some(key=>key.startsWith('chatgpt-status:')))throw Error('Synthetic status storage failure');Object.assign(storage,structuredClone(value));}}},
    tabs:{get:async()=>({...tab}),query:async()=>[],sendMessage:async()=>({ok:true}),update:async()=>{focuses++;tab.active=true;return tab;},onRemoved:event('removed')},
    windows:{get:async()=>({focused:true}),getLastFocused:async()=>({focused:false}),update:async()=>{focuses++;}},
    webRequest:{onBeforeRequest:event('before'),onCompleted:event('completed'),onErrorOccurred:event('failed')},
    notifications:{create:async(id:string,options:any)=>{notices.push({id,...options});return id;},clear:async(id:string)=>{cleared.push(id);return true;},
      getAll:async()=>legacy?{[noticeId]:{}}:{},onClicked:event('click')},
    scripting:{executeScript:async()=>[]}};
  const context=createContext({chrome,URL,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}}});
  context.importScripts=(file:string)=>runInContext(readFileSync('extension/'+file,'utf8'),context);
  runInContext(readFileSync('extension/service-worker.js','utf8'),context);
  return {events,context,storage,tab,notices,cleared,get sounds(){return sounds;},get focuses(){return focuses;},
    send(message:any){return new Promise<any>(resolve=>{events.message(message,{frameId:0,tab:{...tab}},resolve);});}};
}
{
  const h=boot({failStatus:true});
  runInContext(`manualRequestReceiptsByTab.set(7,{startedAt:111,url:${JSON.stringify(url)},receipt:statusReceipt()})`,h.context);
  const result=await h.send({type:'CHATGPT_RESPONSE_COMPLETE',url,attemptId:'111',completionStartedAt:111,completionKey:'bound-final',response:'Done',sessionTitle:'Chat'});
  assert.equal(result.ok,true);assert.equal(h.notices.length,1);assert.equal(h.sounds,1,'storage failure still emits sound and notification once');
  assert.equal(h.storage['chatgpt-status:'+url],undefined,'fallback does not invent durable status');
}
{
  const h=boot({moved:true});
  await h.send({type:'CHATGPT_OPERATION_WARNING',url,operationId:'wrong',response:'Rename failed',sessionTitle:'Target'});
  assert.equal(h.notices.length,0,'an unproven cross-chat warning is rejected');
  await h.send({type:'CHATGPT_OPERATION_WARNING',url,operationId:'handoff-op',response:'Rename failed',sessionTitle:'Target'});
  assert.equal(h.notices.length,1,'exact saved handoff warning survives navigation away');
  assert.equal(h.storage['chatgpt-status:'+url],undefined);assert.equal(h.storage['chatgpt-status:'+other],undefined,'warning cannot change either chat status');
}
{
  const h=boot({legacy:true});
  await h.events.click('chatgpt-prompt-bound:7:10');
  assert.equal(h.focuses,2,'notification click waits for legacy migration before locating its source');
  assert.ok(h.cleared.includes('chatgpt-prompt-bound:7:10'));
}
console.log('Notification recovery: storage-failure delivery, operation-bound moved warnings and click-before-migration passed.');
