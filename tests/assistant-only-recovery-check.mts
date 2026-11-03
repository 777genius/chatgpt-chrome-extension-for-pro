import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
function setup(){
 const {document}=parseHTML('<html><body><main data-content-search-turn-key="fallback-turn-0"><div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">Partial</div><div role="status"><span class="text-chatgpt-recovery">接続が中断されました</span></div></main><form data-composer-body><div data-composer-markdown contenteditable="true"></div><button type="button"><svg><use href="/icons.svg#codex-icon-voice-regular-20"></use></svg></button></form></body></html>');
 const status=document.querySelector('[role=status]')! as any,voice=document.querySelector('button')! as any,editor=document.querySelector('[contenteditable]')! as any;
 for(const node of [status,voice,editor])node.getClientRects=()=>[{width:240,height:32}];
 const entry={id:'fallback-turn-0',isMostRecentTurn:true,isReadOnly:false,turn:{status:'in_progress',items:[{type:'assistant-message',messageId:'assistant-uuid',completed:false}]}};
 status.__reactFiber$fixture={memoizedProps:{entry,children:{props:{id:'errors.network.reconnecting_fallback'}}},return:null};
 const voiceProps={isLoading:false,isStartButtonAllowed:true};voice.__reactFiber$fixture={memoizedProps:voiceProps,return:null};
 const controller={view:{dom:editor},getChatGptPrompt(){return {prompt:''};},pendingSubmit:null as unknown,pendingBrowserAutocompleteSubmission:null,submitReady:false};
 editor.__reactFiber$fixture={memoizedProps:{composerController:controller},return:null};
 const context=createContext({URL,document,location:{href:'https://chatgpt.com/c/idle',origin:'https://chatgpt.com',pathname:'/c/idle'}});
 runInContext(readFileSync('extension/page-probe.js','utf8'),context);
 const binding=runInContext('inspectChatError(0,false).recoveryBinding',context);
 context.expectedBinding=binding;
 const inspect=(action='inspect-recovery')=>runInContext(`inspectChatError(0,false,${JSON.stringify(action)},'https://chatgpt.com/c/idle','/c/idle',expectedBinding)`,context);
 return {document,context,entry,voiceProps,controller,binding,inspect};
}
const valid=setup();assert.equal(valid.binding.kind,'assistant-only');assert.equal(valid.binding.assistantId,'assistant-uuid');
assert.equal(valid.inspect().idle,true,'a no-user background response may recover only with exact native identity and explicit native idle voice proof');
assert.equal(valid.inspect('stop-recovery').idle,true,'already-idle recovery has no native Stop click to perform');
const regular=setup();
regular.entry.turn.items.unshift({type:'user-message',messageId:'user-id',completed:false});
const user=regular.document.createElement('div');user.setAttribute('data-chatgpt-search-unit-key','fallback-turn-0:0:user');
(user as any).getClientRects=()=>[{width:240,height:32}];regular.document.querySelector('main')!.prepend(user);
regular.context.expectedBinding=runInContext('inspectChatError(0,false).recoveryBinding',regular.context);
assert.equal(runInContext("inspectChatError(0,false,'inspect-recovery','https://chatgpt.com/c/idle','/c/idle|fallback-turn-0:0:user',expectedBinding).idle",regular.context),true,'regular user-bound recoveries require the same explicit idle proof');
for(const mutate of [
 (f:ReturnType<typeof setup>)=>{f.entry.turn.items[0].messageId='new-assistant';},
 (f:ReturnType<typeof setup>)=>{const newer=f.document.createElement('div') as any;newer.setAttribute('data-chatgpt-search-unit-key','fallback-turn-1:0:user');newer.getClientRects=()=>[{width:240,height:32}];f.document.querySelector('main')!.append(newer);},
 (f:ReturnType<typeof setup>)=>{f.controller.pendingSubmit={};},
 (f:ReturnType<typeof setup>)=>{f.voiceProps.isLoading=true;},
 (f:ReturnType<typeof setup>)=>{f.voiceProps.isStartButtonAllowed=false;},
 (f:ReturnType<typeof setup>)=>{f.entry.isReadOnly=true;}
]){const f=setup();mutate(f);assert.equal(f.inspect().ok,false);}
const active=setup();const stop=active.document.createElement('button') as any;stop.setAttribute('data-testid','stop-button');stop.getClientRects=()=>[{width:240,height:32}];active.document.querySelector('form')!.append(stop);let clicks=0;stop.addEventListener('click',()=>clicks++);
assert.equal(active.inspect().idle,false);assert.equal(clicks,0,'read-only inspection never clicks an active Stop');
assert.equal(active.inspect('stop-recovery').stopped,true);assert.equal(clicks,1,'active native generation still requires its actual Stop');
console.log('Assistant-only recovery: exact native identity, idle voice/controller proof, changed assistant/user and active/pending generation fences passed.');

// Retained hidden users must not shadow the visible exact recovery request.
const hidden=regular.document.createElement('div') as any;hidden.setAttribute('data-chatgpt-search-unit-key','fallback-turn-99:0:user');hidden.getClientRects=()=>[];regular.document.querySelector('main')!.append(hidden);
assert.equal(runInContext("inspectChatError(0,false,'inspect-recovery','https://chatgpt.com/c/idle','/c/idle|fallback-turn-0:0:user',expectedBinding).idle",regular.context),true);
const pendingIdle=setup();pendingIdle.controller.pendingSubmit={};const retryable=pendingIdle.inspect();assert.equal(retryable.ok,false);assert.equal(retryable.stopped,false);assert.equal(retryable.retryable,true,'missing idle proof explicitly confirms no Stop click and allows bounded readiness waiting');
console.log('Recovery visibility: hidden retained users ignored; missing positive idle proof is an explicit no-click retryable refusal.');
