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

// Only a first prompt sent from a proven empty new-chat composer can adopt
// its permanent URL. A matching loading record and request fences are checked
// by the worker before this observation-only update.
function completionAllocationEvidence(record,url,native){
  if(record?.state!=='active'||record.url!=='https://chatgpt.com/'||record.baselineKey!==''||record.promptKey||!Number.isFinite(record.startedAt)||
      !/^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+$/.test(url)||!native?.ok||native.url!==url||
      native.firstTurn!==true||native.isLatest!==true||native.isReadOnly!==false||native.hasError!==false||
      !native.userId||!native.promptKey||!Number.isFinite(native.firstUserSentAtMs)||
      Math.abs(native.firstUserSentAtMs-record.startedAt)>10000)return null;
  const progress=native.turnStatus==='in_progress'&&native.generating===true;
  const final=native.turnStatus==='complete'&&native.generating===false&&native.assistantCompleted===true&&
    native.assistantPhase==='final_answer'&&native.assistantId&&native.assistantKey;
  return progress||final?{url,promptKey:native.promptKey}:null;
}

// An observed transport failure alone is not terminal: ChatGPT may keep polling.
function completionCheckpointFailure(tabId,{startedAt,requestId,failedAt}) {
  if(!Number.isFinite(failedAt)||failedAt<startedAt)return Promise.resolve(false);
  return completionCheckpointChange(tabId,current=>{
    if(!current||current.state!=='active'||current.startedAt!==startedAt||!requestId||current.requestId!==requestId)return {value:false};
    return {record:{...current,requestFailedAt:failedAt},value:true};
  });
}
function failedAttemptRollbackEvidence(record,native) {
  if(record?.state!=='active'||!record.requestId||!Number.isFinite(record.requestFailedAt)||record.requestFailedAt<record.startedAt||
      !record.baselineKey||!record.promptKey||record.baselineKey===record.promptKey||!native?.ok||native.url!==record.url||
      native.promptKey!==record.baselineKey||native.absentPromptKey!==record.promptKey||native.composerIdle!==true||
      native.isLatest!==true||native.isReadOnly!==false||native.generating!==false||native.hasError!==false||
      native.turnStatus!=='complete'||native.assistantPhase!=='final_answer'||native.assistantCompleted!==true||
      !native.assistantId||!native.assistantKey)return null;
  return {startedAt:record.startedAt,requestId:record.requestId};
}


// Temporary DOM turn positions can shift when ChatGPT reconciles its local
// history. Native user timing binds the observed request independently.
function completionPromptRebindEvidence(record,url,native) {
  if(record?.state!=='active'||record.url!==url||!Number.isFinite(record.startedAt)||!native?.ok||native.url!==url||
      native.isLatest!==true||native.isReadOnly!==false||!native.userId||
      !Number.isFinite(native.lastUserSentAtMs)||Math.abs(native.lastUserSentAtMs-record.startedAt)>10000||
      typeof record.promptKey!=='string'||typeof native.promptKey!=='string'||
      record.promptKey===native.promptKey||native.promptKey===record.baselineKey)return null;
  const path=new URL(url).pathname.replace(/\/$/,'');
  const fallbackPath=key=>{const at=key.indexOf('|fallback-turn-');return at>0?key.slice(0,at).replace(/\/$/,''):'';};
  if(fallbackPath(record.promptKey)!==path||fallbackPath(native.promptKey)!==path)return null;
  return {promptKey:native.promptKey};
}
