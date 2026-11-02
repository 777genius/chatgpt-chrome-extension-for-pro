import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext,type Context} from 'node:vm';
import {parseHTML} from 'linkedom';
const sourceUrl='https://chatgpt.com/c/draft-fixture';
const draft='  Exact private draft\n\nsecond line  ';
type Mode='confirmed'|'no-click'|'stopped'|'unknown'|'saved-only'|'marker'|'concurrent'|'attachments'|'claim-race'|'other-chat'|'late-composer';
async function check(mode:Mode) {
  const data:Record<string,any>={'chatgpt-status:migration':{schema:1}};
  const {document,window}=parseHTML('<html><body><main></main><form><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button></form></body></html>');
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
  const editor=document.querySelector('#prompt-textarea')!;
  if(['marker','unknown'].includes(mode))editor.textContent='доделай е2е';
  if(mode==='concurrent')editor.textContent='Owner concurrent text';
  if(mode==='attachments')document.querySelector('form')!.insertAdjacentHTML('beforeend','<div data-testid="attachment-chip">File</div>');
  if(mode==='late-composer')editor.remove();
  Object.assign(document,{createRange:()=>({selectNodeContents(){}}),execCommand:(_command:string,_show:boolean,text:string)=>{inserts++;editor.textContent=text;return true;}});
  Object.assign(window,{getSelection:()=>({removeAllRanges(){},addRange(){}})});
  const tab={id:7,url:(mode==='other-chat'?'https://chatgpt.com/c/other-fixture':sourceUrl)+'/?q=test#fragment',windowId:1,active:false};
  let worker!:Context,content!:Context,messageHandler:Function=()=>{},clicks=0,notifications=0,inserts=0;
  function bootWorker(){
    const event=(name:string)=>({addListener:(fn:Function)=>{if(name==='message')messageHandler=fn;}});
    const chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),getURL:(path:string)=>'chrome-extension://fixture/'+path,getContexts:async()=>[{}],sendMessage:async()=>{},onMessage:event('message'),onInstalled:event('install'),onStartup:event('startup')},
      storage:{local:{get:async(keys:string|string[]|null)=>structuredClone(Object.fromEntries((keys===null?Object.keys(data):Array.isArray(keys)?keys:[keys]).map(key=>[key,data[key]]))),set:async(values:Record<string,unknown>)=>Object.assign(data,structuredClone(values))}},
      webRequest:{onBeforeRequest:event('before'),onCompleted:event('completed'),onErrorOccurred:event('failed')},
      tabs:{get:async()=>({...tab}),query:async()=>[],sendMessage:async()=>{},onRemoved:event('removed')},windows:{get:async()=>({focused:false})},
      scripting:{executeScript:async()=>{clicks++;throw Error('No page action permitted in a restore fixture');}},
      notifications:{getAll:async()=>({}),create:async()=>{notifications++;return '';},clear:async()=>true,onClicked:event('clicked')}};
    worker=createContext({URL,console,chrome,setTimeout,clearTimeout});worker.importScripts=(name:string)=>runInContext(readFileSync('extension/'+name,'utf8'),worker);
    runInContext(readFileSync('extension/service-worker.js','utf8'),worker);
  }
  async function append(kind:string,extra:Record<string,unknown>={}){worker.event={kind,sourceUrl,operationId:'draft-op',...extra};await runInContext(`appendJournal(event,{id:7,url:'${sourceUrl}'})`,worker);}
  function bootContent(){
    const runtime={id:'fixture',onMessage:{addListener(){},removeListener(){}},sendMessage:(message:any)=>new Promise(resolve=>{
      let answered=false;const result=messageHandler(message,{frameId:0,tab:{...tab}},(answer:any)=>{
        if(message.type==='CHATGPT_RETRY_DRAFT_CLAIM'&&mode==='claim-race'&&answer?.claimed)editor.textContent='Edit while claim was awaited';
        answered=true;resolve(answer);
      });if(result!==true&&!answered)resolve(undefined);
    })};
    const location=new URL(tab.url);
    content=createContext({URL,document,window,location,chrome:{runtime},AbortController,crypto:globalThis.crypto,Node:window.Node,Element:window.Element,Event:window.Event,HTMLTextAreaElement:window.HTMLTextAreaElement,MutationObserver:window.MutationObserver,Date,performance,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){}});
    for(const name of ['memory-maintenance.js','handoff-title.js','content-script.js'])runInContext(readFileSync('extension/'+name,'utf8'),content);
  }
  async function drain(){for(let i=0;i<35;i++)await new Promise<void>(resolve=>setImmediate(resolve));}
  try {
    bootWorker();await append('draft.saved',{draft,phase:mode==='stopped'?'before-recovery-stop':undefined});
    if(!['saved-only','marker','stopped'].includes(mode))await append('draft.replaced');
    if(mode==='stopped')await append('recovery.stop_result',{stopped:true});
    if(['confirmed','unknown'].includes(mode)){await append('retry.send_intent');await append('send.authorized');}
    if(mode==='confirmed')await append('retry.confirmed');
    if(mode==='no-click')await append('retry.cancelled');
    bootWorker();bootContent();await drain();
    if(mode==='late-composer'){document.querySelector('form')!.prepend(editor);await drain();}
    const blocked=['unknown','saved-only','concurrent','attachments','claim-race','other-chat'].includes(mode);
    const expected=mode==='unknown'?'доделай е2е':mode==='concurrent'?'Owner concurrent text':mode==='claim-race'?'Edit while claim was awaited':blocked?'':draft;
    assert.equal(editor.textContent,expected,mode);
    const index=data['chatgpt-journal:meta'].retryDraftByChat[sourceUrl];
    assert.equal(Boolean(index.claimedAt),!blocked||mode==='claim-race',mode+' claim eligibility');
    const count=inserts;runInContext('globalThis.__chatgptNotifierDispose()',content);
    if(!blocked)editor.textContent='New owner edit after restore';
    bootWorker();bootContent();await drain();
    assert.equal(inserts,count,'another full reload cannot reinsert '+mode);
    assert.equal(clicks,0,'draft restoration never reaches a sender or native click');assert.equal(notifications,0,'restore has no OS alert side effect');
  } finally {if(content)runInContext('globalThis.__chatgptNotifierDispose?.()',content);}
}
for(const mode of ['confirmed','no-click','stopped','unknown','saved-only','marker','concurrent','attachments','claim-race','other-chat','late-composer'] as const)await check(mode);
console.log('Retry draft reload: exact one-claim restoration, completed/no-click/STOP proofs, unknown parking, saved-only refusal, concurrent edits, attachments, late composer and chat isolation passed.');
