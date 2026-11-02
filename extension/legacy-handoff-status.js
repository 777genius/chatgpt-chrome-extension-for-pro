'use strict';
// Migration of an observed pre-checkpoint handoff, never a new generation or
// notification. A translated banner or an arbitrary finished answer is no proof.
const legacyHandoffStatusFences=new Map();
function cancelLegacyHandoffStatus(tabId){legacyHandoffStatusFences.set(tabId,(legacyHandoffStatusFences.get(tabId)||0)+1);}
async function reconcileLegacyHandoffStatus(tabId,url){
  const receipt=statusReceipt(),fence=legacyHandoffStatusFences.get(tabId)||0;
  const sameFence=()=>fence===(legacyHandoffStatusFences.get(tabId)||0)&&!manualRequestReceiptsByTab.has(tabId);
  const unchangedHandoff=(a,b)=>a?.id===b?.id&&a?.stage==='sent'&&b?.stage==='sent'&&
    a.sourceUrl===b.sourceUrl&&a.targetUrl===b.targetUrl&&
    a.acceptance?.messageId===b.acceptance?.messageId&&a.acceptance?.entryId===b.acceptance?.entryId&&
    a.acceptance?.targetUrl===b.acceptance?.targetUrl&&a.sendReceipt?.operationId===b.sendReceipt?.operationId&&
    a.sendReceipt?.submittedText===b.sendReceipt?.submittedText;
  let completedCheckpoint=null,reconciledEvent=null,reconciledTab=null;
  const view=await withChatStatus(url,async record=>{
    if(record.status?.kind!=='loading'||record.status.observed!==true||record.loadingStoppedThrough)return {value:null};
    const checkpoint=await completionCheckpointRead(tabId);
    const rootCheckpoint=checkpoint?.state==='active'&&checkpoint.url==='https://chatgpt.com/'&&checkpoint.startedAt===record.status.eventAt;
    if(checkpoint&&!rootCheckpoint||await latestRequestReceipt(tabId)||!sameFence())return {value:null};
    const key=handoffKey(tabId),handoff=(await chrome.storage.local.get(key))[key];
    if(handoff?.stage!=='sent'||!handoff.id||handoff.sendReceipt?.operationId!==handoff.id||
        typeof handoff.sendReceipt?.submittedText!=='string'||!handoff.sendReceipt.submittedText||
        ChatGPTHandoffTitle.chatUrl(handoff.targetUrl)!==url||ChatGPTHandoffTitle.chatUrl(handoff.sourceUrl)===url||
        handoff.acceptance?.targetUrl!==url||!handoff.acceptance.messageId||handoff.acceptance.entryId!=='fallback-turn-0')return {value:null};
    const [accepted]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectHandoffAcceptance,args:[{
      sourceUrl:handoff.sourceUrl,targetUrl:handoff.targetUrl,submittedText:handoff.sendReceipt.submittedText,conversationAlias:handoff.sendReceipt.conversationAlias||''}]});
    const acceptance=accepted?.result;
    if(!acceptance?.ok||!acceptance.accepted||acceptance.targetUrl!==url||acceptance.messageId!==handoff.acceptance.messageId||acceptance.entryId!==handoff.acceptance.entryId)return {value:null};
    const [inspected]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:inspectCompletedTurn,args:[url]});
    const native=inspected?.result;
    if(!native?.ok||native.url!==url||native.userId!==acceptance.messageId||!([new URL(url).pathname+'|fallback-turn-0:0:user',new URL(url).pathname+'/|fallback-turn-0:0:user'].includes(native.promptKey))||
        native.turnStatus!=='complete'||native.assistantCompleted!==true||native.assistantPhase!=='final_answer'||!native.assistantId||!native.assistantKey||
        native.isLatest!==true||native.isReadOnly!==false||native.generating!==false||native.hasError!==false)return {value:null};
    const currentHandoff=(await chrome.storage.local.get(key))[key];
    if(!unchangedHandoff(handoff,currentHandoff)||await latestRequestReceipt(tabId)||
        JSON.stringify(await completionCheckpointRead(tabId))!==JSON.stringify(checkpoint))return {value:null};
    const persisted=(await chrome.storage.local.get(statusKey(url)))[statusKey(url)];
    if(JSON.stringify(persisted)!==JSON.stringify(record))return {value:null};
    const tab=await chrome.tabs.get(tabId);
    if(ChatGPTHandoffTitle.chatUrl(tab.url)!==url||!sameFence()||!statusBefore(record.status.receipt,receipt))return {value:null};
    record.status={kind:'success',eventAt:Date.now(),receipt,unread:false,completionKey:native.promptKey+'|'+native.assistantKey};
    record.revision++;
    completedCheckpoint=rootCheckpoint?checkpoint:null;
    reconciledEvent={kind:'completion.legacy_handoff_reconciled',sourceUrl:url,operationId:handoff.id,promptKey:native.promptKey,userId:native.userId,assistantId:native.assistantId};
    reconciledTab=tab;
    return {write:true,value:statusView(record)};
  });
  if(view){
    journalInBackground(reconciledEvent,reconciledTab);
    if(completedCheckpoint){
      try{await completionCheckpointFinish(tabId,completedCheckpoint.startedAt,'complete',completedCheckpoint.requestId);}
      catch{journalInBackground({kind:'completion.legacy_handoff_checkpoint_finish_failed',sourceUrl:url,tabId});}
    }
    await broadcastChatStatus(view);
  }
  return view;
}
