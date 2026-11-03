import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Execute the production inline broker with the real canonical URL policy.
// Controller calls are the observable boundary: rejected senders/routes must
// never reach Goal state, and the browser's active tab must not select a chat.
const worker=readFileSync('extension/service-worker.js','utf8');
const first=worker.indexOf('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {');
const last=worker.indexOf("  if(message?.type==='CHATGPT_GOAL_CONTROL')",first);
assert.ok(first>=0&&last>first,'inline worker broker is present');
type Listener=(message:any,sender:any,respond:(value:any)=>void)=>boolean|undefined;
let listener:Listener|undefined;
const source='https://chatgpt.com/c/inline-worker-source';
const other='https://chatgpt.com/c/inline-worker-other';
const calls:{kind:string,value:any}[]=[];
const tabReads:number[]=[];
let currentUrl=source,activeQueries=0,controllerFailure=false,composerUrlOverride='';
const context=createContext({URL,
  chrome:{runtime:{onMessage:{addListener:(value:Listener)=>{listener=value;}}},tabs:{
    get:async(id:number)=>{tabReads.push(id);return {id,url:currentUrl};},
    query:async()=>{activeQueries++;return [{id:99,url:other}];}
  }},
  bindNativeComposerGoal:async(tabId:number,url:string,armId:string)=>{calls.push({kind:'bind',value:{tabId,url,armId}});return {ok:true};},
  goalController:{
    composerGet:async(value:any)=>{calls.push({kind:'composerGet',value});return {id:'armed',phase:'armed',url:composerUrlOverride||currentUrl};},
    composerArm:async(value:any)=>{calls.push({kind:'arm',value});return {ok:true,record:{id:'armed'}};},
    composerDisarm:async(value:any)=>{calls.push({kind:'disarm',value});return {ok:true,record:null};},
    composerIntent:async(value:any)=>{calls.push({kind:'intent',value});return {ok:true,record:{id:'armed',phase:'intent'}};},
    get:async(url:string)=>{calls.push({kind:'get',value:url});return {id:'saved-goal'};},
    start:async(value:any)=>{calls.push({kind:'start',value});return {ok:true,record:{id:'new-goal'}};},
    control:async(value:any)=>{calls.push({kind:'control',value});if(controllerFailure)throw Error('Synthetic Goal refusal');return {ok:true};}
  }
});
runInContext(readFileSync('extension/goal-policy.js','utf8'),context);
runInContext(worker.slice(first,last)+'\n});',context);
assert.ok(listener);
const sender=()=>({tab:{id:7,url:source},frameId:0});
const call=(message:any,from=sender())=>new Promise<any>((resolve,reject)=>{
  let responded=false;
  const keep=listener!(message,from,value=>{responded=true;resolve(value);});
  if(!keep&&!responded)reject(Error('Inline broker did not return a response'));
});
const request=(action:string,extra:Record<string,unknown>={})=>({type:'CHATGPT_GOAL_INLINE',action,url:source,...extra});

const read=await call(request('get',{tabId:99}));
assert.equal(read.ok,true);
assert.equal(read.tabId,7);
assert.equal(read.url,source);
assert.equal(read.record.id,'saved-goal');
assert.equal(read.composer.id,'armed');
assert.deepEqual(calls.filter(value=>value.kind==='get'),[{kind:'get',value:source}]);

const config={goal:'  Preserve the explicit goal text  ',rules:'Synthetic stop rules',maxContinuations:3,maxMinutes:20};
const started=await call(request('start',{...config,tabId:99,url:source+'/'}));
assert.equal(started.ok,true);
assert.equal(started.tabId,7);
assert.equal(started.url,source);
assert.deepEqual(structuredClone(calls.at(-1)),{kind:'start',value:{url:source,tabId:7,...config}});
for(const action of ['pause','resume','stop']) {
  assert.equal((await call(request(action))).ok,true);
  assert.deepEqual(structuredClone(calls.at(-1)),{kind:'control',value:{action,url:source,tabId:7}});
}
assert.equal(activeQueries,0,'inline actions use the sending tab even when a different tab is active');
assert.ok(tabReads.every(id=>id===7));
for(const action of ['arm','disarm','intent','bind']) {
 const result=await call(request(action,{armId:'armed',eventAt:100000,text:'Sent objective',baselineKey:'',tabId:99}));
 assert.equal(result.ok,true);
 const mutation=calls.findLast(value=>value.kind===action)!;
 assert.equal(mutation.value.tabId,7);
}
currentUrl='https://chatgpt.com/';
const root=await call(request('arm',{url:currentUrl}),{tab:{id:7,url:currentUrl},frameId:0});
assert.equal(root.ok,true,'new chat root can arm before native send');
assert.equal(root.record,null);assert.equal(root.composer.id,'armed');
assert.equal(calls.findLast(value=>value.kind==='arm')!.value.url,currentUrl);
currentUrl=source;
composerUrlOverride='https://chatgpt.com/';
assert.equal((await call(request('intent',{url:composerUrlOverride,armId:'armed',eventAt:100000,text:'Sent root goal',baselineKey:''}))).ok,true,
 'a root intent may arrive after the native page receives its canonical destination');
assert.equal(calls.findLast(value=>value.kind==='intent')!.value.url,composerUrlOverride);
composerUrlOverride='';

const mutations=()=>calls.filter(value=>!['get','composerGet'].includes(value.kind));
const accepted=mutations().length;
const reads=tabReads.length;
for(const [message,from] of [
  [request('start',{url:other}),sender()],
  [request('start'),{...sender(),frameId:1}],
  [request('start'),{tab:{id:7,url:'https://example.invalid/c/inline-worker-source'},frameId:0}],
  [request('start'),{tab:{id:7,url:'https://chatgpt.com/'},frameId:0}],
  [request('start'),{tab:undefined,frameId:0}],
  [request('delete'),sender()]
] as [any,any][]) {
  assert.equal((await call(message,from)).ok,false);
}
assert.equal(mutations().length,accepted,'invalid sender, frame, URL or action cannot mutate Goal');
assert.ok(tabReads.slice(reads).every(id=>id===7),'only the sender tab may be queried for valid page URLs');

// The tab can navigate after the message captures its sender URL. Re-read its
// real route before either a write or a read, rather than trusting the payload.
currentUrl=other;
for(const action of ['get','arm','disarm','intent','bind','start','pause','resume','stop']) {
  const result=await call(request(action,config));
  assert.equal(result.ok,false);
  assert.match(result.error,/Чат изменился/);
}
assert.equal(mutations().length,accepted,'a route change cannot affect either chat Goal');
currentUrl=source;
controllerFailure=true;
const refused=await call(request('resume'));
assert.equal(refused.ok,false);
assert.match(refused.error,/Synthetic Goal refusal/);
assert.equal(activeQueries,0);

console.log('Goal inline worker: sender-tab ownership, route/frame/action fences and controller refusal passed.');
