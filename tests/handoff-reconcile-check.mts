import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

const worker=readFileSync('extension/service-worker.js','utf8');
const stateCode=worker.slice(worker.indexOf('const handoffWrites ='),worker.indexOf('chrome.runtime.onMessage.addListener'));
const listenerCode=worker.slice(worker.indexOf('chrome.runtime.onMessage.addListener'),worker.indexOf('chrome.tabs.onRemoved.addListener'));
const pageCode=readFileSync('extension/page-probe.js','utf8');
const titleCode=readFileSync('extension/handoff-title.js','utf8');
const sourceUrl='https://chatgpt.com/c/source';
const targetUrl='https://chatgpt.com/c/target';
const alias='local-chatgpt:accepted-id';
const payload='Exact handoff payload\nKeep whitespace  unchanged';
type RecordValue=Record<string,any>;

function harness(dropReply=false) {
  const {document,window}=parseHTML('<html><body><section data-app-shell-active-page="true"><header><button>Share</button></header><main></main><form data-composer-body><div id="prompt-textarea" contenteditable="true"></div><button type="submit">Send</button><button type="button" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="max"></button></form></section></body></html>');
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{width:240,height:32}],configurable:true});
  const editor=document.querySelector('[contenteditable]')!;editor.textContent=payload;
  const nativeHeader={conversationId:alias,isReady:true};
  (document.querySelector('header button') as unknown as RecordValue).__reactFiber$test={memoizedProps:nativeHeader,return:null};
  const entries=[{id:'accepted-turn',turn:{items:[] as {type:string;messageId:string;message:string}[]}}];
  const controller={view:{dom:editor},getPlainText:()=>editor.textContent,getChatGptPrompt:()=>({prompt:editor.textContent}),submitReady:true,pendingSubmit:null};
  (document.querySelector('form') as unknown as RecordValue).__reactFiber$test={memoizedProps:{composerController:controller,entries},return:null};
  const location={href:'https://chatgpt.com/'};
  const storage:RecordValue={
    'chatgpt-handoff:7':{id:'handoff',reasoningEffort:'max',stage:'sending',sourceUrl,targetUrl:'https://chatgpt.com/',prompt:payload,text:payload,draft:'Owner draft',naming:{version:1,sourceUrl,baseTitle:'Fixture task',part:1,title:'Fixture task (1)'}},
    meta:{active:{7:{operationId:'handoff',kind:'handoff.sending',at:100000}}}
  };
  const journal:RecordValue[]=[];
  let clicks=0;
  let routeAfterProof='';
  document.querySelector('button[type="submit"]')!.addEventListener('click',()=>{
    clicks++;entries[0].turn.items=[{type:'user-message',messageId:'accepted-user-message',message:payload}];
    editor.textContent='';location.href=`https://chatgpt.com/c/${encodeURIComponent(alias)}`;
  });
  let listener:(message:RecordValue,sender:RecordValue,respond:(result:RecordValue)=>void)=>unknown;
  let context:ReturnType<typeof createContext>;
  function restart() {
    context=createContext({URL,document,location,Date:class extends Date{static now(){return 100000;}},JOURNAL_META:'meta',
      appendJournal:async(event:RecordValue)=>{journal.push(structuredClone(event));storage.meta.active[7]={operationId:event.operationId,kind:event.kind,at:100000};return {ok:true};},
      chrome:{runtime:{onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}},
        storage:{local:{get:async(key:string)=>structuredClone({[key]:storage[key]}),set:async(value:RecordValue)=>{Object.assign(storage,structuredClone(value));}}},
        tabs:{get:async()=>({id:7,url:location.href})},
        scripting:{executeScript:async({func,args}:{func:(...args:any[])=>unknown;args:any[]})=>{
          const result=func(...args);if(dropReply&&func.name==='controlChatComposer')throw new Error('Lost MAIN result');
          if(routeAfterProof&&func.name==='inspectHandoffAcceptance'){location.href=routeAfterProof;routeAfterProof='';}
          return [{result}];
        }}}});
    runInContext(pageCode+'\n'+titleCode+'\n'+readFileSync('extension/goal-policy.js','utf8')+'\n'+
      readFileSync('extension/goal-store.js','utf8')+'\n'+
      'const goalController=ChatGPTGoalStore.create({storage:chrome.storage.local,tabs:chrome.tabs,appendJournal});\n'+
      stateCode+'\n'+listenerCode,context);
  }
  restart();
  function message(value:RecordValue) {
    return new Promise<RecordValue>(resolve=>listener(value,{tab:{id:7,url:location.href},frameId:0},resolve));
  }
  return {document,storage,location,entries,nativeHeader,editor,journal,restart,message,
    navigateAfterProof:(url:string)=>{routeAfterProof=url;},
    send:(extra:RecordValue={})=>message({type:'CHATGPT_COMPOSER_CONTROL',options:{action:'send',url:location.href,text:payload,expectedEffort:'max',operationId:'handoff',...extra}}),
    reconcile:()=>message({type:'CHATGPT_HANDOFF_RECONCILE',id:'handoff'}),
    get clicks(){return clicks;},get record(){return storage['chatgpt-handoff:7'];}};
}

for(const ownEffort of ['medium',null]) {
  const h=harness();
  const own=h.document.querySelector('form [data-selected-reasoning-effort]')!;
  if(ownEffort)own.setAttribute('data-selected-reasoning-effort',ownEffort);else own.remove();
  const unrelated=h.document.createElement('form');
  unrelated.innerHTML='<button type="button" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="max">Other composer Max</button>';
  h.document.querySelector('form')!.before(unrelated);
  const result=await h.send();
  assert.equal(result.ok,false,'another composer Max cannot authorize an editor with '+(ownEffort||'missing')+' effort');
  assert.equal(h.clicks,0,'wrong-form effort must not reach the native send click');
  assert.equal(h.editor.textContent,payload,'refusing wrong-form effort preserves the exact prepared payload');
  assert.equal(h.record.sendReceipt,undefined,'no native send receipt exists for a refused effort check');
}

{
  const h=harness();
  assert.equal((await h.send()).clicked,true);
  assert.equal(h.record.sendReceipt.submittedText,payload,'the worker saves the exact guarded native prompt before replying');
  assert.equal(h.record.sendReceipt.conversationAlias,alias);
  assert.equal((await h.reconcile()).record.stage,'sending','temporary routes cannot acknowledge a completed transfer');
  const unknown=await h.message({type:'CHATGPT_HANDOFF_UPDATE',id:'handoff',stage:'awaiting-confirmation'});
  assert.equal(unknown.notifyAwaiting,true);
  assert.equal((await h.message({type:'CHATGPT_HANDOFF_UPDATE',id:'handoff',stage:'awaiting-confirmation'})).notifyAwaiting,false,'unknown notification is claimed once durably');
  h.restart();h.location.href=targetUrl;
  h.entries[0].turn.items[0].message='Unrelated user message';
  assert.equal((await h.reconcile()).record.stage,'awaiting-confirmation','a different active payload cannot acknowledge this handoff');
  h.entries[0].turn.items[0].message=payload;h.nativeHeader.conversationId='local-chatgpt:other-id';
  assert.equal((await h.reconcile()).record.stage,'awaiting-confirmation','a conflicting known native alias fails closed');
  h.nativeHeader.conversationId='unrelated-server-id';
  assert.equal((await h.reconcile()).record.stage,'awaiting-confirmation','native server identity must match the currently displayed destination');
  h.nativeHeader.conversationId=alias;
  h.navigateAfterProof('https://chatgpt.com/c/other');
  assert.equal((await h.reconcile()).record.stage,'awaiting-confirmation','navigation during the MAIN acknowledgement cannot commit a stale destination');
  h.location.href=targetUrl;
  assert.equal((await h.reconcile()).record.stage,'sent','durable native receipt and exact accepted message survive worker restart');
  assert.equal(h.record.acceptance.messageId,'accepted-user-message');
  assert.equal(h.storage[`chatgpt-handoff-title:${targetUrl}`].part,1);
  assert.equal(h.storage[`chatgpt-handoff-title:${targetUrl}`].transferred,true);
  assert.equal((await h.send()).ok,false);assert.equal(h.clicks,1,'reconciliation cannot reauthorize the old send');
  const claim=await h.message({type:'CHATGPT_HANDOFF_DRAFT_CLAIM',id:'handoff'});assert.equal(claim.claimed,true);
  h.restart();assert.equal((await h.message({type:'CHATGPT_HANDOFF_DRAFT_CLAIM',id:'handoff'})).claimed,false,'draft restoration cannot replay after restart');
  assert.equal(h.record.draft,'Owner draft','the durable draft backup remains available');
}
{
  const h=harness(true);
  const result=await h.send();assert.equal(result.ok,false);assert.equal(result.unknown,true,'lost MAIN reply is an unknown outcome after dispatch');
  assert.equal(h.clicks,1);assert.equal(h.record.sendReceipt,undefined);
  h.location.href=targetUrl;h.restart();
  assert.equal((await h.reconcile()).record.stage,'sending','native text alone cannot invent a missing guarded click receipt');
  assert.equal((await h.send()).ok,false);assert.equal(h.clicks,1);
}
console.log('PASS: own-composer Max enforcement, durable exact native click receipt, late permanent-route reconciliation, wrong payload/alias refusal, worker restart, no resend, one draft claim, unknown reply preservation');

{const h=harness();assert.equal((await h.send({expectedEffort:'medium'})).ok,false);assert.equal(h.clicks,0);assert.equal((await h.send({expectedEffort:undefined})).ok,false);assert.equal(h.clicks,0);assert.equal((await h.send()).clicked,true,'only the durably saved effort authorizes the handoff');}
