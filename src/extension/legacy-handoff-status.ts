"use strict";

// Legacy handoff recovery is read-only until all independent native proofs
// agree. The durable status journal and checkpoint remain Host authorities.
interface LegacyReceipt { epoch: string; order: number }
interface LegacyStatus {
  kind: string;
  observed?: boolean;
  eventAt?: number;
  receipt?: LegacyReceipt;
  completionKey?: string;
  unread?: boolean;
}
interface LegacyStatusRecord {
  status: LegacyStatus | null;
  revision: number;
  loadingStoppedThrough?: number;
}
interface LegacyCheckpoint {
  state?: string;
  url?: string;
  startedAt: number;
  requestId?: string | null;
}
interface LegacyHandoff {
  id: string;
  stage: string;
  sourceUrl: string;
  targetUrl: string;
  acceptance?: {
    messageId?: string;
    entryId?: string | null;
    targetUrl?: string;
  };
  sendReceipt?: {
    operationId?: string;
    submittedText?: string;
    conversationAlias?: string;
  };
}
interface LegacyAcceptance {
  ok?: boolean;
  accepted?: boolean;
  targetUrl?: string;
  messageId?: string;
  entryId?: string | null;
}
interface LegacyCompleted {
  ok?: boolean;
  url?: string;
  userId?: string;
  promptKey?: string;
  turnStatus?: string;
  assistantCompleted?: boolean;
  assistantPhase?: string;
  assistantId?: string;
  assistantKey?: string;
  isLatest?: boolean;
  isReadOnly?: boolean;
  generating?: boolean;
  hasError?: boolean;
}
interface LegacyView {
  status?: LegacyStatus | null;
  revision: number;
  url?: string;
}
interface LegacyChrome {
  storage: { local: {
    get(key: string): Promise<Record<string, unknown>>;
  } };
  scripting: {
    executeScript<Result, Args extends readonly unknown[]>(options: {
      target: { tabId: number };
      world: "MAIN";
      func: (...args: Args) => Result;
      args: Args;
    }): Promise<readonly { result?: Result }[]>;
  };
  tabs: { get(tabId: number): Promise<{ id: number; url?: string }> };
}
declare const chrome: LegacyChrome;
declare const manualRequestReceiptsByTab: Map<number, unknown>;
declare const ChatGPTHandoffTitle: { chatUrl(value: string | undefined): string };
declare function statusReceipt(): LegacyReceipt;
declare function statusBefore(previous: LegacyReceipt | undefined, current: LegacyReceipt): boolean;
declare function statusKey(url: string): string;
declare function statusView(record: LegacyStatusRecord): LegacyView;
declare function handoffKey(tabId: number): string;
declare function withChatStatus<T>(
  url: string,
  update: (record: LegacyStatusRecord) => Promise<{ write?: boolean; value: T }>,
): Promise<T>;
declare function completionCheckpointRead(tabId: number): Promise<LegacyCheckpoint | null>;
declare function completionCheckpointFinish(tabId: number, startedAt: number, state: string, requestId?: string | null): Promise<boolean>;
declare function latestRequestReceipt(tabId: number): Promise<unknown>;
declare function journalInBackground(event: Record<string, unknown>, tab?: { id: number } | null): unknown;
declare function broadcastChatStatus(view: LegacyView): Promise<unknown>;
declare function inspectHandoffAcceptance(options: {
  sourceUrl: string; targetUrl: string; submittedText: string; conversationAlias: string;
}): LegacyAcceptance;
declare function inspectCompletedTurn(url: string): LegacyCompleted;

// Migration of an observed pre-checkpoint handoff, never a new generation or
// notification. A translated banner or an arbitrary finished answer is no proof.
const legacyHandoffStatusFences=new Map<number, number>();
function cancelLegacyHandoffStatus(tabId: number){legacyHandoffStatusFences.set(tabId,(legacyHandoffStatusFences.get(tabId)||0)+1);}
async function reconcileLegacyHandoffStatus(tabId: number,url: string): Promise<LegacyView | null>{
  const receipt=statusReceipt(),fence=legacyHandoffStatusFences.get(tabId)||0;
  const sameFence=()=>fence===(legacyHandoffStatusFences.get(tabId)||0)&&!manualRequestReceiptsByTab.has(tabId);
  const unchangedHandoff=(a: LegacyHandoff | null | undefined,b: LegacyHandoff | null | undefined)=>a?.id===b?.id&&a?.stage==='sent'&&b?.stage==='sent'&&
    a.sourceUrl===b.sourceUrl&&a.targetUrl===b.targetUrl&&
    a.acceptance?.messageId===b.acceptance?.messageId&&a.acceptance?.entryId===b.acceptance?.entryId&&
    a.acceptance?.targetUrl===b.acceptance?.targetUrl&&a.sendReceipt?.operationId===b.sendReceipt?.operationId&&
    a.sendReceipt?.submittedText===b.sendReceipt?.submittedText;
  let completedCheckpoint: LegacyCheckpoint | null=null;
  let reconciledEvent: Record<string, unknown> | null=null;
  let reconciledTab: { id: number; url?: string } | null=null;
  const view=await withChatStatus<LegacyView | null>(url,async record=>{
    if(record.status?.kind!=='loading'||record.status.observed!==true||record.loadingStoppedThrough)return {value:null};
    const checkpoint=await completionCheckpointRead(tabId);
    const rootCheckpoint=checkpoint?.state==='active'&&checkpoint.url==='https://chatgpt.com/'&&checkpoint.startedAt===record.status.eventAt;
    if(checkpoint&&!rootCheckpoint||await latestRequestReceipt(tabId)||!sameFence())return {value:null};
    const key=handoffKey(tabId);
    const saved=(await chrome.storage.local.get(key))[key];
    const handoff: LegacyHandoff | null = saved && typeof saved==='object' ? saved as LegacyHandoff : null;
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
    if(!native?.ok||native.url!==url||native.userId!==acceptance.messageId||!([new URL(url).pathname+'|fallback-turn-0:0:user',new URL(url).pathname+'/|fallback-turn-0:0:user'].includes(native.promptKey||''))||
        native.turnStatus!=='complete'||native.assistantCompleted!==true||native.assistantPhase!=='final_answer'||!native.assistantId||!native.assistantKey||
        native.isLatest!==true||native.isReadOnly!==false||native.generating!==false||native.hasError!==false)return {value:null};
    const currentSaved=(await chrome.storage.local.get(key))[key];
    const currentHandoff: LegacyHandoff | null = currentSaved && typeof currentSaved==='object' ? currentSaved as LegacyHandoff : null;
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
    if(reconciledEvent && reconciledTab)journalInBackground(reconciledEvent,reconciledTab);
    if(completedCheckpoint){
      const finished=completedCheckpoint as LegacyCheckpoint;
      try{await completionCheckpointFinish(tabId,finished.startedAt,'complete',finished.requestId);}
      catch{journalInBackground({kind:'completion.legacy_handoff_checkpoint_finish_failed',sourceUrl:url,tabId});}
    }
    await broadcastChatStatus(view);
  }
  return view;
}
