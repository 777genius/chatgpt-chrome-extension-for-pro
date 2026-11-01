import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
const source=readFileSync('extension/memory-maintenance.js','utf8')+'\n'+readFileSync('extension/handoff-title.js','utf8')+'\n'+readFileSync('extension/content-script.js','utf8');
const probe=readFileSync('extension/page-probe.js','utf8');
const pause=()=>new Promise(r=>setTimeout(r,500));
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
async function transferCheck(long=false,ambiguous=false,hiddenFirstPrompt=false,temporaryTarget=false){
 const {document,window}=parseHTML('<html><body><section data-app-shell-active-page="false"><article data-testid="conversation-turn-cached" data-turn="user">Cached history</article><div data-composer-markdown contenteditable="true">Cached draft</div></section><section data-app-shell-active-page="true"><main><article data-testid="conversation-turn-0" data-turn="user">Last request</article></main><form data-composer-body><div data-composer-markdown contenteditable="true">Saved draft\nsecond line</div><button type="submit">Send</button><input type="file"></form></section></body></html>');
 Object.defineProperty(window.Node,'DOCUMENT_POSITION_FOLLOWING',{value:4,configurable:true});
 Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
 const loc={href:originalURL,pathname:'/c/source'};
 const notices:any[]=[],sends:string[]=[],updates:string[]=[];
 let stored:any=null;
 let clock=1000000;
 const messages=history.map(m=>({...m}));if(long)messages[3].text='Large context\n'.repeat(1500);
 Object.assign(document,{createRange:()=>({selectNodeContents(){}}),execCommand:(_:any,__:any,text:string)=>{document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent=text;return true;}});
 Object.assign(window,{getSelection:()=>({removeAllRanges(){},addRange(){}})});
 class Transfer { items={add:(file:any)=>{this.files.push(file)}}; files:any[]=[]; }
 const runtime:any={id:'test-extension',onMessage:{addListener(){}},sendMessage:async(m:any)=>{
   if(m.type==='CHATGPT_RETRY_STATE')return {ok:true,state:null};
   if(m.type==='CHATGPT_WAIT'){await new Promise(r=>setTimeout(r,m.delayMs));return {ok:true};}
   if(m.type==='CHATGPT_COMPOSER_CONTROL'){if(m.options.action==='send'){document.querySelector('button[type=submit]')!.dispatchEvent(new window.Event('click'));return {ok:true,clicked:true,effort:'max'};}return {ok:true,matches:true,ready:true,effort:'max'};}
   if(m.type==='CHATGPT_LOG_EVENT')return {ok:true};
   if(m.type==='CHATGPT_INSPECT_ATTACHMENT')return {ok:true,status:(document.querySelector('input') as any).files?.length?'ready':'missing'};
   if(m.type==='CHATGPT_INSPECT_ERROR')return {ok:true,action:'new-chat',messages,incomplete:false};
   if(m.type==='CHATGPT_HANDOFF_GET')return {ok:true,record:stored};
   if(m.type==='CHATGPT_HANDOFF_BEGIN'){assert.equal(loc.href,originalURL,'backup must precede navigation');stored={...m.record,stage:'navigating'};return {ok:true,record:stored};}
   if(m.type==='CHATGPT_HANDOFF_UPDATE'){if(m.stage==='sent')assert.equal(m.targetUrl,'https://chatgpt.com/c/target','handoff must await the permanent server URL');updates.push(m.stage);stored={...stored,...m};return {ok:true,record:stored};}
   notices.push(m);return {};
 }};
 const context=createContext({URL,window,document,location:loc,chrome:{runtime},MutationObserver:window.MutationObserver,Node:window.Node,Element:window.Element,Event:window.Event,
 HTMLTextAreaElement:window.HTMLTextAreaElement,AbortController,crypto:globalThis.crypto,File,DataTransfer:Transfer,
 Date:class extends Date{static now(){return clock;}},performance,setTimeout,clearTimeout,setInterval,clearInterval});
 document.querySelector('input')!.addEventListener('change',()=>{
   const file=(document.querySelector('input')! as any).files[0];
   const chip=document.createElement('div');chip.textContent=file.name;document.body.append(chip);
 });
 document.querySelector('button[type=submit]')!.addEventListener('click',()=>{
   sends.push(document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent!);
   if(ambiguous){setTimeout(()=>{clock+=61000},50);return;}
   document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent='';
   document.querySelector('main')!.innerHTML=hiddenFirstPrompt ? '<article data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">Working</article>' : '<article data-testid="conversation-turn-new" data-turn="user">Transferred history</article>';
   (context as any).__chatgptNotifierAttemptId='new-request-observed';
   if(temporaryTarget){
     loc.href='https://chatgpt.com/c/local-chatgpt%3Afixture-id';loc.pathname='/c/local-chatgpt%3Afixture-id';
     setTimeout(()=>{loc.href='https://chatgpt.com/c/target';loc.pathname='/c/target';},300);
   }else{loc.href='https://chatgpt.com/c/target';loc.pathname='/c/target';}
 });
 runInContext(source,context);
 const alert=document.createElement('aside');alert.setAttribute('role','alert');alert.className='text-danger';alert.innerHTML='<div>最大長</div><button>新しいチャット</button>';
 alert.querySelector('button')!.addEventListener('click',()=>{
   assert.ok(stored.text.includes('Earlier answer'),'source copy must be durable');
   loc.href='https://chatgpt.com/';loc.pathname='/';document.querySelector('main')!.innerHTML='';
   document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent='Last request';
 });
 const effort=document.createElement('button');effort.setAttribute('data-composer-navigation-target','reasoning');effort.setAttribute('data-selected-reasoning-effort','max');document.querySelector('[data-app-shell-active-page="true"]')!.append(effort);
 document.querySelector('main')!.append(alert);
 await pause();await pause();await pause();await pause();
 if(temporaryTarget){await pause();await pause();}
 assert.equal(notices.filter(n=>n.type==='CHATGPT_RESPONSE_ERROR').length,ambiguous?2:1,'terminal error must notify immediately');
 assert.equal(sends.length,1,'handoff sends once');assert.notEqual(sends[0],'доделай е2е');
 assert.equal(stored.stage,ambiguous?'failed':'sent');
 assert.ok(stored.text.indexOf('Earlier answer')<stored.text.indexOf('First request'));
 assert.ok(stored.text.indexOf('First request')<stored.text.indexOf('Last request'));
 if(long){const file=(document.querySelector('input')! as any).files[0];assert.equal(await file.text(),stored.text);assert.ok(sends[0].includes(file.name));}
 else assert.equal(sends[0],stored.text);
 if(!ambiguous)assert.equal(document.querySelector('[data-app-shell-active-page="true"] [contenteditable]')!.textContent,'Saved draft\nsecond line');
 if(ambiguous){runInContext(source,context);await pause();assert.equal(sends.length,1,'reinjection must not repeat ambiguous send');}
 console.log(`PASS: ${long?'large file':'inline'} handoff, durable backup before navigation, ${ambiguous?'uncertain send stops':'draft restored'}, one send, immediate error notification`);
 // Invalidate runtime: old observers/listeners must not throw or send anything.
 runtime.sendMessage=()=>{throw new Error('Extension context invalidated.');};
 document.dispatchEvent(new window.Event('pointerdown'));
 await pause();
 const before=sends.length;document.querySelector('main')!.append(document.createElement('span'));await pause();assert.equal(sends.length,before);
}
const rawFunction=source.slice(source.indexOf('  function rawEditorText'),source.indexOf('  function replaceEditorText'));
const rich=parseHTML('<div id="e"><p>URL <span><span aria-hidden="true">icon</span>https://example.com</span></p><p><br class="ProseMirror-trailingBreak"></p><p>Code   spacing</p></div>');
const richContext=createContext({document:rich.document,Node:rich.window.Node});runInContext(rawFunction,richContext);
assert.equal(runInContext("rawEditorText(document.querySelector('#e'))",richContext),'URL https://example.com\n\nCode   spacing');
console.log('PASS: exact draft serialization despite rich URL widgets and paragraph layout');
probeCheck();await transferCheck();await transferCheck(true);await transferCheck(false,true);await transferCheck(false,false,true);await transferCheck(false,false,false,true);
