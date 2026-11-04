import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
const source=readFileSync('extension/completion-probe.js','utf8');
const url='https://chatgpt.com/c/inactive-fixture';
function fixture(extra:any={}) {
 const {document,window}=parseHTML(`<html><body><div data-app-shell-active-page="true"><main><section data-turn-key="turn"><article data-content-search-turn-key="turn"><div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="user"><div data-testid="turn:0:user" data-message-author-role="user">Request</div></div><div data-chatgpt-search-unit-key="turn:2:assistant" data-chatgpt-search-message-ids="assistant"><div data-testid="turn:2:assistant" data-message-author-role="assistant"><p>Final answer</p></div></div></article></section></main><div data-composer-body><div id="editor-wrap"><div id="prompt-textarea" contenteditable="true"></div></div><button id="voice"><svg><use href="#codex-icon-voice-regular-20"></use></svg></button></div></div></body></html>`);
 Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{configurable:true,value(){return this.hidden?[]:[{width:200,height:30}];}});
 const item={type:'assistant-message',messageId:'assistant',phase:'final_answer',completed:true,content:'Final answer',...extra.assistant};
 const entry:any={id:'turn',conversationId:'inactive-fixture',isMostRecentTurn:true,isReadOnly:false,timestampTurns:[{role:'user',sentAtMs:1000}],turn:{status:'in_progress',items:[{type:'user-message',messageId:'user',message:'Request'},{type:'chatgpt-reasoning-group',completed:false,items:[]},item]},...extra.entry};
 if(extra.rawStatus)entry.turn.status=extra.rawStatus;
 if(extra.noAssistant){entry.turn.items=entry.turn.items.slice(0,2);document.querySelector('[data-chatgpt-search-unit-key="turn:2:assistant"]')!.remove();}
 const entries=[entry];
 const component:any={conversationId:'inactive-fixture',composerConversationId:'inactive-fixture',entries,isTurnActive:false,awaitingGptContinuation:false,showPendingLoadingMessage:false,isConversationFetching:false,isConversationLoading:false,hasLoadError:false,isComposerDisabled:false,isSubmitDisabled:false,isWorkConversation:false,isSharedConversation:false,...extra.component};
 if(extra.clonedEntries)component.entries=[{...entry}];
 const ancestor={memoizedProps:component,return:null};
 (document.querySelector('[data-content-search-turn-key]') as any).__reactFiber$fixture={memoizedProps:{},return:{memoizedProps:{entries},return:ancestor}};
 const editor=document.querySelector('#prompt-textarea')!;
 const controller:any={view:{dom:editor},getChatGptPrompt:()=>({prompt:''}),pendingSubmit:null,pendingBrowserAutocompleteSubmission:null,submitReady:true,...extra.controller};
 (document.querySelector('#editor-wrap') as any).__reactFiber$controller={memoizedProps:{composerController:controller}};
 (document.querySelector('#voice') as any).__reactFiber$voice={memoizedProps:{isLoading:false,isStartButtonAllowed:true,...extra.voice}};
 if(extra.hideVoice)document.querySelector('#voice')!.setAttribute('hidden','');
 if(extra.currentTask)document.querySelector('[data-turn-key]')!.insertAdjacentHTML('beforeend','<div data-automation-card="true"><button>Task</button></div>');
 if(extra.historicalTask)document.querySelector('main')!.insertAdjacentHTML('afterbegin','<section data-turn-key="earlier"><div data-automation-card="true"><button>Task</button></div></section>');
 if(extra.userMismatch)document.querySelector('[data-chatgpt-search-unit-key="turn:0:user"]')!.setAttribute('data-chatgpt-search-message-ids','other');
 if(extra.assistantMismatch)document.querySelector('[data-chatgpt-search-unit-key="turn:2:assistant"]')!.setAttribute('data-chatgpt-search-message-ids','other');
 const ctx=createContext({document,URL,location:{origin:'https://chatgpt.com',href:url,pathname:'/c/inactive-fixture'}});
 runInContext(source,ctx);return JSON.parse(JSON.stringify(runInContext(`inspectCompletedTurn(${JSON.stringify(url)},false,null,null,${JSON.stringify(extra.binding||null)})`,ctx)));
}
const valid=fixture();assert.equal(valid.turnStatus,'complete');assert.equal(valid.nativeTurnStatus,'in_progress');assert.equal(valid.nativeConversationInactive,true);assert.equal(valid.completionProof,'native-inactive-final');
assert.equal(fixture({historicalTask:true}).turnStatus,'complete','only the current native row can block completion');
for(const extra of [{component:{isTurnActive:true}},{component:{isTurnActive:undefined}},{component:{awaitingGptContinuation:true}},{component:{showPendingLoadingMessage:true}},{component:{isConversationFetching:true}},{component:{isConversationLoading:true}},{component:{hasLoadError:true}},{component:{isComposerDisabled:true}},{component:{isSubmitDisabled:true}},{component:{isWorkConversation:true}},{component:{isSharedConversation:true}},{component:{conversationId:'other'}},{component:{composerConversationId:'other'}},{clonedEntries:true},{entry:{isReadOnly:true}},{entry:{isMostRecentTurn:false}},{controller:{pendingSubmit:{queued:true}}},{controller:{pendingBrowserAutocompleteSubmission:{queued:true}}},{controller:{pendingSubmit:undefined}},{controller:{pendingBrowserAutocompleteSubmission:undefined}},{voice:{isLoading:true}},{voice:{isStartButtonAllowed:false}},{hideVoice:true},{currentTask:true},{assistant:{completed:false}},{assistant:{phase:'analysis'}},{userMismatch:true},{assistantMismatch:true}]) {
 const result=fixture(extra);assert.notEqual(result.turnStatus,'complete',JSON.stringify(extra));
}
assert.equal(fixture({noAssistant:true,userMismatch:true}).nativeConversationInactive,false,'empty-response proof still requires exact native user binding');
const empty=fixture({noAssistant:true});assert.equal(empty.nativeConversationInactive,true);assert.equal(empty.turnStatus,'in_progress','inactive alone cannot complete an empty answer');
assert.equal(fixture({noAssistant:true,hideVoice:true}).nativeConversationInactive,true,'draft/no voice still has independent settled controller proof');
assert.equal(fixture({rawStatus:'complete',component:{isTurnActive:undefined}}).turnStatus,'complete','normal native completion stays unchanged');
console.log('Native inactive final: exact latest conversation/units + completed final + positive idle proof; active, pending, task, work, unknown and stale-binding cases refused.');

assert.equal(fixture({noAssistant:true,rawStatus:'complete'}).terminalEmptyResponse,true);
assert.equal(fixture({noAssistant:true,rawStatus:'complete',controller:{pendingSubmit:{queued:true}}}).terminalEmptyResponse,false);
const alias='local-chatgpt:alias-fixture';
const aliased={noAssistant:true,rawStatus:'complete',entry:{conversationId:alias},component:{conversationId:alias,composerConversationId:alias}};
const binding={url,alias,userId:'user',userText:'Request',userSentAtMs:1000};
assert.equal(fixture(aliased).terminalEmptyResponse,false,'an unbound local alias is not the canonical chat');
assert.equal(fixture({...aliased,binding}).terminalEmptyResponse,true);
for(const change of [{url:'https://chatgpt.com/c/other'},{alias:'local-chatgpt:other'},{userId:'other'},{userText:'other'},{userSentAtMs:1001}])
 assert.equal(fixture({...aliased,binding:{...binding,...change}}).terminalEmptyResponse,false);
