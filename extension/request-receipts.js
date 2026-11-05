'use strict';
// Bounded observation cache, independent of the immutable activity journal.
// Session storage survives worker suspension; local fallback supports older hosts.
const requestReceiptStorage=chrome.storage.session||chrome.storage.local;
const REQUEST_RECEIPTS_KEY='chatgpt-request-receipts';
let requestReceiptWrites=Promise.resolve();
function changeRequestReceipts(change) {
  const next=requestReceiptWrites.catch(()=>{}).then(async()=>{
    const saved=(await requestReceiptStorage.get(REQUEST_RECEIPTS_KEY))[REQUEST_RECEIPTS_KEY];
    const records=(Array.isArray(saved)?saved:[]).filter(item=>Number.isFinite(item.cachedAt)&&Date.now()-item.cachedAt<86400000);
    const result=change(records);
    if(result.write)await requestReceiptStorage.set({[REQUEST_RECEIPTS_KEY]:records.slice(-128)});
    return result.value;
  });
  requestReceiptWrites=next;
  return next;
}
function rememberRequestReceipt(tabId,request) {
  return changeRequestReceipts(records=>{
    const duplicate=records.findIndex(item=>item.tabId===tabId&&item.requestId===request.requestId&&item.startedAt===request.startedAt);
    if(duplicate>=0)return {value:records[duplicate]};
    const entry={...request,tabId,cachedAt:Date.now()};records.push(entry);
    return {write:true,value:entry};
  });
}
// Correlate the actual observed POST only after its worker journal grant was
// committed. This is observation metadata, never a new send authorization.
function bindRequestOperationReceipt(tabId,requestId,startedAt,operationId) {
  if(typeof operationId!=='string'||!operationId)return Promise.resolve(false);
  return changeRequestReceipts(records=>{
    const entry=records.find(item=>item.tabId===tabId&&item.requestId===requestId&&item.startedAt===startedAt);
    if(!entry||entry.operationId&&entry.operationId!==operationId)return {value:false};
    entry.operationId=operationId;return {write:true,value:true};
  });
}
function readRequestReceipt(tabId,{requestId,startedAt,url,consume=false}={}) {
  return changeRequestReceipts(records=>{
    const candidates=records.filter(item=>item.tabId===tabId&&(!url||!item.url||item.url===url));
    const entry=requestId?candidates.find(item=>item.requestId===requestId):
      startedAt!==undefined?candidates.find(item=>!item.requestId&&item.startedAt===startedAt):candidates.at(-1);
    if(!entry||startedAt!==undefined&&entry.startedAt!==startedAt||consume&&entry.consumed)return {value:null};
    if(consume)entry.consumed=true;
    return {write:consume,value:entry};
  });
}
function forgetRequestReceipts(tabId) {
  return changeRequestReceipts(records=>{for(let i=records.length-1;i>=0;i--)if(records[i].tabId===tabId)records.splice(i,1);return {write:true};});
}
