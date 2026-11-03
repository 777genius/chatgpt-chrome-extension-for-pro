import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
const url='https://chatgpt.com/c/failure',baseline='/c/failure|baseline:0:user',bound='/c/failure|bound:0:user';
const worker=readFileSync('extension/service-worker.js','utf8');
const reconcile=worker.slice(worker.indexOf('async function reconcileFailedCompletionLoading('),worker.indexOf('\nfunction normalizePathname('));
assert.ok(reconcile.length>100);
function harness(marked=true) {
 const checkpoint={schema:1,state:'active',url,startedAt:1000,attemptId:'1000',requestId:'request-2',baselineKey:baseline,promptKey:bound,httpCompleted:false,...(marked?{requestFailedAt:1100}:{})};
 const generation={epoch:'prior',order:42};
 const storage:Record<string,any>={'chatgpt-status:migration':{schema:1},'chatgpt-completion-checkpoint:7':checkpoint,
  ['chatgpt-status:'+url]:{url,revision:4,sequence:0,status:{kind:'loading',eventAt:1000,receipt:generation},notifications:[]},meta:{sequence:1},
  'event:000000000001':{kind:'request.failed',tabId:7,sourceUrl:url,requestId:'request-2',recordedAt:1100}};
 let request:any={startedAt:1000,requestId:'request-2',receipt:generation};
 let native:any={ok:true,url,promptKey:baseline,absentPromptKey:bound,composerIdle:true,isLatest:true,isReadOnly:false,generating:false,hasError:false,
  turnStatus:'complete',assistantPhase:'final_answer',assistantCompleted:true,assistantId:'old-answer',assistantKey:'baseline:1:assistant'};
 let probeHook=()=>{};const events:any[]=[];const updates:any[]=[];
 const chrome={storage:{local:{get:async(keys:string|string[])=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,storage[k]]))),set:async(values:Record<string,unknown>)=>Object.assign(storage,structuredClone(values))}},
  tabs:{get:async()=>({id:7,url})},scripting:{executeScript:async(options:any)=>{assert.deepEqual(JSON.parse(JSON.stringify(options.args)),[url,false,bound]);probeHook();return [{result:structuredClone(native)}];}}};
 const ctx=createContext({chrome,URL,console,JOURNAL_META:'meta',JOURNAL_PREFIX:'event:',ChatGPTHandoffTitle:{chatUrl:(v:string)=>v===url?url:''},
  latestRequestReceipt:async()=>request,inspectCompletedTurn:()=>{},appendJournal:async(e:any)=>events.push(e),broadcastChatStatus:async(e:any)=>updates.push(e)});
 runInContext(readFileSync('extension/completion-checkpoint.js','utf8')+'\n'+readFileSync('extension/status-store.js','utf8')+'\n'+reconcile,ctx);
 return {storage,events,updates,ctx,get native(){return native;},setNative(v:Record<string,unknown>){native={...native,...v};},setRequest(v:any){request={...request,...v};},onProbe(fn:()=>void){probeHook=fn;},run:()=>runInContext(`reconcileFailedCompletionLoading(7,${JSON.stringify(url)})`,ctx) as Promise<any>};
}
for(const marked of [true,false]) {
 const h=harness(marked);assert.equal((await h.run()).changed,true);
 assert.equal(h.storage['chatgpt-status:'+url].status,null,'failed optimistic turn rollback clears the loader, never completes the older answer');
 assert.equal(h.storage['chatgpt-completion-checkpoint:7'].state,'failed');
 assert.equal(h.events[0].kind,'completion.failed_rollback');assert.equal(h.events.length,1);
 assert.equal((await h.run()).changed,false,'the same failure cannot replay its transition');
}
for(const change of [{composerIdle:false},{generating:true},{hasError:true},{promptKey:'/c/failure|newer:0:user'},
 {absentPromptKey:null},{isLatest:false},{isReadOnly:true},{assistantCompleted:false},{url:'https://chatgpt.com/c/other'}]) {
 const h=harness();h.setNative(change);assert.equal((await h.run()).changed,false);
 assert.equal(h.storage['chatgpt-status:'+url].status.kind,'loading');assert.equal(h.storage['chatgpt-completion-checkpoint:7'].state,'active');
}
for(const change of [{requestId:'wrong'},{startedAt:1001},{url:'https://chatgpt.com/c/other'},{receipt:null},{receipt:{epoch:'prior',order:43}}]) {
 const h=harness();h.setRequest(change);assert.equal((await h.run()).changed,false);assert.equal(h.events.length,0);
}
for(const change of [{requestId:'wrong'},{tabId:8},{sourceUrl:'https://chatgpt.com/c/other'},{recordedAt:999}]) {
 const h=harness(false);Object.assign(h.storage['event:000000000001'],change);
 assert.equal((await h.run()).changed,false,'legacy failure discovery requires exact retained receipt and journal binding');
}
{
 const h=harness();h.onProbe(()=>{h.setRequest({startedAt:2000,requestId:'new-request',receipt:{epoch:'prior',order:50}});h.storage['chatgpt-completion-checkpoint:7']={...h.storage['chatgpt-completion-checkpoint:7'],startedAt:2000,requestId:'new-request'};h.storage['chatgpt-status:'+url]={...h.storage['chatgpt-status:'+url],revision:5,status:{kind:'loading',eventAt:2000,receipt:{epoch:'prior',order:50}}};});
 assert.equal((await h.run()).changed,false,'a new request arriving during native inspection fences failure rollback');
 assert.equal(h.storage['chatgpt-status:'+url].status.eventAt,2000);
}
{
 const h=harness();h.onProbe(()=>{h.storage['chatgpt-status:'+url].revision++;});assert.equal((await h.run()).changed,false,'a status revision race is not overwritten');
 assert.equal(await runInContext("completionCheckpointFailure(7,{startedAt:1000,requestId:'wrong',failedAt:1200})",h.ctx),false);
 assert.equal(await runInContext("completionCheckpointFailure(7,{startedAt:999,requestId:'request-2',failedAt:1200})",h.ctx),false);
}
// Exercise the actual readonly native adapter, not only the worker's metadata contract.
{
 const {document,window}=parseHTML(`<section data-app-shell-active-page="true"><article data-content-search-turn-key="baseline"><div data-chatgpt-search-unit-key="baseline:0:user">Old request</div><div data-chatgpt-search-unit-key="baseline:1:assistant">Old answer</div></article><form data-composer-body><div data-composer-markdown contenteditable="true">PRIVATE DRAFT</div><button><svg><use href="#codex-icon-voice-regular-20" /></svg></button></form></section>`);
 Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value(){return this.hidden?[]:[{}];},configurable:true});
 const entry={id:'baseline',isMostRecentTurn:true,isReadOnly:false,errorMessage:null,turn:{status:'complete',items:[{type:'user-message',messageId:'u-old'},{type:'assistant-message',messageId:'a-old',phase:'final_answer',completed:true}]}};
 const entries:any[]=[entry],voiceProps={isLoading:false,isStartButtonAllowed:true};
 const editor=document.querySelector('[contenteditable]')!;
 const controller={view:{dom:editor},getChatGptPrompt:()=>{throw Error('Draft must never be read');},pendingSubmit:null as unknown,pendingBrowserAutocompleteSubmission:null as unknown,submitReady:true};
 (document.querySelector('[data-content-search-turn-key]')! as any).__reactFiber$test={memoizedProps:{entries},return:null};
 (document.querySelector('button')! as any).__reactFiber$test={memoizedProps:voiceProps,return:null};
 (document.querySelector('form')! as any).__reactFiber$test={memoizedProps:{composerController:controller},return:null};
 const ctx=createContext({document,location:{origin:'https://chatgpt.com',pathname:'/c/failure'},URL});runInContext(readFileSync('extension/completion-probe.js','utf8'),ctx);
 const probe=()=>JSON.parse(JSON.stringify(runInContext(`inspectCompletedTurn(${JSON.stringify(url)},false,${JSON.stringify(bound)})`,ctx)));
 assert.equal(probe().composerIdle,true);assert.equal(probe().absentPromptKey,bound);
 voiceProps.isLoading=true;assert.equal(probe().composerIdle,false);voiceProps.isLoading=false;
 controller.pendingSubmit={};assert.equal(probe().composerIdle,false);controller.pendingSubmit=null;
 controller.pendingBrowserAutocompleteSubmission={};assert.equal(probe().composerIdle,false);controller.pendingBrowserAutocompleteSubmission=null;
 entries.unshift({...entry,id:'bound'});assert.equal(probe().absentPromptKey,null,'an existing native bound turn cannot be called rolled back');
 assert.equal(editor.textContent,'PRIVATE DRAFT');
}
{
 const source=readFileSync('extension/content-script.js','utf8');
 const fn=source.slice(source.indexOf('  async function reconcileFailedCompletionLoading()'),source.indexOf('  async function restoreCompletionCheckpoint()'));
 for(const race of [false,true]) {
  let cancels=0,accepted=0;const world=createContext({location:{pathname:'/c/failure',href:url},__chatgptNotifierAttemptId:'1000',__chatgptNotifierRequestId:'request-2',
   runtimeAvailable:()=>true,completionAttempt:{id:'1000',requestId:'request-2'},watchToken:1,
   answerWaitSlot:{cancel:()=>cancels++},statusIndicator:{accept:()=>accepted++},sleepUntilNextCheck:async()=>{},
   runtimeMessage:async()=>{if(race)world.__chatgptNotifierAttemptId='newer';return {changed:true,url,status:null,revision:5};}});
  await runInContext(fn+';reconcileFailedCompletionLoading()',world);
  assert.equal(cancels,race?0:1,'only an unchanged failed attempt retires its observers');assert.equal(accepted,race?0:1);
 }
}
console.log('Failed completion rollback: observed request, exact receipt/native idle+baseline, legacy bounded discovery, newer request races, no old-answer success passed.');
