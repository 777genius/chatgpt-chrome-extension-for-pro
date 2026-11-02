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
let currentUrl=source,activeQueries=0,controllerFailure=false;
const context=createContext({URL,
  chrome:{runtime:{onMessage:{addListener:(value:Listener)=>{listener=value;}}},tabs:{
    get:async(id:number)=>{tabReads.push(id);return {id,url:currentUrl};},
    query:async()=>{activeQueries++;return [{id:99,url:other}];}
  }},
  goalController:{
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
assert.deepEqual(calls,[{kind:'get',value:source}]);

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
assert.deepEqual(tabReads,[7,7,7,7,7]);

const accepted=calls.length;
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
assert.equal(calls.length,accepted,'invalid sender, frame, URL or action cannot reach the controller');
assert.equal(tabReads.length,reads,'invalid message binding is rejected before querying a tab');

// The tab can navigate after the message captures its sender URL. Re-read its
// real route before either a write or a read, rather than trusting the payload.
currentUrl=other;
for(const action of ['get','start','pause','resume','stop']) {
  const result=await call(request(action,config));
  assert.equal(result.ok,false);
  assert.match(result.error,/Чат изменился/);
}
assert.equal(calls.length,accepted,'a route change cannot affect either chat Goal');
currentUrl=source;
controllerFailure=true;
const refused=await call(request('resume'));
assert.equal(refused.ok,false);
assert.match(refused.error,/Synthetic Goal refusal/);
assert.equal(activeQueries,0);

console.log('Goal inline worker: sender-tab ownership, route/frame/action fences and controller refusal passed.');
