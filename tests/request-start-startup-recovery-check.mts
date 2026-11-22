import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const worker=readFileSync('extension/service-worker.js','utf8');
const startup=worker.slice(worker.indexOf('let journalStartupRecovery='),worker.indexOf('const goalController='));
const from=worker.includes('const PENDING_REQUEST_STARTS=')?worker.indexOf('const PENDING_REQUEST_STARTS='):worker.indexOf('async function signalConversationRequestEvent(');
const signal=worker.slice(from,worker.indexOf('// Activate DOM error observation',from));
type V=Record<string,any>;
const key='chatgpt-pending-request-start-signals';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const url='https://chatgpt.com/c/startup-request-fixture';
async function fixture(data:V={},initiallyReady=false,options:V={}) {
 let ready=initiallyReady,available=true,timerId=0,initializations=0,attachments=0,live=options.url||url,goal:V|null=options.goal||null;
 let getFailures=options.getFailures||0,setFailures=options.setFailures||0,staleReply=options.staleReplay===true,localFailures=0;
 const checkpoint:V={state:'active',url,requestId:'manual-request',startedAt:100001,...options.checkpoint};
 const request:V={tabId:7,url,requestId:'manual-request',startedAt:100001,...options.receipt};
 let journal:V=options.journal||{ok:true,meta:{sequence:0},events:[]};
 const messages:V[]=[],timers=new Map<number,()=>void>();
 const context=createContext({URL,Promise,console:{warn:()=>{}},readJournal:async()=>{await options.onJournal?.({route:(value:string)=>{live=value;},goal:(value:V)=>{goal=value;},checkpoint:(value:V)=>Object.assign(checkpoint,value),receipt:(value:V)=>Object.assign(request,value)});return structuredClone(journal);},completionCheckpointRead:async()=>structuredClone(checkpoint),latestRequestReceipt:async()=>structuredClone(request),
  recoverProvisionalGoalCAS:async()=>{if(!ready)throw Error('Startup recovery unavailable');},initializeJournal:async()=>{initializations++;},
  setTimeout:(fn:()=>void)=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:(id:number)=>timers.delete(id),
  chrome:{storage:{session:{get:async(k:string)=>{if(getFailures-->0)throw Error('Transient pending read');return {[k]:structuredClone(data[k])};},set:async(v:V)=>{if(setFailures-->0)throw Error('Transient pending write');return Object.assign(data,structuredClone(v));}},local:{get:async(k:string)=>{if(localFailures-->0)throw Error('Transient replay recheck');return {[k]:structuredClone(goal)};}}},
   tabs:{get:async()=>({id:7,url:live}),sendMessage:async(tabId:number,message:V)=>{if(!available)throw Error('Page not ready');if(staleReply){if(options.failRefusalRecheck)localFailures=1;options.afterRefusal?.({route:(value:string)=>{live=value;},goal:(value:V)=>{goal=value;},checkpoint:(value:V)=>Object.assign(checkpoint,value),receipt:(value:V)=>Object.assign(request,value)});return {ok:false,reason:'stale-replay-binding'};}messages.push({tabId,message:structuredClone(message)});await options.onDelivery?.(message);}},
   scripting:{executeScript:async()=>{attachments++;if(!available)throw Error('Page not ready');}}}});
 runInContext(readFileSync('extension/handoff-title.js','utf8'),context);
 runInContext(startup+signal,context);await tick();
 return {data,messages,timers,context,get attachments(){return attachments;},get initializations(){return initializations;},
  refuseReplay:(value:boolean)=>{staleReply=value;},ready:()=>{ready=true;},available:(value:boolean)=>{available=value;},route:(value:string)=>{live=value;},goal:(value:V)=>{goal=value;},
  journal:(value:V)=>{journal=value;},checkpoint:(value:V)=>Object.assign(checkpoint,value),receipt:(value:V)=>Object.assign(request,value),failGet:()=>{getFailures=1;},failSet:()=>{setFailures=1;},
  signal:async(message:V,tabId=7)=>{context.input={tabId,message};await runInContext('signalConversationRequestEvent(input.tabId,input.message)',context);await tick();},
  retry:async()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}for(let i=0;i<4;i++)await tick();}};
}
const start={type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:100001,requestId:'manual-request'};
const expectedStart={...start,replayBinding:{sourceUrl:url,targetUrl:url,requestId:start.requestId,startedAt:start.startedAt}};
{
 const h=await fixture();await h.signal(start);await h.signal(start);
 assert.equal(h.messages.length,0,'startup failure prevents observation delivery');assert.equal(h.attachments,0,'startup failure cannot inject content scripts');
 assert.equal((h.data[key]||[]).length,1,'the exact undelivered start survives startup failure without duplicate queue entries');
 assert.ok(h.timers.size,'failed startup schedules delivery recovery');
 h.ready();await h.retry();assert.deepEqual(h.messages,[{tabId:7,message:expectedStart}]);
 assert.equal(h.data[key].length,0,'only the acknowledged observation is retired');
 assert.equal(h.timers.size,0,'completed observation recovery clears obsolete retries');
 await h.signal({type:'CHATGPT_CONVERSATION_REQUEST_COMPLETED',startedAt:start.startedAt,requestId:start.requestId});
 assert.equal(h.messages[1].message.type,'CHATGPT_CONVERSATION_REQUEST_COMPLETED');
 assert.equal(h.initializations,1,'successful startup is not repeated for later signals');
}
{
 const original=await fixture();await original.signal(start);
 const restarted=await fixture(original.data,true);for(let i=0;i<4;i++)await tick();
 assert.deepEqual(restarted.messages,[{tabId:7,message:expectedStart}],'a new worker delivers the same captured start after recovery');
 assert.equal(restarted.data[key].length,0);
}
{
 const h=await fixture({},true);h.available(false);await h.signal(start);
 assert.equal(h.messages.length,0);assert.equal(h.data[key].length,1,'failed page delivery preserves the exact start');
 h.available(true);await h.retry();assert.deepEqual(h.messages,[{tabId:7,message:expectedStart}]);
 assert.equal(h.data[key].length,0);
}
console.log('Request-start startup recovery: durable exact observation, retry/restart recovery, no early page effects and bounded duplicate delivery.');

{
 const h=await fixture();await h.signal(start);
 await runInContext('forgetPendingRequestStarts(7)',h.context);
 assert.equal(h.data[key].length,0,'a closed tab has no surviving content intent to confirm');
 assert.equal(h.timers.size,0,'closing the last pending tab removes its obsolete retry timer');
 h.ready();await h.retry();assert.equal(h.messages.length,0);
}

for(const scenario of ['route','Stop','new-request','terminal','root-route']) {
 const h=await fixture();await h.signal(start);
 assert.equal(h.data[key][0].sourceUrl,url,'replay retains the source captured for the exact request');
 if(scenario==='route')h.route('https://chatgpt.com/c/different-fixture');
 if(scenario==='Stop')h.goal({phase:'stopped',stopRequested:true});
 if(scenario==='new-request'){h.receipt({requestId:'later',startedAt:100002});h.checkpoint({requestId:'later',startedAt:100002});}
 if(scenario==='terminal')h.checkpoint({state:'completed'});
 if(scenario==='root-route')h.route('https://chatgpt.com/');
 h.ready();await h.retry();assert.equal(h.messages.length,0,scenario+' retires without page delivery');
 assert.equal(h.attachments,0);assert.equal(h.data[key].length,0);
}
for(const scenario of ['route','Stop','new-request','terminal']) {
 const original=await fixture();await original.signal(start);
 const options:V={};
 if(scenario==='route')options.url='https://chatgpt.com/c/different-fixture';
 if(scenario==='Stop')options.goal={phase:'stopped'};
 if(scenario==='new-request')options.receipt={requestId:'later',startedAt:100002};
 if(scenario==='terminal')options.checkpoint={state:'completed'};
 const restarted=await fixture(original.data,true,options);for(let i=0;i<4;i++)await tick();
 assert.equal(restarted.messages.length,0,'restart revalidates '+scenario);assert.equal(restarted.data[key].length,0);
}
{
 const h=await fixture({},true);await h.signal({...start,sourceUrl:'https://chatgpt.com/'});
 assert.equal(h.messages.length,0,'root allocation alone does not authorize a saved-chat replay');
 assert.equal(h.attachments,0);
 const legacy=await fixture({[key]:[{tabId:7,sourceUrl:'https://chatgpt.com/',message:start}]},true);
 for(let i=0;i<4;i++)await tick();assert.equal(legacy.messages.length,0);assert.equal(legacy.data[key].length,1,'root observations stay durable until allocation can be proven');
}
for(const failure of ['get','set']) {
 const h=await fixture({},true);if(failure==='get')h.failGet();else h.failSet();
 await h.signal(start);assert.equal(h.messages.length,0);assert.ok(h.timers.size,'first pending '+failure+' failure schedules retry');
 await h.retry();assert.deepEqual(h.messages,[{tabId:7,message:expectedStart}]);assert.equal(h.data[key].length,0);
}
{
 const original=await fixture();await original.signal(start);
 const h=await fixture(original.data,true,{getFailures:1});assert.equal(h.messages.length,0);assert.ok(h.timers.size);
 await h.retry();assert.deepEqual(h.messages,[{tabId:7,message:expectedStart}],'durable observations recover after a transient startup queue read failure');
}
{
 const h=await fixture({},true,{getFailures:1});assert.ok(h.timers.size);
 await h.retry();assert.equal(h.timers.size,0);assert.equal(h.initializations,0,'empty queue recovery never starts or blocks journal startup');
 const failed=await fixture({},true,{getFailures:100});for(let i=0;i<5;i++)await failed.retry();
 assert.equal(failed.timers.size,0,'persistent metadata failure has a finite retry budget');assert.equal(failed.initializations,0);
}

// A Stop fences the request it preceded, not a distinct manual send
// observed afterwards in the same chat.
for(const [stopAt,expected] of [[100000,true],[100001,false],[100002,false]] as const) {
 const h=await fixture({},true,{goal:{id:'stopped-goal',phase:'stopped',stoppedAt:stopAt}});
 await h.signal(start);
 assert.equal(h.messages.length,expected?1:0,'Stop timestamp must distinguish a later manual request from its replay');
 if(expected)assert.deepEqual(h.messages[0],{tabId:7,message:expectedStart});
}
{
 const h=await fixture({},true,{goal:{id:'stopping-goal',phase:'waiting',stopRequested:true,stoppedAt:100000}});
 await h.signal(start);assert.equal(h.messages.length,1,'a distinct later manual send survives pending Stop');
}
{
 const h=await fixture({},true);
 h.failGet();
 await h.signal({type:'CHATGPT_CONVERSATION_REQUEST_COMPLETED',startedAt:start.startedAt,requestId:start.requestId});
 assert.equal(h.messages.length,1,'a failed pending-start read cannot swallow the terminal observation');
 assert.equal(h.messages[0].message.type,'CHATGPT_CONVERSATION_REQUEST_COMPLETED');
 assert.ok(h.timers.size,'pending-start storage is retried independently of the terminal signal');
}
const root='https://chatgpt.com/',allocatedPrompt='/c/startup-request-fixture|first-native-user';
const rootRequest={sequence:1,kind:'request.started',tabId:7,sourceUrl:root,requestId:start.requestId,eventAt:start.startedAt,operationId:null};
const allocation={sequence:2,kind:'completion.url_allocated',tabId:7,sourceUrl:url,requestId:start.requestId,attemptId:String(start.startedAt),promptKey:allocatedPrompt};
const rootOptions={url:root,checkpoint:{url:root,baselineKey:'',promptKey:''},receipt:{url:''},journal:{ok:true,meta:{sequence:1},events:[rootRequest]}};
{
 const h=await fixture({},false,rootOptions);await h.signal({...start,sourceUrl:root});h.ready();await h.retry();
 assert.equal(h.messages.length,0);assert.equal(h.data[key].length,1,'unallocated root remains pending without a false delivery');
 h.route(url);h.checkpoint({url,promptKey:allocatedPrompt});h.journal({ok:true,meta:{sequence:2},events:[rootRequest,allocation]});
 await h.retry();assert.deepEqual(h.messages,[{tabId:7,message:{...start,sourceUrl:root,replayBinding:{...expectedStart.replayBinding,sourceUrl:root}}}],'exact native first-message allocation permits one root-to-chat replay');
 assert.equal(h.data[key].length,0);
}
{
 const original=await fixture({},false,rootOptions);await original.signal({...start,sourceUrl:root});
 const restarted=await fixture(original.data,true,{...rootOptions,url,checkpoint:{url,baselineKey:'',promptKey:allocatedPrompt},journal:{ok:true,meta:{sequence:2},events:[rootRequest,allocation]}});
 for(let i=0;i<4;i++)await tick();assert.equal(restarted.messages.length,1,'restart requires and accepts the same durable root allocation proof');
}
for(const scenario of ['missing-allocation','conflicting-allocation','gap','wrong-chat','Stop','newer-request','unknown-request']) {
 const h=await fixture({},false,rootOptions);await h.signal({...start,sourceUrl:root});h.route(url);h.checkpoint({url,promptKey:allocatedPrompt});
 const events:V[]=[structuredClone(rootRequest),structuredClone(allocation)];
 if(scenario==='missing-allocation')events.pop();
 if(scenario==='conflicting-allocation')events.push({...allocation,sequence:3,promptKey:'/c/startup-request-fixture|different-native-user'});
 if(scenario==='gap')events[1].sequence=3;
 if(scenario==='wrong-chat')events[1].sourceUrl='https://chatgpt.com/c/different-fixture';
 if(scenario==='Stop')h.goal({phase:'stopped'});
 if(scenario==='newer-request')events.push({kind:'request.started',sequence:3,tabId:8,sourceUrl:url,requestId:'later'});
 if(scenario==='unknown-request')events.push({kind:'request.started',sequence:3,tabId:8,sourceUrl:root,observedTabUrl:root,requestId:'unknown'});
 h.journal({ok:true,meta:{sequence:events.at(-1)?.sequence||0},events});h.ready();await h.retry();
 assert.equal(h.messages.length,0,scenario+' cannot replay into a canonical chat');assert.equal(h.attachments,0);
}
{
 let state:V={schema:1,id:'paused-goal',url,phase:'paused',pauseRequested:true,operation:null,goal:'Saved objective',rules:'',startedAt:1,manualStartedAt:1,deadlineAt:1000000,expectedPromptKey:'/c/startup-request-fixture|before',supplements:[]};
 const automatic:V[]=[];const context=createContext({URL,console});
 for(const file of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+file,'utf8'),context);
 context.deps={storage:{get:async(k:string)=>({[k]:structuredClone(state)}),set:async(v:V)=>{state=structuredClone(v['chatgpt-goal:'+url]);}},
  tabs:{get:async()=>({id:7,url}),sendMessage:async(_id:number,message:V)=>{automatic.push(message);return {ok:true};}},appendJournal:async()=>({ok:true}),now:()=>100010,uuid:()=> 'unused'};
 const store=runInContext('ChatGPTGoalStore.create(deps)',context);
 const h=await fixture({},false,{goal:state,onDelivery:async(message:V)=>{if(message.type!==start.type)return;
  await store.manual({url,tabId:7,requestId:start.requestId,startedAt:start.startedAt,eventAt:100000,text:'Sent manual instruction',baselineKey:'/c/startup-request-fixture|before'});
  const bound=await store.manualBind({url,tabId:7,id:'paused-goal',requestId:start.requestId,startedAt:start.startedAt,promptKey:'/c/startup-request-fixture|manual-native-user',userId:'manual-native-user',userText:'Sent manual instruction',userSentAtMs:start.startedAt,nativeVerified:true});
  assert.equal(bound.ok,true);}});
 await h.signal(start);h.ready();await h.retry();assert.equal(h.messages.length,1,'Pause preserves observation of the sent manual instruction');
 assert.equal(state.phase,'paused');assert.equal(state.supplements[0].userId,'manual-native-user');assert.equal(automatic.length,0,'binding a paused Goal manual supplement never dispatches');
}

for(const scenario of ['route','Stop','new-request','terminal']) {
 let changed=false;const options:V={...rootOptions,url,checkpoint:{url,baselineKey:'',promptKey:allocatedPrompt},
  journal:{ok:true,meta:{sequence:2},events:[rootRequest,allocation]},onJournal:(state:V)=>{if(changed)return;changed=true;
   if(scenario==='route')state.route('https://chatgpt.com/c/different-fixture');
   if(scenario==='Stop')state.goal({phase:'stopped',stopRequested:true});
   if(scenario==='new-request'){state.receipt({requestId:'later',startedAt:100002});state.checkpoint({requestId:'later',startedAt:100002});}
   if(scenario==='terminal')state.checkpoint({state:'completed'});}};
 const h=await fixture({},false,options);await h.signal({...start,sourceUrl:root});h.ready();await h.retry();
 assert.equal(changed,true,'the test reaches the allocation journal read');assert.equal(h.messages.length,0,scenario+' during journal proof refuses root replay');
 assert.equal(h.attachments,0);assert.equal(h.data[key].length,0);
}

for(const normalized of [false,true]) {
 const h=await fixture({},false,{...rootOptions,url,checkpoint:{url,baselineKey:'',promptKey:allocatedPrompt},
  journal:{ok:true,meta:{sequence:3},events:[rootRequest,allocation,{...allocation,sequence:3,sourceUrl:normalized?url+'?model=pro':url}]}});
 await h.signal({...start,sourceUrl:root});h.ready();await h.retry();
 assert.equal(h.messages.length,1,'identical allocation identity may be recorded twice without blocking root replay');
 assert.deepEqual(h.messages[0].message.replayBinding,{sourceUrl:root,targetUrl:url,requestId:start.requestId,startedAt:start.startedAt});
}
for(const patch of [{attemptId:'different'},{promptKey:undefined},{sourceUrl:undefined},{requestId:'different'}]) {
 const h=await fixture({},false,{...rootOptions,url,checkpoint:{url,baselineKey:'',promptKey:allocatedPrompt},
  journal:{ok:true,meta:{sequence:3},events:[rootRequest,allocation,{...allocation,sequence:3,...patch}]}});
 await h.signal({...start,sourceUrl:root});h.ready();await h.retry();
 assert.equal(h.messages.length,0,'conflicting or incomplete allocation identity never permits replay');assert.equal(h.data[key].length,1);
}

{
 const h=await fixture({},true,{staleReplay:true});await h.signal(start);
 assert.equal(h.messages.length,0);assert.equal(h.data[key].length,1,'a refused receive-side binding is not a successful delivery');
 assert.equal(h.attachments,0,'an explicit receiver refusal does not reinject content scripts');
 h.refuseReplay(false);await h.retry();assert.equal(h.messages.length,1);assert.equal(h.data[key].length,0);
}
{
 const h=await fixture({},true,{staleReplay:true,afterRefusal:(state:V)=>state.route('https://chatgpt.com/c/different-fixture')});
 await h.signal(start);assert.equal(h.messages.length,0);assert.equal(h.data[key].length,0,'a receiver refusal retires only after the worker independently proves staleness');
 assert.equal(h.attachments,0);
}

{
 const h=await fixture({},true,{staleReplay:true,failRefusalRecheck:true});await h.signal(start);
 assert.equal(h.messages.length,0);assert.equal(h.attachments,0,'transient metadata failure after a receiver refusal cannot authorize reinjection');
 assert.equal(h.data[key].length,1);h.refuseReplay(false);await h.retry();assert.equal(h.messages.length,1);
}
{
 const h=await fixture({},true,{staleReplay:true});await h.signal(start);
 for(let i=0;i<5;i++)await h.retry();
 assert.equal(h.messages.length,0);assert.equal(h.attachments,0);assert.equal(h.timers.size,0);
 assert.equal(h.data[key].length,1,'missing isolated request globals never turn an otherwise exact pending START into a successful or retired observation');
 const restarted=await fixture(h.data,true,{staleReplay:true});for(let i=0;i<4;i++)await tick();
 assert.equal(restarted.messages.length,0);assert.equal(restarted.data[key].length,1,'worker restart retains the exact observation while receiver identity is unavailable');
 restarted.refuseReplay(false);await restarted.retry();assert.equal(restarted.messages.length,1);assert.equal(restarted.data[key].length,0);
}
