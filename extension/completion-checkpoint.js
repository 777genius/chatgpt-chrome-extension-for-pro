'use strict';
// Durable observation metadata only. No editor, prompt text or send operation.
function completionCheckpointUrl(value){
  try{const u=new URL(value);return u.origin==='https://chatgpt.com'&&(u.pathname==='/'||/^\/c\/[a-z0-9-]+\/?$/.test(u.pathname))?u.origin+(u.pathname==='/'?'/':u.pathname.replace(/\/$/,'')):'';}catch{return '';}
}
const completionCheckpointWrites=new Map();
function completionCheckpointKey(tabId){return `chatgpt-completion-checkpoint:${tabId}`;}
function completionCheckpointChange(tabId,change){
  const prior=completionCheckpointWrites.get(tabId)||Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{
    const key=completionCheckpointKey(tabId),record=(await chrome.storage.local.get(key))[key]||null;
    const result=change(record);
    if(result.record)await chrome.storage.local.set({[key]:result.record});
    return result.value;
  });
  completionCheckpointWrites.set(tabId,next);
  void next.finally(()=>{if(completionCheckpointWrites.get(tabId)===next)completionCheckpointWrites.delete(tabId);}).catch(()=>{});
  return next;
}
function completionCheckpointRead(tabId){return completionCheckpointChange(tabId,record=>({value:record}));}
function completionCheckpointIntent(tabId,intent){
  if(typeof intent.url!=='string'||typeof intent.baselineKey!=='string'||!Number.isFinite(intent.at))return Promise.resolve(false);
  return completionCheckpointChange(tabId,current=>({record:{...current,schema:1,pendingIntent:{url:intent.url,baselineKey:intent.baselineKey,at:intent.at}},value:true}));
}
function completionCheckpointStart(tabId,request){
  return completionCheckpointChange(tabId,current=>{
    if(current?.startedAt>request.startedAt||current?.startedAt===request.startedAt&&current.requestId===request.requestId)return {value:current};
    const intent=current?.pendingIntent;
    const matches=intent&&intent.url===request.url&&request.startedAt>=intent.at&&request.startedAt-intent.at<=10000;
    const record={schema:1,state:'active',url:request.url,startedAt:request.startedAt,attemptId:String(request.startedAt),requestId:request.requestId||null,
      baselineKey:matches?intent.baselineKey:null,promptKey:'',httpCompleted:false};
    return {record,value:record};
  });
}
function completionCheckpointUpdate(tabId,update){
  return completionCheckpointChange(tabId,current=>{
    if(!current||current.state!=='active'||current.startedAt!==update.startedAt||current.requestId&&current.requestId!==update.requestId)return {value:false};
    const allocating=current.url==='https://chatgpt.com/'&&/^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+$/.test(update.url);
    if(current.url!==update.url&&!allocating)return {value:false};
    if(update.baselineKey!==undefined&&typeof update.baselineKey!=='string')return {value:false};
    if(current.baselineKey!==null&&update.baselineKey!==undefined&&current.baselineKey!==update.baselineKey)return {value:false};
    if(current.promptKey&&update.promptKey&&current.promptKey!==update.promptKey)return {value:false};
    const baselineKey=current.baselineKey??update.baselineKey??null,promptKey=update.promptKey||current.promptKey;
    if(promptKey&&(!baselineKey&&baselineKey!==''||promptKey===baselineKey))return {value:false};
    const record={...current,url:update.url,baselineKey,promptKey,httpCompleted:current.httpCompleted||update.httpCompleted===true};
    return {record,value:true};
  });
}
function completionCheckpointFinish(tabId,startedAt,state,requestId=null){
  return completionCheckpointChange(tabId,current=>{
    if(!current)return {value:true}; // legacy requests predate checkpoints
    if(current.state!=='active'||current.startedAt!==startedAt||current.requestId&&current.requestId!==requestId)return {value:false};
    const {pendingIntent,...metadata}=current;
    return {record:{...metadata,state},value:true};
  });
}
