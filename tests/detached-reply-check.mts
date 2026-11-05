import assert from 'node:assert/strict';import{createRequire}from'node:module';import{parseHTML}from'linkedom';import{readFileSync}from'node:fs';import{createContext,runInContext}from'node:vm';
const require=createRequire(import.meta.url),{inspectDetachedUserReply}=require('../extension/reply-probe.js');
function fixture(){
 const {document,window}=parseHTML('<html><body><section data-app-shell-active-page="true"><div data-content-search-turn-key="fallback-turn-0"><div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant" data-chatgpt-search-message-ids="reply-id reply-id"><div class="markdown"><p>Finished reply</p></div></div></div></section></body></html>');
 Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
 const answer={type:'assistant-message',messageId:'reply-id',phase:'final_answer',completed:true,content:'Finished reply'};
 const entry:any={id:'fallback-turn-0',conversationId:'local-chatgpt:test',isMostRecentTurn:true,isReadOnly:false,timestampTurns:[{role:'assistant',sentAtMs:101000}],turn:{status:'complete',firstServerMessageId:'server-id',logicalAnswerMessageId:'reply-id',items:[{type:'chatgpt-reasoning-group'},answer]}};
 const entries=[entry],controller:any={entries,conversationId:entry.conversationId,composerConversationId:entry.conversationId,isTurnActive:false,awaitingGptContinuation:false,showPendingLoadingMessage:false,isConversationFetching:false,isConversationLoading:false,hasLoadError:false,isWorkConversation:false,isSharedConversation:false};
 (document.querySelector('[data-content-search-turn-key]')as any).__reactFiber$test={memoizedProps:{entries},return:{memoizedProps:controller,return:{memoizedProps:{conversationId:'fixture-chat'},return:null}}};
 return {document,entry,answer,controller,entries};
}
const globals=globalThis as any,before={document:globals.document,location:globals.location};
try{
 let caseIndex=0;
 for(const mutate of [()=>{},(f:any)=>{f.entry.turn.status='in_progress'},(f:any)=>{f.controller.isTurnActive=true},(f:any)=>{f.entry.isReadOnly=true},(f:any)=>{f.entry.timestampTurns[0].sentAtMs=90000},(f:any)=>{f.entry.turn.items.push({type:'user-message'})},(f:any)=>{f.entries.push({...f.entry})},(f:any)=>{f.answer.completed=false},(f:any)=>{f.entry.errorMessage='error'},(f:any)=>{f.document.querySelector('.markdown').setAttribute('hidden','')},(f:any)=>{f.document.querySelector('[data-chatgpt-search-message-ids]').setAttribute('data-chatgpt-search-message-ids','different')},(f:any)=>{f.controller.conversationId='different'}]){
  const f=fixture();mutate(f);globals.document=f.document;globals.location={origin:'https://chatgpt.com',pathname:'/c/fixture-chat'};
  assert.equal(inspectDetachedUserReply('https://chatgpt.com/c/fixture-chat',100000).ok,caseIndex++===0);
 }
 const f=fixture();globals.document=f.document;f.answer.content='GOAL_BLOCKED';f.document.querySelector('p')!.textContent='GOAL_BLOCKED';assert.equal(inspectDetachedUserReply('https://chatgpt.com/c/fixture-chat',100000).goalRawExact,true);
 f.answer.content='GOAL\\_BLOCKED';assert.equal(inspectDetachedUserReply('https://chatgpt.com/c/fixture-chat',100000).goalRawExact,false,'non-DIL escaped body is not an exact marker');
 f.answer.content='GOAL_BLOCKED';const extra=f.document.createElement('p');extra.textContent='More content';f.document.querySelector('[data-chatgpt-search-unit-key]')!.append(extra);assert.equal(inspectDetachedUserReply('https://chatgpt.com/c/fixture-chat',100000).goalRawExact,false,'visible sibling content prevents terminal marker');extra.setAttribute('hidden','');assert.equal(inspectDetachedUserReply('https://chatgpt.com/c/fixture-chat',100000).goalRawExact,false,'nondecorative hidden meaning is not ignored');extra.remove();
 f.answer.content='GOAL_BLOCKED is not issued';assert.equal(inspectDetachedUserReply('https://chatgpt.com/c/fixture-chat',100000).goalRawExact,false);
}finally{Object.assign(globals,before)}
// Test actual worker reconciliation, including one-shot terminal status and
// refusing a later request. Native detached reply never confirms a handoff.
const source=readFileSync('extension/service-worker.js','utf8'),from=source.indexOf('const detachedReplyRecoveries='),until=source.indexOf('// Stable native identity',from);
async function reconcile(later=false,goalMode:string|null=null){
 const url='https://chatgpt.com/c/fixture-chat',checkpoint={state:'active',url:'https://chatgpt.com/',startedAt:100000,requestId:'req'},view={revision:1,status:{kind:'loading',eventAt:100000,receipt:{epoch:'e',order:1}}};let calls=0,emits=0,finishes=0,goalCalls=0;
 const c=createContext({Map,JSON,Date,completionCheckpointRead:async()=>checkpoint,readChatStatus:async()=>view,inspectCompletedTurn(){},inspectDetachedUserReply,
 chrome:{scripting:{executeScript:async({func}:any)=>[{result:func.name==='inspectCompletedTurn'?{ok:false,reason:'bound-messages-missing'}:{ok:true,url,assistantId:'reply',assistantKey:'assistant',response:'Done',proof:'native-detached-user-final'}}]},tabs:{get:async()=>({url,title:'Fixture'})},storage:{local:{get:async()=>goalMode?{}:({'h':{stage:'awaiting-confirmation'}})}}},
 latestRequestReceipt:async()=>({requestId:'req',startedAt:100000}),readJournal:async()=>({ok:true,events:[{kind:'request.started',tabId:7,requestId:'req',eventAt:100000,sequence:1},...(later?[{kind:'request.started',tabId:7,sequence:2}]:[])]}),ChatGPTHandoffTitle:{chatUrl:(v:string)=>v},goalController:{get:async()=>goalMode?{phase:'waiting',expectedPromptKey:'saved-prompt',manualStart:{url,tabId:7,requestId:'req',startedAt:100000,userId:'saved-native-user',promptKey:'saved-prompt'}}:null,completion:async(v:any)=>{goalCalls++;assert.equal(v.userId,'saved-native-user');assert.equal(v.promptKey,'saved-prompt');return {ok:true,record:{phase:goalMode}}}},handoffKey:()=> 'h',statusReceipt:()=>({epoch:'e',order:2}),reserveChatNotification:async()=>{calls++;return {ticket:{},view}},completionCheckpointFinish:async()=>{finishes++;checkpoint.state='complete'},appendJournal:async()=>{},broadcastChatStatus:async()=>{},completeChatNotification:async()=>{},emitBoth:async(v:any)=>{emits++;assert.equal(v.isError,goalMode==='blocked'||goalMode==='stopped'||!goalMode)},cleanSessionTitle:(v:string)=>v,truncateResponse:(v:string)=>v});
 runInContext(source.slice(from,until),c);await runInContext(`reconcileDetachedReply(7,${JSON.stringify(url)})`,c);await runInContext(`reconcileDetachedReply(7,${JSON.stringify(url)})`,c);
 assert.deepEqual([calls,emits,finishes],later?[0,0,0]:[1,goalMode==='preparing'?0:1,1]);assert.equal(goalCalls,goalMode?1:0);
}
await reconcile();await reconcile(true);await reconcile(false,'preparing');await reconcile(false,'completed');await reconcile(false,'blocked');console.log('Detached-user reply: bound native completion, stale/active/foreign rejection, marker exactness, durable one-shot status and no unknown handoff replay passed.');
