import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Real worker adoption helper and durable coordinator; native MAIN inspection
// and request receipts are synthetic boundaries. No browser or click handler.
const worker=readFileSync('extension/service-worker.js','utf8');
const from=worker.indexOf('async function bindNativeComposerGoal(');
const until=worker.indexOf('chrome.runtime.onMessage.addListener',from);
assert.ok(from>0&&until>from);
const chat='https://chatgpt.com/c/native-goal-fixture',other='https://chatgpt.com/c/native-goal-other';
type Value=Record<string,any>;
async function fixture(source=chat) {
 const data:Value={},events:Value[]=[],messages:Value[]=[],binds:Value[]=[],completions:Value[]=[],probes:Value[]=[];
 let request:Value|null={requestId:'native-request',startedAt:100001,url:source==='https://chatgpt.com/'?'':chat};
 let live=chat,afterProbe:(()=>void|Promise<void>)|null=null,bindMode='',probeThrows=false;
 let native:Value|undefined={ok:true,url:chat,isLatest:true,isReadOnly:false,userId:'native-user',
  userText:'  Exact sent objective\nwith whitespace  ',userSentAtMs:100001,promptKey:'/c/native-goal-fixture|native-user',
  firstTurn:true,turnStatus:'in_progress',generating:true,hasError:false,assistantCompleted:false,
  assistantPhase:'final_answer',assistantKey:'native-assistant',goalResponse:'GOAL_COMPLETE',goalRawExact:true};
 const context=createContext({URL,Date,console,
  latestRequestReceipt:async()=>request?structuredClone(request):null,
  inspectCompletedTurn:function inspectCompletedTurn(){},
  chrome:{tabs:{get:async()=>({id:7,url:live})},scripting:{executeScript:async(options:Value)=>{
   probes.push(options);if(probeThrows)throw Error('Synthetic MAIN disconnect');
   const result=structuredClone(native);await afterProbe?.();return [{result}];
  }}}
 });
 runInContext(readFileSync('extension/goal-policy.js','utf8'),context);
 runInContext(readFileSync('extension/goal-store.js','utf8'),context);
 context.dependencies={storage:{get:async(key:string)=>({[key]:structuredClone(data[key])}),
  set:async(value:Value)=>Object.assign(data,structuredClone(value))},
  tabs:{get:async()=>({id:7,url:live}),sendMessage:async(tabId:number,message:Value)=>{messages.push({tabId,message});return {ok:true};}},
  appendJournal:async(event:Value)=>{events.push(structuredClone(event));return {ok:true};},now:()=>100010,uuid:()=> 'native-arm'};
 const store=runInContext('ChatGPTGoalStore.create(dependencies)',context);
 const armed=await store.composerArm({tabId:7,url:source});
 await store.composerIntent({tabId:7,url:source,armId:armed.record.id,eventAt:100010,
  text:native.userText,baselineKey:source==='https://chatgpt.com/'?'':'/c/native-goal-fixture|old-user'});
 // Native request begins after the explicit send intent.
 request!.startedAt=100011;native.userSentAtMs=100011;
 context.goalController={...store,composerBind:async(value:Value)=>{
  binds.push(structuredClone(value));if(bindMode==='unknown')return {ok:false};
  if(bindMode==='throw')throw Error('Synthetic bind disconnect');return store.composerBind(value);
 },completion:async(value:Value)=>{completions.push(structuredClone(value));return store.completion(value);}};
 runInContext(worker.slice(from,until),context);
 return {data,events,messages,binds,completions,probes,store,
  bind:(url=live,armId=armed.record.id)=>{context.input={url,armId};return runInContext('bindNativeComposerGoal(7,input.url,input.armId)',context) as Promise<Value>;},
  native:()=>native!,patchNative:(patch:Value)=>Object.assign(native!,patch),missingNative:()=>{native=undefined;},restoreNative:(value:Value)=>{native=value;},
  recoverer:(fn:Function)=>{context.recoverNativeComposerGoal=fn;},request:(value:Value|null)=>{request=value;},route:(value:string)=>{live=value;},
  afterProbe:(effect:()=>void|Promise<void>)=>{afterProbe=effect;},bindMode:(value:string)=>{bindMode=value;},probeThrows:()=>{probeThrows=true;}};
}

for(const source of [chat,'https://chatgpt.com/']) {
 const h=await fixture(source),bound=await h.bind();
 assert.equal(bound.ok,true);assert.equal(bound.record.phase,'waiting');assert.equal(bound.record.goal,h.native().userText);
 assert.deepEqual(structuredClone(h.probes[0].args),[chat,true],'only an explicit adoption requests sent native text');
 assert.deepEqual(h.binds[0],{tabId:7,armId:'native-arm',url:chat,requestId:'native-request',startedAt:100011,
  promptKey:h.native().promptKey,userId:'native-user',userText:h.native().userText,userSentAtMs:100011,userVisibleText:undefined,firstTurn:true,nativeVerified:true});
 assert.equal(h.completions.length,0);assert.equal(h.messages.length,0,'adoption never sends or clicks');
 assert.equal((await h.bind()).ok,true);assert.equal(h.binds.length,1,'already bound adoption is idempotent');
 assert.equal(h.probes.length,1);assert.equal(h.completions.length,0);
 assert.equal((await h.bind(other)).ok,false,'a bound arm cannot adopt another destination');
}
{
 const h=await fixture();
 const visible=h.native().userText;
 const raw='  [Exact](https://example.test/task) sent objective\nwith whitespace  ';
 h.patchNative({userText:raw,userVisibleText:visible});
 const adopted=await h.bind();
 assert.equal(adopted.record.goal,raw,'worker forwards the native-bound visible proof while retaining actual submitted URLs');
 assert.equal(h.binds[0].userVisibleText,visible);
 assert.equal(h.messages.length,0);
}
{
 const h=await fixture();assert.equal((await h.bind(chat,'other-arm')).ok,false);
 await h.store.composerDisarm({tabId:7});assert.equal((await h.bind()).ok,false);
 assert.equal(h.probes.length,0);assert.equal(h.binds.length,0,'missing or replaced pending arm cannot inspect or bind');
}
{
 const h=await fixture('https://chatgpt.com/');
 assert.equal((await h.bind('https://chatgpt.com/')).pending,true,'root waits for a permanent native destination');
 assert.equal(h.probes.length,0);assert.equal(h.binds.length,0);
 h.patchNative({firstTurn:false});await assert.rejects(()=>h.bind(),/первым сообщением/);
 assert.equal(h.data['chatgpt-goal:'+chat],undefined);
}
for(const patch of [{isLatest:false},{isReadOnly:true},{userId:''},{userSentAtMs:null},{userText:null},{promptKey:''}]) {
 const h=await fixture();h.patchNative(patch);assert.equal((await h.bind()).pending,true);
 assert.equal(h.binds.length,0);assert.equal(h.completions.length,0);
}
for(const request of [null,{requestId:'old',startedAt:100009,url:chat},{requestId:'late',startedAt:110011,url:chat}]) {
 const h=await fixture();h.request(request);assert.equal((await h.bind()).pending,true);
 assert.equal(h.binds.length,0);assert.equal(h.completions.length,0);
}
for(const race of ['route','request','startedAt']) {
 const h=await fixture();h.afterProbe(()=>{
  if(race==='route')h.route(other);
  else h.request({requestId:race==='request'?'changed':'native-request',startedAt:race==='startedAt'?100012:100011,url:chat});
 });
 assert.equal((await h.bind()).ok,false);assert.equal(h.binds.length,0);assert.equal(h.completions.length,0);
}
{
 const h=await fixture();h.request({requestId:'native-request',startedAt:100011,url:other});
 assert.equal((await h.bind()).ok,false);assert.equal(h.binds.length,0);
}
{
 const h=await fixture();h.missingNative();assert.equal((await h.bind()).pending,true);assert.equal(h.binds.length,0);
}
{
 const h=await fixture();h.patchNative({userText:'Different sent objective'});
 await assert.rejects(()=>h.bind(),/точным запросом и текстом/);
 assert.equal(h.data['chatgpt-goal:'+chat],undefined);assert.equal(h.completions.length,0);
}
{
 const h=await fixture();h.afterProbe(async()=>{await h.store.composerDisarm({tabId:7});});
 await assert.rejects(()=>h.bind(),/намерения ручной отправки/);
 assert.equal(h.data['chatgpt-goal:'+chat],undefined);assert.equal(h.completions.length,0,'a disarm during MAIN inspection cannot replay a completion');
}
{
 const h=await fixture();h.patchNative({turnStatus:'complete',generating:false,assistantCompleted:true});
 assert.equal((await h.bind()).record.phase,'completed');
 assert.deepEqual(h.completions,[{url:chat,tabId:7,completionKey:h.native().promptKey+'|native-assistant',
  promptKey:h.native().promptKey,userId:'native-user',response:'GOAL_COMPLETE',rawExact:true,nativeMarkerPending:false,nativeVerified:true}]);
 await h.bind();assert.equal(h.completions.length,1,'completed-before-bind replay is not repeated');assert.equal(h.messages.length,0);
}
{
 const h=await fixture();h.patchNative({turnStatus:'complete',generating:false,assistantCompleted:true,goalRawExact:'true'});
 const result=await h.bind();
 assert.equal(h.completions[0].rawExact,false,'truthy non-boolean native marker evidence cannot complete a goal');
 assert.notEqual(result.record.phase,'completed');
}
for(const patch of [{generating:true},{hasError:true},{assistantCompleted:false},{assistantPhase:'commentary'},{assistantKey:''}]) {
 const h=await fixture();h.patchNative({turnStatus:'complete',generating:false,assistantCompleted:true,...patch});
 await h.bind();assert.equal(h.completions.length,0,'incomplete or ambiguous native answer cannot replay');assert.equal(h.messages.length,0);
}
{
 const h=await fixture();
 const intent=h.native().userText;
 h.patchNative({userText:'[Exact](https://example.test/task) submitted objective',userVisibleText:intent+'\n'});
 assert.equal((await h.bind()).record.goal,h.native().userText,'native rendered paragraph whitespace does not orphan explicit consent');
 assert.equal(h.messages.length,0);
}
for(const mode of ['unknown','throw','probe-throw']) {
 const h=await fixture();h.patchNative({turnStatus:'complete',generating:false,assistantCompleted:true});
 if(mode==='probe-throw')h.probeThrows();else h.bindMode(mode);
 if(mode==='unknown')assert.equal((await h.bind()).ok,false);else await assert.rejects(()=>h.bind(),/disconnect/);
 assert.equal(h.completions.length,0);assert.equal(h.messages.length,0);
}
{
 const h=await fixture('https://chatgpt.com/');
 const native=structuredClone(h.native());
 h.missingNative();assert.equal((await h.bind()).pending,true);
 const saved=h.data['chatgpt-goal-composer:7'];
 assert.equal(saved.request.requestId,'native-request','request evidence is durable before native content becomes available');
 h.request(null);
 // Missing native content must still refuse, even with a durable request.
 assert.equal((await h.bind()).pending,true);assert.equal(h.binds.length,0);
 h.restoreNative(native);
 assert.equal((await h.bind()).record.phase,'waiting','late native binding survives loss of the session receipt');
 assert.equal(h.messages.length,0,'recovering initial consent does not send a duplicate');
}
console.log('Native composer Goal adoption: request/route freshness, root binding, exact durable proof, idempotence and guarded completion replay passed.');

{
 const h=await fixture('https://chatgpt.com/');await h.store.composerRequest({tabId:7,armId:'native-arm',requestId:'native-request',startedAt:100011,url:'https://chatgpt.com/'});
 h.request(null);h.patchNative({userId:'accepted-transfer-user',userText:'Accepted automatic handoff payload',userSentAtMs:200000});let calls=0;
 h.recoverer(async()=>{calls++;return {ok:true,pending:true,recovered:true};});
 assert.equal((await h.bind()).recovered,true,'lost request cache must use historical/lineage recovery rather than bind the transfer as original objective');assert.equal(calls,1);assert.equal(h.binds.length,0);assert.equal(h.messages.length,0);
}
