import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
const url='https://chatgpt.com/c/test',op='op';
const source=readFileSync('extension/service-worker.js','utf8'),start=source.indexOf('async function restoreUnknownRetryDraft('),end=source.indexOf('// Re-arm only',start);assert.ok(start>0&&end>start);
async function run(variant='ok') {
 let events:any[]=[{kind:'draft.saved'},{kind:'draft.replaced'},{kind:'send.authorized'},{kind:'send.dispatched',text:'retry'},{kind:'retry.clicked'},{kind:'retry.failed',clicked:true,confirmed:false,errorCode:'RETRY_CONFIRMATION_UNPROVEN'},{kind:'retry.finished',clicked:true,confirmed:false}].map((e,i)=>({...e,sequence:i+1,sourceUrl:url,tabId:7,operationId:op}));
 if(variant==='new-request')events.push({kind:'request.started',sourceUrl:url,sequence:events.length+1});
 if(variant==='missing-click')events=events.filter(x=>x.kind!=='retry.clicked').map((x,i)=>({...x,sequence:i+1}));
 const oldOwner=variant==='reopened'||variant==='owner-open';if(oldOwner)events.forEach(e=>e.tabId=8);
 const draft:any={phase:'unknown',operationId:op,savedSequence:1,replacementProven:true,retryText:'retry',draft:'private'};
 const meta:any={sequence:events.length,active:{},retryPreparingByChat:{[url]:{operationId:op,tabId:oldOwner?8:7,claimKey:'key'}},retrySendClaims:{key:{operationId:op,tabId:oldOwner?8:7,phase:'consumed'}},retryConsumedOperations:{[op]:3}};
 if(variant==='active')meta.active[7]={};if(variant==='unconsumed')meta.retrySendClaims.key.phase='reserved';if(variant==='not-replaced')draft.replacementProven=false;
 let editor='';let inserted=0;const writes:any[]=[];function controlChatComposer(){}
 const ctx=createContext({URL,Number,Boolean,JSON,controlChatComposer,retryDraftUrl:(s:string)=>s,readRetryDraft:async()=>structuredClone(draft),readJournal:async()=>({ok:true,events:structuredClone(events),meta:structuredClone(meta)}),
 chrome:{tabs:{get:async(id:number)=>({id,url}),query:async()=>variant==='reopened'?[{id:7,url}]:[{id:7,url},{id:8,url}]},scripting:{executeScript:async(o:any)=>{if(o.args[0].action==='inspect-plain-retry-draft')return [{result:{ok:variant!=='editor-busy',matches:variant!=='editor-busy'}}];if(variant==='editor-race')return [{result:{ok:false}}];editor=o.args[0].draft;inserted++;return [{result:{ok:true}}]}}},
 appendJournal:async(e:any)=>{if(variant==='journal-race')throw Error('changed');writes.push(e);}});
 runInContext(source.slice(start,end),ctx);const result=await runInContext(`restoreUnknownRetryDraft(7,${JSON.stringify(url)})`,ctx);return{result,writes,inserted,editor};
}
const ok=await run();assert.equal(ok.result,true);assert.equal(ok.inserted,1);assert.equal(ok.editor,'private');assert.deepEqual(ok.writes.map(x=>x.kind),['draft.restore_intent','draft.restored']);
assert.equal((await run('reopened')).inserted,1,'a closed owner tab does not strand the saved draft');
for(const v of ['new-request','missing-click','active','unconsumed','not-replaced','journal-race','editor-busy','owner-open']){const x=await run(v);assert.equal(x.inserted,0,v);assert.equal(x.result,false,v);}
const race=await run('editor-race');assert.equal(race.inserted,0);assert.deepEqual(race.writes.map(x=>x.kind),['draft.restore_intent']);
const {document,window}=parseHTML('<html><body><form data-composer-body><div id="wrap"><div id="prompt-textarea" contenteditable="true"></div></div></form></body></html>');
Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{width:100,height:20}]});
const editor=document.querySelector('#prompt-textarea')!;let prompt='',pending:any=null,insertions=0;
const controller={view:{dom:editor},getChatGptPrompt:()=>({prompt,systemHints:[]}),getPlainText:()=>prompt,get pendingSubmit(){return pending},pendingBrowserAutocompleteSubmission:null,submitReady:false};
(document.querySelector('#wrap') as any).__reactFiber$test={memoizedProps:{composerController:controller}};
Object.assign(document,{createRange:()=>({selectNodeContents(){}}),execCommand:(_:string,__:boolean,text:string)=>{insertions++;editor.textContent=text;prompt=text;return true}});Object.assign(window,{getSelection:()=>({removeAllRanges(){},addRange(){}})});
const ctx=createContext({document,window,location:{href:url}});runInContext(readFileSync('extension/page-probe.js','utf8'),ctx);
function restore(){ctx.options={action:'restore-unknown-retry-draft',url,text:'',draft:'private',retryText:'retry'};return runInContext('controlChatComposer(options)',ctx)}
pending={};assert.equal(restore().ok,false);pending=null;editor.textContent='owner';prompt='owner';assert.equal(restore().ok,false);editor.textContent='retry';prompt='retry';assert.equal(restore().ok,false,'even retry-shaped new text is never overwritten');editor.textContent='';prompt='';
const attachment=document.createElement('div');attachment.setAttribute('data-composer-attachments','');attachment.innerHTML='<span>file</span>';document.querySelector('form')!.append(attachment);assert.equal(restore().ok,false);attachment.remove();
assert.equal(restore().ok,true);assert.equal(editor.textContent,'private');assert.equal(insertions,1);assert.equal(restore().ok,false,'later edit is never overwritten');
console.log('Unknown retry draft: saved journal proof, consumed send fence, editor-only restore, pending submission and attachment refusal passed.');
{
 const data:any={};const storage={get:async(k:any)=>structuredClone(k===null?data:Object.fromEntries((Array.isArray(k)?k:[k]).map(x=>[x,data[x]]))),set:async(v:any)=>Object.assign(data,structuredClone(v))};
 let ownerOpen=true;const tabs={query:async()=>ownerOpen?[{id:7,url},{id:8,url}]:[{id:8,url}]};
 const world=createContext({URL,Date,Number,Math,Object,console,chrome:{tabs,storage:{local:storage},runtime:{getManifest:()=>({version:'test'})}}});runInContext(readFileSync('extension/journal-store.js','utf8'),world);
 async function event(kind:string,extra:any={},tabId=7){world.event={kind,operationId:op,sourceUrl:url,promptKey:'/c/test|user',attemptId:'123',...extra};world.tabId=tabId;return runInContext('appendJournal(event,{id:tabId,url:event.sourceUrl})',world)}
 await event('retry.planned');await event('draft.saved',{draft:'private',text:'retry'});await event('draft.replaced');await event('retry.send_intent',{text:'retry'});await event('send.authorized');await event('send.dispatched',{text:'retry'});await event('retry.clicked');await event('retry.failed',{clicked:true,confirmed:false,errorCode:'RETRY_CONFIRMATION_UNPROVEN'});await event('draft.restore_deferred');await event('retry.finished',{clicked:true,confirmed:false});
 let meta=data['chatgpt-journal:meta'];assert.equal(meta.retryDraftByChat[url].phase,'unknown');const before=meta.sequence;
 await assert.rejects(()=>event('draft.restore_intent',{savedSequence:2,allowUnknown:true,expectedSequence:before-1}),'stale journal must not claim');
 await assert.rejects(()=>event('draft.restore_intent',{savedSequence:2,allowUnknown:true,originalTabId:7,expectedSequence:before},8),'a different live tab cannot steal the saved draft');
 ownerOpen=false;await event('draft.restore_intent',{savedSequence:2,allowUnknown:true,originalTabId:7,expectedSequence:before},8);await event('draft.restored',{unknownOutcome:true},8);meta=data['chatgpt-journal:meta'];
 assert.equal(meta.retryDraftByChat[url].unknownOutcome,true);assert.equal(meta.retryPreparingByChat[url].operationId,op,'restoring a draft must retain the uncertain send fence');assert.equal(meta.retrySendClaims[meta.retryPreparingByChat[url].claimKey].phase,'consumed');
 await assert.rejects(()=>event('retry.planned',{operationId:'second'}),'draft restore must not permit a duplicate retry');
 await assert.rejects(()=>event('handoff.navigation_intent',{operationId:'handoff'}),'draft restore must not permit handoff navigation');
}
