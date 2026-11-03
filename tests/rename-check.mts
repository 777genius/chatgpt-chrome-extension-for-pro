import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';

type Request = { tabId: number; method: string; url: string; requestId: string; requestBody: {raw: {bytes: ArrayBuffer}[]} };
type Completion = { tabId: number; url: string; requestId: string; statusCode: number };
type ProbeOptions = { action: string; url: string; operationId: string; title: string; previousTitle?: string };
type Result = {ok: boolean; reason?: string; clicked?: boolean; ready?: boolean; streaming?:boolean; title?: string; conversationId?: string};
type Stored = {id: string; stage: string; sourceUrl: string; targetUrl: string; sentAt: number; naming: unknown; titleStatus?: string; titleReason?: string; previousTitle?: string; titleSaveStartedAt?: number; titlePreviousTargetUrl?: string; titleTargetAlias?: string; titleRetryable?:boolean;titleRetryAfter?:number;titlePrepareAttempts?:number;titlePreparationVersion?:number;titlePreparationTitle?:string};
type Mode = 'success' | 'no-ack' | 'failed-ack' | 'wrong-request' | 'wrong-path' | 'split-utf8' | 'wrong-cache' | 'missing-cache' | 'error-cache' | 'unsaved' | 'navigate' | 'deadline' | 'optimistic' | 'temporary-to-server' | 'wrong-alias' | 'query-normalization' | 'plural' | 'plural-post' | 'plural-wrong-id' | 'plural-wrong-title' | 'plural-failed-ack' | 'plural-get' | 'plural-wrong-tab' | 'native' | 'native-wrong-id' | 'native-wrong-title' | 'native-patch' | 'native-failed-ack' | 'native-wrong-tab' | 'streaming' | 'late-menu';
const sourceUrl = 'https://chatgpt.com/c/source';
const targetUrl = 'https://chatgpt.com/c/target';
const temporaryUrl='https://chatgpt.com/c/local-chatgpt%3Alocal-target-id';
const expectedTitle = 'Original (1)';
const evidence = JSON.parse(readFileSync('tests/fixtures/title-header.json','utf8')) as {title:string;header:string};
const menuEvidence = JSON.parse(readFileSync('tests/fixtures/title-menu.json','utf8')) as {html:string}[];
const dialogEvidence = JSON.parse(readFileSync('tests/fixtures/title-dialog.json','utf8')) as {html:string};
const scripts = ['handoff-title.js','chat-title-probe.js','handoff-renamer.js'].map(name => readFileSync(`extension/${name}`,'utf8'));

function harness(mode: Mode = 'success') {
  const {document,window} = parseHTML(`<html><head><title>${evidence.title}</title></head><body>${evidence.header}<main><form data-composer-body><div contenteditable="true">Owner draft\nKeep this exact</div><button type="submit">Send</button></form></main></body></html>`);
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value(){return this.hidden ? [] : [{width:240,height:32}];},configurable:true});
  let time = 100;
  const location = {href:mode==='temporary-to-server'?temporaryUrl:mode==='query-normalization'?`${targetUrl}/?model=pro#latest`:targetUrl};
  const events: Record<string,unknown>[] = [];
  const storage: Record<string,unknown> = {};
  const storageWrites: Record<string,unknown>[] = [];
  let opened = 0, selected = 0, saved = 0, sent = 0;
  let clickAt = 0;
  let menuReady=mode!=='late-menu';
  const sourceTitle=mode==='split-utf8'?'Задача 🦊':'Original';
  const before: ((value: Request)=>void)[] = [], complete: ((value: Completion)=>void)[] = [];
  const failure: ((value: unknown)=>void)[] = [];
  const share = Array.from(document.querySelectorAll('header button')).find(n=>n.textContent?.includes('Поделиться')) as unknown as Record<string,unknown>;
  const readiness = {conversationId:mode==='wrong-alias'?'local-chatgpt:other-local-id':'local-chatgpt:local-target-id',isReady:mode!=='unsaved',isStreaming:mode==='streaming'};
  if(mode==='streaming')(share as unknown as HTMLButtonElement).disabled=true;
  share.__reactFiber$test = {memoizedProps:readiness,return:null};
  const cachedQuery={queryKey:['chatgpt-conversation','target'],state:{status:mode==='error-cache'?'error':'success',data:mode==='error-cache'?undefined:{conversation_id:mode==='wrong-cache'?'other-chat':'target'}}};
  (document.querySelector('[data-composer-body]')! as unknown as Record<string,unknown>).__reactFiber$test={
    memoizedProps:{queryClient:{getQueryCache:()=>({getAll:()=>mode==='missing-cache'?[]:[cachedQuery]})}},return:null
  };
  const actions = Array.from(document.querySelectorAll('header button[aria-haspopup="menu"]')).find(n=>n.querySelector('use[href*="ellipsis-horizontal"]'))!;
  actions.addEventListener('click',()=>{
    opened++;
    actions.setAttribute('data-state','open');
    if (mode==='navigate') location.href='https://chatgpt.com/c/other';
    const menu=document.createElement('div');menu.setAttribute('role','menu');menu.setAttribute('aria-labelledby',actions.id);
    menu.innerHTML=menuReady?menuEvidence[0].html:'<div role="menuitem">Unrelated action</div>';
    menu.addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Escape'){menu.remove();actions.setAttribute('data-state','closed');}});
    // Linkedom splits semicolons inside a quoted SVG data URL; browsers expose
    // the complete maskImage string from this captured style attribute.
    for(const icon of menu.querySelectorAll('[style]')) {
      const mask=icon.getAttribute('style')!.match(/mask-image:\s*(.*?);\s*mask-position/s)?.[1]||'';
      Object.defineProperty(icon,'style',{value:{maskImage:mask},configurable:true});
    }
    menu.querySelector('[role="menuitem"]')!.addEventListener('click',()=>{
      selected++;
      const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.innerHTML=dialogEvidence.html;document.body.append(dialog);
      // Native modal temporarily makes the header inert; the stored operation
      // must still permit fill/save without reauthorizing through that header.
      document.querySelector('header')!.setAttribute('inert','');
      const input=dialog.querySelector('input')!;
      input.value=document.title;
      (input as unknown as Record<string,unknown>).__reactProps$test={value:input.value};
      input.addEventListener('input',()=>{(input as unknown as Record<string,unknown>).__reactProps$test={value:input.value};});
      dialog.querySelector('button[type="button"]')!.addEventListener('click',()=>{dialog.remove();document.querySelector('header')!.removeAttribute('inert');});
      dialog.querySelector('button[type="submit"]')!.addEventListener('click',()=>{
        saved++;clickAt=time;
        if(mode!=='optimistic') document.title=input.value;
        document.querySelector('header')!.removeAttribute('inert');
        if(mode==='no-ack')return;
        const payload=new TextEncoder().encode(JSON.stringify({title:mode==='wrong-request'||mode.endsWith('-wrong-title')?'Other':input.value}));
        const split=mode==='split-utf8'?payload.findIndex(byte=>byte>=128)+1:0;
        const raw=split?[{bytes:payload.slice(0,split).buffer as ArrayBuffer},{bytes:payload.slice(split).buffer as ArrayBuffer}]:[{bytes:payload.buffer as ArrayBuffer}];
        const path=mode==='wrong-path'?'share':mode.startsWith('plural')?'conversations':'conversation';
        const id=mode.endsWith('-wrong-id')?'unrelated':'target';
        const pathname=mode.startsWith('native')?`conversation/id/${id}/rename`:`${path}/${id}`;
        const request:Request={tabId:mode.endsWith('-wrong-tab')?8:7,method:mode==='native-patch'?'PATCH':mode.startsWith('native')||mode==='plural-post'?'POST':mode==='plural-get'?'GET':'PATCH',url:`https://chatgpt.com/backend-api/${pathname}`,requestId:'rename-1',requestBody:{raw}};
        before.forEach(fn=>fn(request));
        complete.forEach(fn=>fn({tabId:7,url:request.url,requestId:request.requestId,statusCode:mode==='failed-ack'||mode.endsWith('-failed-ack')?503:200}));
      });
    });
    document.body.append(menu);
  });
  document.querySelector('main button')!.addEventListener('click',()=>sent++);
  const ctx=createContext({URL,TextDecoder,document,location,PointerEvent:window.Event,Event:window.Event,KeyboardEvent:class extends window.Event{constructor(type:string,options:{key:string}){super(type);Object.defineProperty(this,'key',{value:options.key});}},HTMLInputElement:window.HTMLInputElement,
    Date:class extends Date{static now(){return time;}},setTimeout:(fn:()=>void,ms:number)=>{time+=ms;if(mode==='temporary-to-server'&&time>=10100)location.href=targetUrl;queueMicrotask(fn);},
    handoffKey:(id:number)=>`handoff:${id}`,
    journalChatId:(url:string)=>new URL(url).pathname.split('/').at(-1),
    appendJournal:async(event:Record<string,unknown>)=>events.push(structuredClone(event)),
    journalInBackground:(event:Record<string,unknown>)=>events.push(structuredClone(event)),
    chrome:{
      storage:{local:{get:async(key:string)=>structuredClone({[key]:storage[key]}),set:async(value:Record<string,unknown>)=>{storageWrites.push(structuredClone(value));Object.assign(storage,structuredClone(value));}}},
      tabs:{get:async()=>({id:7,url:location.href})},
      webRequest:{onBeforeRequest:{addListener:(fn:(r:Request)=>void)=>before.push(fn)},onCompleted:{addListener:(fn:(r:Completion)=>void)=>complete.push(fn)},onErrorOccurred:{addListener:(fn:(r:unknown)=>void)=>failure.push(fn)}},
      scripting:{executeScript:async({func,args}:{func:(o:ProbeOptions)=>Result;args:[ProbeOptions]})=>{
        if(mode==='deadline') {
          readiness.isReady=time>=69100;
          if(args[0].action!=='inspect')time+=250;
        }
        return [{result:func(args[0])}];
      }}
    }});
  scripts.forEach(source=>runInContext(source,ctx));
  ctx.sourceTitle=sourceTitle;
  const naming=runInContext('ChatGPTHandoffTitle.planNext({sourceUrl:"https://chatgpt.com/c/source",sourceTitle})',ctx) as unknown;
  storage['handoff:7']={id:'handoff',stage:'sent',sourceUrl,targetUrl:mode==='temporary-to-server'?temporaryUrl:targetUrl,sentAt:100,naming} satisfies Stored;
  const rename = (options?:{recoverTemporaryTarget?:boolean})=>{ctx.renameOptions=options;return runInContext('renameSavedHandoff(7,"handoff",renameOptions)',ctx) as Promise<Result>;};
  const probe = (options:ProbeOptions)=>{ctx.options=options;return runInContext('controlChatTitle(options)',ctx) as Result;};
  return {rename,probe,events,storage,storageWrites,document,location,
    advance(ms:number){time+=ms;},allowReady(){readiness.isReady=true;readiness.isStreaming=false;(share as unknown as HTMLButtonElement).disabled=false;},allowMenu(){menuReady=true;},
    get record(){return storage['handoff:7'] as Stored;},get time(){return time;},get opened(){return opened;},get selected(){return selected;},get saved(){return saved;},get sent(){return sent;},get clickAt(){return clickAt;}};
}

{
  const h=harness();
  const first=h.rename(), duplicate=h.rename();
  assert.equal(first,duplicate,'concurrent calls share one exact rename operation');
  const result=await first;
  assert.equal(result.ok,true,result.reason||'rename must succeed');
  assert.equal(h.record.titleStatus,'confirmed');
  assert.equal(h.document.title,expectedTitle);
  assert.equal(h.opened,1);assert.equal(h.selected,1);assert.equal(h.saved,1);
  assert.ok(h.clickAt>=10100,'native save waits at least ten seconds from confirmed handoff send');
  assert.equal(h.document.querySelector('[contenteditable]')!.textContent,'Owner draft\nKeep this exact');
  assert.equal(h.sent,0,'rename must never submit the composer');
  assert.equal((h.storage[`chatgpt-handoff-title:${targetUrl}`] as {title:string}).title,expectedTitle);
  assert.equal((await h.rename()).ok,true);assert.equal(h.saved,1,'confirmed intent is not replayed');
}
for(const mode of ['no-ack','wrong-request','wrong-path','failed-ack','optimistic','plural-wrong-id','plural-wrong-title','plural-failed-ack','plural-get','plural-wrong-tab','native-wrong-id','native-wrong-title','native-patch','native-failed-ack','native-wrong-tab'] as const){
  const h=harness(mode);
  const result=await h.rename();
  assert.equal(result.ok,false,`${mode} cannot confirm title persistence`);
  assert.equal(h.record.titleStatus,'failed');
  assert.equal(h.storage[`chatgpt-handoff-title:${targetUrl}`],undefined);
  assert.equal(h.saved,1,'uncertain save is not clicked again');
  if(mode.endsWith('-wrong-id')||mode.endsWith('-wrong-title')||mode.endsWith('-wrong-tab')||mode==='plural-get'||mode==='native-patch') {
    assert.equal(h.events.filter(event=>event.kind==='handoff.title_request').length,0,'unrelated requests never become title acknowledgement evidence');
    assert.equal(h.events.filter(event=>event.kind==='handoff.title_response').length,0);
  }
  await h.rename();assert.equal(h.saved,1,'failure record prevents repeat mutation');
}
for(const mode of ['plural','plural-post','native'] as const) {
  const h=harness(mode);
  const result=await h.rename();
  assert.equal(result.ok,true,result.reason||'exact conversation rename endpoint must confirm the saved title');
  assert.equal(h.record.titleStatus,'confirmed');
  assert.equal(h.saved,1);
  assert.equal(h.events.filter(event=>event.kind==='handoff.title_request').length,1);
  assert.equal(h.events.filter(event=>event.kind==='handoff.title_response').length,1);
  await h.rename();assert.equal(h.saved,1,'confirmed rename request must never authorize a second save');
}
{
  const h=harness('unsaved');
  const result=await h.rename();assert.equal(result.ok,true);assert.equal(h.record.titleStatus,'waiting');assert.equal(h.record.titleRetryable,true);assert.equal(h.saved,0);assert.equal(h.opened,0);
  assert.ok(h.time<=71100,'readiness timeout has a bounded total duration');
}
{
  const h=harness('wrong-cache');
  assert.equal((await h.rename()).ok,true);assert.equal(h.record.titleStatus,'waiting');
  assert.equal(h.opened,0,'local header identity cannot authorize a different canonical server chat');
  assert.equal(h.saved,0);
}
for(const mode of ['missing-cache','error-cache'] as const) {
  const h=harness(mode);
  const result=await h.rename();
  assert.equal(result.ok,true,result.reason||'native ready chat may have an unfetched or failed GET cache');
  assert.equal(h.record.titleStatus,'confirmed');
  assert.equal(h.saved,1);
}
{
  const h=harness('split-utf8');
  const result=await h.rename();
  assert.equal(result.ok,true,result.reason||'split UTF8 title request must be decoded once');
  assert.equal(h.document.title,'Задача 🦊 (1)');
  assert.equal(h.record.titleStatus,'confirmed');
  assert.equal(h.saved,1);
}
{
  const h=harness('navigate');
  assert.equal((await h.rename()).ok,false);assert.equal(h.selected,0);assert.equal(h.saved,0);
}
{
  const h=harness('temporary-to-server');
  const result=await h.rename();
  assert.equal(result.ok,true,result.reason||'temporary alias must bind to its canonical destination');
  assert.equal(h.record.targetUrl,targetUrl,'legacy temporary destination binds only to the server route');
  assert.equal(h.record.titlePreviousTargetUrl,temporaryUrl,'the original temporary destination remains in durable evidence');
  assert.equal(h.record.titleTargetAlias,'local-chatgpt:local-target-id');
  assert.equal(h.saved,1);
  assert.ok(h.events.some(event=>event.kind==='handoff.title_waiting'&&event.titlePreviousTargetUrl===temporaryUrl&&event.targetUrl===targetUrl));
  assert.equal((h.storage[`chatgpt-handoff-title:${targetUrl}`] as {targetUrl:string}).targetUrl,targetUrl);
}
{
  const h=harness('wrong-alias');
  h.record.targetUrl=temporaryUrl;
  const snapshot=h.probe({action:'inspect',url:targetUrl,operationId:'handoff',title:expectedTitle});
  assert.equal(snapshot.conversationId,'local-chatgpt:other-local-id','inspect exposes the exact native alias');
  assert.equal((await h.rename()).ok,false);
  assert.equal(h.record.targetUrl,temporaryUrl);assert.equal(h.opened,0);assert.equal(h.saved,0);
}
{
  const h=harness('navigate');h.record.targetUrl=temporaryUrl;
  const oldLineage={baseTitle:'Original',part:1,targetUrl:temporaryUrl,transferred:true,confirmed:false};
  h.storage[`chatgpt-handoff-title:${temporaryUrl}`]=oldLineage;
  assert.equal((await h.rename()).ok,false);
  assert.equal(h.saved,0);assert.equal(h.record.targetUrl,targetUrl);
  const lineage=h.storage[`chatgpt-handoff-title:${targetUrl}`] as {part:number;title:string;targetUrl:string;transferred:boolean;confirmed:boolean};
  assert.equal(lineage.part,1);assert.equal(lineage.title,expectedTitle);
  assert.equal(lineage.targetUrl,targetUrl);assert.equal(lineage.transferred,true);assert.equal(lineage.confirmed,false);
  assert.deepEqual(h.storage[`chatgpt-handoff-title:${temporaryUrl}`],oldLineage,'rebinding retains the old lineage recovery copy');
  assert.ok(h.storageWrites.some(write=>(write['handoff:7'] as Stored)?.targetUrl===targetUrl&&
    (write[`chatgpt-handoff-title:${targetUrl}`] as {transferred?:boolean})?.transferred===true),
    'canonical handoff and transfer lineage must persist in one storage write before rename effects');
}
{
  const h=harness();h.location.href='https://chatgpt.com/c/unrelated';
  assert.equal((await h.rename()).ok,false);
  assert.equal(h.opened,0);assert.equal(h.saved,0,'a genuinely different chat is never renamed');
}
{
  const h=harness('query-normalization');
  h.record.targetUrl=`${targetUrl}/?model=pro#earlier`;
  const result=await h.rename();
  assert.equal(result.ok,true,result.reason||'normalized destination must keep the same chat binding');
  assert.equal(h.saved,1,'query, trailing slash and hash changes preserve the exact chat binding');
}
{
  const h=harness();
  h.record.targetUrl=temporaryUrl;h.record.titleStatus='failed';
  h.record.titleReason='Открыт другой чат; переименование отменено';
  h.document.title='Owner renamed this chat';
  assert.equal((await h.rename()).ok,true);
  assert.equal(h.record.titleStatus,'failed');assert.equal(h.saved,0,'historical failed jobs require explicitly selected recovery');
}
{
  const h=harness();
  h.record.targetUrl=temporaryUrl;h.record.titleStatus='failed';
  h.record.titleReason='Открыт другой чат; переименование отменено';
  assert.equal((await h.rename({recoverTemporaryTarget:true})).ok,true);
  assert.equal(h.record.titleStatus,'confirmed');assert.equal(h.record.targetUrl,targetUrl);assert.equal(h.saved,1);
}
for(const status of ['saving','failed']) {
  const h=harness();
  h.record.targetUrl=temporaryUrl;h.record.titleStatus=status;
  h.record.titleReason='Открыт другой чат; переименование отменено';
  h.record.previousTitle=evidence.title;
  const original=JSON.stringify(h.record);
  await h.rename({recoverTemporaryTarget:true});
  assert.equal(JSON.stringify(h.record),original,'a prior durable save intent preserves its unknown outcome');
  assert.equal(h.opened,0);assert.equal(h.saved,0);
}
{
  const h=harness();h.record.targetUrl=temporaryUrl;h.document.title=expectedTitle;
  assert.equal((await h.rename()).ok,false);
  assert.equal(h.saved,0,'an already assigned title without a server acknowledgement is never saved again');
}
{
  const h=harness();
  h.location.href='https://chatgpt.com/c/unrelated';
  const result=h.probe({action:'save',url:targetUrl,operationId:'handoff',title:expectedTitle,previousTitle:evidence.title});
  assert.equal(result.ok,false);assert.equal(result.reason,'chat-changed');assert.equal(h.saved,0);
}
{
  const h=harness();h.location.href=temporaryUrl;
  const result=h.probe({action:'open',url:temporaryUrl,operationId:'handoff',title:expectedTitle,previousTitle:evidence.title});
  assert.equal(result.ok,false);assert.equal(result.reason,'chat-changed');assert.equal(h.opened,0,'MAIN cannot authorize rename on a temporary route');
}
{
  const h=harness();h.record.titleStatus='saving';
  assert.equal((await h.rename()).ok,false);assert.equal(h.opened,0);assert.equal(h.saved,0);
}
{
  const h=harness('deadline');
  assert.equal((await h.rename()).ok,true);assert.equal(h.record.titleStatus,'waiting');
  assert.equal(h.saved,0,'late readiness must not allow save after the operation deadline');
}
for(const mode of ['streaming','late-menu'] as const) {
  const h=harness(mode);
  const result=await h.rename();
  assert.equal(result.ok,true);assert.equal(h.record.titleStatus,'waiting');assert.equal(h.record.titleRetryable,true);
  assert.equal(h.saved,0);assert.equal(h.record.titlePrepareAttempts,mode==='streaming'?0:1);assert.equal(h.record.titlePreparationTitle,mode==='streaming'?undefined:evidence.title);
  if(mode==='streaming')assert.equal(h.opened,0,'isReady alone cannot open the disabled streaming control');
  const actionsBefore=h.opened;
  await h.rename();assert.equal(h.opened,actionsBefore,'a repeated event before the retry fence does no page effects');
  if(mode==='streaming')for(let i=0;i<4;i++)await h.rename();
  if(mode==='streaming')h.document.title='Generated title after the first response';
  h.allowReady();h.allowMenu();if(mode!=='streaming')h.advance(10000);
  assert.equal((await h.rename()).ok,true);assert.equal(h.record.titleStatus,'confirmed');
  assert.equal(h.document.title,expectedTitle);assert.equal(h.saved,1,'later native readiness authorizes exactly one title save');
  assert.equal(h.record.titlePrepareAttempts,mode==='streaming'?1:2);
  await h.rename();assert.equal(h.saved,1);
}
{
  const h=harness('late-menu');await h.rename();
  const opened=h.opened;
  h.document.title='Owner changed this title';h.allowReady();h.advance(10000);
  assert.equal((await h.rename()).ok,false);assert.equal(h.saved,0);assert.equal(h.opened,opened,'a later manual or server title change cannot be silently overwritten');
  assert.equal(h.record.titleStatus,'failed');
}
{
  const h=harness('unsaved');
  h.record.naming={version:1,sourceUrl,baseTitle:'Original chain',part:3,title:'Original chain (3)'};
  await h.rename();assert.equal(h.record.titlePreparationTitle,undefined,'a not-ready server title is not a valid preparation snapshot');
  h.document.title='Generated while server was unavailable';h.allowReady();h.advance(10000);await h.rename();
  assert.equal(h.document.title,'Original chain (3)','deferred readiness preserves the persisted original base and continuation number');
  assert.equal(h.saved,1);
}
{
  const h=harness('unsaved');
  for(let i=0;i<3;i++){await h.rename();h.advance(10000);}
  assert.equal(h.record.titlePrepareAttempts,3);assert.equal(h.record.titleRetryable,false);
  h.allowReady();const before=h.time;
  await h.rename();assert.equal(h.time,before);assert.equal(h.opened,0);assert.equal(h.saved,0,'exhausted preparation never starts an unbounded background job');
}
{
  const h=harness('no-ack');await h.rename();
  assert.ok(h.record.titleSaveStartedAt);assert.equal(h.saved,1);
  h.record.titleStatus='waiting';h.record.titleRetryable=true;
  await h.rename();assert.equal(h.saved,1,'a prior durable save intent still blocks every waiting-state retry');
}
{
  const h=harness();
  const foreign=h.document.createElement('section');foreign.setAttribute('role','dialog');foreign.setAttribute('aria-modal','true');
  foreign.innerHTML='<form><input value="Owner text"><button type="submit">Submit</button></form>';h.document.body.append(foreign);
  const result=h.probe({action:'open',url:targetUrl,operationId:'handoff',title:expectedTitle,previousTitle:evidence.title});
  assert.equal(result.ok,false);assert.equal(h.opened,0,'existing owner modal must not be opened over');
  assert.equal(foreign.querySelector('input')!.value,'Owner text');
}
{
  const h=harness();
  const options={url:targetUrl,operationId:'handoff',title:expectedTitle,previousTitle:evidence.title};
  for(const action of ['open','select','fill'])assert.equal(h.probe({...options,action}).ok,true);
  const input=h.document.querySelector('[role="dialog"] input')! as HTMLInputElement;
  input.value='Owner edited title';
  assert.equal(h.probe({...options,action:'save'}).ok,false);
  assert.equal(h.saved,0,'a title manually edited after fill must never be submitted');
  h.probe({...options,action:'cancel'});
  assert.equal(input.value,'Owner edited title','cleanup must preserve owner changes');
  assert.equal(input.isConnected,true,'cleanup must keep an owner-edited dialog open');
}
console.log('PASS: observed native rename DOM, local/canonical chat binding, inert modal, split UTF8/exact endpoint ack, no draft send, one save, bounded timeout');
