import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
const source=readFileSync('extension/memory-maintenance.js','utf8')+'\n'+readFileSync('extension/handoff-title.js','utf8')+'\n'+readFileSync('extension/content-script.js','utf8');
const probe=readFileSync('extension/page-probe.js','utf8');
const workerSource=readFileSync('extension/service-worker.js','utf8');
const handoffWorker=workerSource.slice(workerSource.indexOf('const handoffWrites ='),workerSource.indexOf('chrome.runtime.onMessage.addListener'));
function testClock() {
 let now=1000000,nextId=0;
 type Timer={at:number;callback:()=>void;period:number|null};
 const timers=new Map<number,Timer>();
 const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
 function schedule(callback:()=>void,delay:number,period:number|null=null) {
  const id=++nextId;
  // Node truncates fractional timer delays; preserve this behavior so the
  // late-route case can exercise the exact production throttle boundary.
  timers.set(id,{at:now+Math.max(1,Math.trunc(delay)),callback,period});return id;
 }
 function next(){return [...timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];}
 function fire([id,timer]:[number,Timer]) {
  now=timer.at;
  if(timer.period===null)timers.delete(id);else timer.at+=timer.period;
  timer.callback();
 }
 return {
  now:()=>now,drain,
  setTimeout:(callback:()=>void,delay=0)=>schedule(callback,delay),
  clearTimeout:(id:number)=>{timers.delete(id);},
  setInterval:(callback:()=>void,delay:number)=>schedule(callback,delay,Math.max(1,Math.trunc(delay))),
  clearInterval:(id:number)=>{timers.delete(id);},
  async advance(ms:number) {
   const end=now+ms;await drain();
   for(let timer=next();timer&&timer[1].at<=end;timer=next()){fire(timer);await drain();}
   now=end;await drain();
  },
  async until(check:()=>boolean,label:string,budgetMs=70000) {
   const end=now+budgetMs;
   for(let steps=0;steps<10000;steps++) {
    await drain();if(check())return;
    const timer=next();
    assert.ok(timer&&timer[1].at<=end,`${label}: no scheduled event can complete the transition within ${budgetMs}ms`);
    fire(timer);
   }
   assert.fail(`${label}: scheduled events did not settle`);
  }
 };
}
const originalURL='https://chatgpt.com/c/source';
const history=[
 {role:'assistant',id:'a1',text:'Earlier answer\n```ts\nconst x = 1;\n```'},
 {role:'user',id:'u1',text:'First request'},
 {role:'user',id:'u2',text:'Last request'},
 {role:'assistant',id:'a2',text:'Last answer'}
];
function probeCheck(){
 const {document}=parseHTML('<aside role="alert" class="text-danger"><button>任意の翻訳</button></aside>');
 const entries=[{id:'t1',turn:{items:[{type:'assistant-message',messageId:'a1',phase:'final_answer',content:'earlier'}]}},
 {id:'t2',turn:{items:[{type:'user-message',messageId:'u1',message:'first'}]}},
 {id:'t3',turn:{items:[{type:'user-message',messageId:'u2',message:'last'},
 {type:'chatgpt-reasoning-group',items:[{type:'assistant-message',content:'DO NOT INCLUDE REASONING'}]},
 {type:'assistant-message',phase:'final_answer',messageId:'a2',content:'::chatgpt-content-reference{index="0"}',contentReferences:[{model_dil_v2:{fallbackMarkdown:'Full answer\nwith code'}}]}]}}];
 const btn=document.querySelector('button')! as any;
 const fiber={memoizedProps:{children:{props:{id:'chatgptConversations.responseError.startNewChat'}}},return:{memoizedProps:{entries},return:null}};
 btn.__reactFiber$test=fiber;
 const ctx=createContext({document});runInContext(probe,ctx);
 const result=JSON.parse(JSON.stringify(runInContext('inspectChatError(0,true)',ctx)));
 assert.equal(result.action,'new-chat');assert.equal(result.incomplete,false);
 assert.deepEqual(result.messages.map((m:any)=>m.id),['a1','u1','u2','a2']);
 assert.equal(result.messages[3].text,'Full answer\nwith code');
 const unknown=document.createElement('span');unknown.textContent='Unknown error';document.querySelector('aside')!.prepend(unknown);
 assert.equal(runInContext('inspectChatError(0,true).action',ctx),'retry','Unknown error must override a generic Start new chat CTA');
 assert.equal(runInContext('inspectChatError(0,true).messages.length',ctx),0,'Unknown error must not capture a handoff payload');
 unknown.textContent='Maximum conversation length reached';
 assert.equal(runInContext('inspectChatError(0,true).action',ctx),'new-chat','a real length-limit CTA still uses handoff');unknown.remove();

 fiber.memoizedProps.children.props.id='chatgptConversations.responseError.retry';
 assert.equal(runInContext('inspectChatError(0,true).action',ctx),'retry');
 fiber.memoizedProps.children.props.id='unknown';
 assert.equal(runInContext('inspectChatError(0,true).action',ctx),'unknown');
 const delivery=document.createElement('aside') as any;delivery.setAttribute('role','alert');delivery.className='text-danger';delivery.textContent='配信がタイムアウトしました';
 const entry={isMostRecentTurn:true,isReadOnly:false,showRequestUserInputStatus:true,showPendingLoadingMessage:false,
  turn:{status:'in_progress'},errorMessage:delivery.textContent};
 delivery.__reactFiber$test={memoizedProps:{entry},return:null};document.append(delivery);
 assert.equal(runInContext('inspectChatError(1).action',ctx),'retry','native input delivery error works without a retry button');
 entry.isMostRecentTurn=false;assert.equal(runInContext('inspectChatError(1).action',ctx),'unknown');entry.isMostRecentTurn=true;
 entry.isReadOnly=true;assert.equal(runInContext('inspectChatError(1).action',ctx),'unknown');entry.isReadOnly=false;
 entry.errorMessage='Different error';assert.equal(runInContext('inspectChatError(1).action',ctx),'unknown');delivery.remove();
 const status=document.createElement('div') as any;status.setAttribute('role','status');status.innerHTML='<span class="text-chatgpt-recovery">日本語</span>';
 status.__reactFiber$test={memoizedProps:{children:{props:{children:{props:{id:'errors.network.reconnecting_fallback'}}}}},return:null};document.append(status);
 assert.equal(runInContext('inspectChatError(1,true).action',ctx),'retry','recovery localization ID must classify without translated text or button');
 const stop=document.createElement('button') as any;stop.setAttribute('type','button');stop.innerHTML='<svg class="icon-primary-action"><path d="M4.5 5.75C4.5 stop"></path></svg>';
 const composer=document.createElement('form');composer.setAttribute('data-composer-body','');composer.append(stop);document.append(composer);
 stop.getClientRects=()=>[{}];status.getClientRects=()=>[{}];let stops=0;stop.addEventListener('click',()=>stops++);
 Object.assign(ctx,{location:{href:'https://chatgpt.com/c/test'}});
 assert.equal(runInContext("inspectChatError(1,false,'stop-recovery','https://chatgpt.com/c/other').ok",ctx),false);assert.equal(stops,0);
 assert.equal(runInContext("inspectChatError(1,false,'stop-recovery','https://chatgpt.com/c/test').stopped",ctx),true);assert.equal(stops,1);
 status.__reactFiber$test.memoizedProps.children.props.children.props.id='unrelated.status';
 assert.equal(runInContext("inspectChatError(1,false,'stop-recovery','https://chatgpt.com/c/test').ok",ctx),false);assert.equal(stops,1,'only confirmed recovery may trigger native stop');
 assert.equal(runInContext('inspectChatError(1,true).action',ctx),'unknown','unrelated status must not authorize a retry');
 console.log('PASS: locale-independent recovery action, original message order, full DIL fallback, no reasoning capture');
}
async function transferCheck(long=false,ambiguous=false,hiddenFirstPrompt=false,temporaryTarget=false,lateTarget=false){
 const {document,window}=parseHTML('<html><head><title>Fixture task</title></head><body><section data-app-shell-active-page="false"><article data-testid="conversation-turn-cached" data-turn="user">Cached history</article><div data-composer-markdown contenteditable="true">Cached draft</div></section><section data-app-shell-active-page="true"><main><article data-testid="conversation-turn-0" data-turn="user">Last request</article></main><form data-composer-body><div data-composer-markdown contenteditable="true">Saved draft\nsecond line</div><button type="submit">Send</button><input type="file"></form></section></body></html>');
 Object.defineProperty(window.Node,'DOCUMENT_POSITION_FOLLOWING',{value:4,configurable:true});
 Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
 const loc={href:originalURL,pathname:'/c/source'};
 const notices:any[]=[],sends:string[]=[],updates:string[]=[];
 let stored:any=null;
 const storage:Record<string,any>={};
 const clock=testClock();
 const messages=history.map(m=>({...m}));if(long)messages[3].text='Large context\n'.repeat(1500);
 Object.assign(document,{createRange:()=>({selectNodeContents(){}}),execCommand:(_:any,__:any,text:string)=>{document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent=text;return true;}});
 Object.assign(window,{getSelection:()=>({removeAllRanges(){},addRange(){}})});
 class Transfer { items={add:(file:any)=>{this.files.push(file)}}; files:any[]=[]; }
 const runtime:any={id:'test-extension',onMessage:{addListener(){}},sendMessage:async(m:any)=>{
   if(m.type==='CHATGPT_RETRY_STATE')return {ok:true,state:null};
   if(m.type==='CHATGPT_WAIT'){await new Promise<void>(resolve=>clock.setTimeout(resolve,m.delayMs));return {ok:true};}
   if(m.type==='CHATGPT_COMPOSER_CONTROL'){if(m.options.action==='send'){const submittedText=m.options.text;document.querySelector('button[type=submit]')!.dispatchEvent(new window.Event('click'));(context as any).receiptMessage={type:'HANDOFF_CLICK_RECEIPT',id:stored.id,receipt:{operationId:stored.id,submittedText,clickedAt:clock.now()}};await runInContext('handleHandoffMessage(receiptMessage,7)',context);return {ok:true,clicked:true,effort:'max',submittedText,clickedAt:clock.now()};}return {ok:true,matches:true,ready:true,effort:'max'};}
   if(m.type==='CHATGPT_LOG_EVENT')return {ok:true};
   if(m.type==='CHATGPT_INSPECT_ATTACHMENT')return {ok:true,status:(document.querySelector('input') as any).files?.length?'ready':'missing'};
   if(m.type==='CHATGPT_INSPECT_ERROR')return {ok:true,action:'new-chat',messages,incomplete:false};
   if(['CHATGPT_HANDOFF_GET','CHATGPT_HANDOFF_BEGIN','CHATGPT_HANDOFF_UPDATE','CHATGPT_HANDOFF_RECONCILE','CHATGPT_HANDOFF_DRAFT_CLAIM'].includes(m.type)){
    if(m.type==='CHATGPT_HANDOFF_BEGIN')assert.equal(loc.href,originalURL,'backup must precede navigation');
    if(m.type==='CHATGPT_HANDOFF_UPDATE')updates.push(m.stage);
    (context as any).handoffMessage=m;return runInContext('handleHandoffMessage(handoffMessage,7)',context);
   }
   notices.push(m);return {};
 }};
 const context=createContext({URL,window,document,location:loc,chrome:{runtime,storage:{local:{get:async(key:string)=>structuredClone({[key]:storage[key]}),set:async(value:Record<string,unknown>)=>{Object.assign(storage,structuredClone(value));stored=storage['chatgpt-handoff:7'];}}},tabs:{get:async()=>({id:7,url:loc.href})},scripting:{executeScript:async({func,args}:any)=>[{result:func(...args)}]}},appendJournal:async()=>({ok:true}),MutationObserver:window.MutationObserver,Node:window.Node,Element:window.Element,Event:window.Event,
 HTMLTextAreaElement:window.HTMLTextAreaElement,AbortController,crypto:globalThis.crypto,File,DataTransfer:Transfer,
 Date:class extends Date{static now(){return clock.now();}},performance:{now:clock.now},setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,setInterval:clock.setInterval,clearInterval:clock.clearInterval});
 document.querySelector('input')!.addEventListener('change',()=>{
   const file=(document.querySelector('input')! as any).files[0];
   const chip=document.createElement('div');chip.textContent=file.name;document.body.append(chip);
 });
 document.querySelector('button[type=submit]')!.addEventListener('click',()=>{
   sends.push(document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent!);
   if(ambiguous)return;
   document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent='';
   document.querySelector('main')!.innerHTML=hiddenFirstPrompt ? '<article data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">Working</article>' : '<article data-testid="conversation-turn-new" data-turn="user">Transferred history</article>';
   (context as any).__chatgptNotifierAttemptId='new-request-observed';
   (document.querySelector('[data-app-shell-active-page="true"] [data-composer-body]') as any).__reactFiber$accepted={memoizedProps:{entries:[{id:'accepted-turn',turn:{items:[{type:'user-message',messageId:'accepted-message',message:sends.at(-1)}]}}]},return:null};
   if(temporaryTarget||lateTarget){
     loc.href='https://chatgpt.com/c/local-chatgpt%3Afixture-id';loc.pathname='/c/local-chatgpt%3Afixture-id';
     if(!lateTarget)clock.setTimeout(()=>{loc.href='https://chatgpt.com/c/target';loc.pathname='/c/target';},300);
   }else{loc.href='https://chatgpt.com/c/target';loc.pathname='/c/target';}
 });
 runInContext(probe+'\n'+handoffWorker+'\n'+source,context);
 const alert=document.createElement('aside');alert.setAttribute('role','alert');alert.className='text-danger';alert.innerHTML='<div>最大長</div><button>新しいチャット</button>';
 alert.querySelector('button')!.addEventListener('click',()=>{
   assert.ok(stored.text.includes('Earlier answer'),'source copy must be durable');
   loc.href='https://chatgpt.com/';loc.pathname='/';document.querySelector('main')!.innerHTML='';
   document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent='Last request';
 });
 const effort=document.createElement('button');effort.setAttribute('data-composer-navigation-target','reasoning');effort.setAttribute('data-selected-reasoning-effort','max');document.querySelector('[data-app-shell-active-page="true"]')!.append(effort);
 document.querySelector('main')!.append(alert);
 const expectedStage=ambiguous||lateTarget?'awaiting-confirmation':'sent';
 const lineageKey='chatgpt-handoff-title:https://chatgpt.com/c/target';
 const activeEditor=()=>document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!;
 const transferred=()=>stored?.stage==='sent'&&storage[lineageKey]?.part===1&&Boolean(stored.draftRestoreClaimedAt)&&activeEditor().textContent==='Saved draft\nsecond line';
 await clock.until(()=>expectedStage==='sent'?transferred():stored?.stage===expectedStage,'initial handoff transition');
 if(lateTarget){
   assert.equal(stored.stage,'awaiting-confirmation','a late permanent route remains recoverable after the 60s observation deadline');
   assert.ok(stored.sendReceipt.submittedText,'native click receipt survives the observation deadline');
   (context as any).__chatgptNotifierDispose();runInContext(source,context);await clock.drain();
   assert.equal(stored.stage,'awaiting-confirmation');
   // Deliver one route event halfway between whole milliseconds. A fractional
   // worker wait truncated below the 2s throttle loses this only wake-up.
   await clock.advance(500.5);
   loc.href='https://chatgpt.com/c/target';loc.pathname='/c/target';
   document.querySelector('main')!.append(document.createElement('span'));
   await clock.until(transferred,'late route must durably confirm transfer, lineage and draft restoration',5000);
   assert.equal(storage[lineageKey].part,1,'late reconciliation persists continuation lineage');
 }
 assert.equal(notices.filter(n=>n.type==='CHATGPT_RESPONSE_ERROR').length,ambiguous||lateTarget?2:1,'unknown send notifies only once in addition to the terminal source error');
 assert.equal(sends.length,1,'handoff sends once');assert.notEqual(sends[0],'доделай е2е');
 assert.equal(stored.stage,ambiguous?'awaiting-confirmation':'sent');
 assert.ok(stored.text.indexOf('Earlier answer')<stored.text.indexOf('First request'));
 assert.ok(stored.text.indexOf('First request')<stored.text.indexOf('Last request'));
 if(long){const file=(document.querySelector('input')! as any).files[0];assert.equal(await file.text(),stored.text);assert.ok(sends[0].includes(file.name));}
 else assert.equal(sends[0],stored.text);
 if(!ambiguous)assert.equal(document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent,'Saved draft\nsecond line');
 if(lateTarget){
   document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent='Owner new draft';
   (context as any).__chatgptNotifierDispose();runInContext(source,context);await clock.drain();
   assert.equal(document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent,'Owner new draft','content restart preserves newer owner edits after one draft restoration');
   assert.equal(sends.length,1);assert.equal(stored.draft,'Saved draft\nsecond line');
 }
 if(ambiguous){runInContext(source,context);await clock.advance(500);assert.equal(sends.length,1,'reinjection must not repeat ambiguous send');}
 console.log(`PASS: ${long?'large file':'inline'} handoff, durable backup before navigation, ${ambiguous?'uncertain send stops':'draft restored'}, one send, immediate error notification`);
 // Invalidate runtime: old observers/listeners must not throw or send anything.
 runtime.sendMessage=()=>{throw new Error('Extension context invalidated.');};
 document.dispatchEvent(new window.Event('pointerdown'));
 await clock.drain();
 const before=sends.length;document.querySelector('main')!.append(document.createElement('span'));await clock.advance(1000);assert.equal(sends.length,before);
}
const rawFunction=source.slice(source.indexOf('  function rawEditorText'),source.indexOf('  function replaceEditorText'));
const rich=parseHTML('<div id="e"><p>URL <span><span aria-hidden="true">icon</span>https://example.com</span></p><p><br class="ProseMirror-trailingBreak"></p><p>Code   spacing</p></div>');
const richContext=createContext({document:rich.document,Node:rich.window.Node});runInContext(rawFunction,richContext);
assert.equal(runInContext("rawEditorText(document.querySelector('#e'))",richContext),'URL https://example.com\n\nCode   spacing');
console.log('PASS: exact draft serialization despite rich URL widgets and paragraph layout');
probeCheck();await transferCheck();await transferCheck(true);await transferCheck(false,true);await transferCheck(false,false,true);await transferCheck(false,false,false,true);await transferCheck(false,false,false,false,true);
