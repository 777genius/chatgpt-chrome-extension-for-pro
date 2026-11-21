import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Exercise the delayed terminal-history inspection with a newer request that
// starts and finishes while the inspection is pending on the same chat route.
const source=readFileSync('extension/content-script.js','utf8');
const start=source.indexOf('  async function routeError(');
const end=source.indexOf('  function scheduleHandoffReadiness(',start);
assert.ok(start>0&&end>start);
for(const change of ['none','attempt','request']) {
 let inspect=0,begins=0,timer:(()=>void)|null=null,finish!:(value:unknown)=>void;
 const draft='  Owner draft\nexact spacing  ',state={terminalHandled:false,blocked:false};
 const ctx=createContext({
  location:{pathname:'/c/history-race-fixture'},__chatgptNotifierAttemptId:'attempt-a',__chatgptNotifierRequestId:'request-a',
  document:{querySelectorAll:()=>[alert]},ERROR_SELECTOR:'synthetic-alert',
  historyRetryTimer:null,runtimeAvailable:()=>true,latestPromptSnapshot:()=>({promptKey:'prompt-a'}),
  retryState:()=>state,audit:async()=>{},notifyError:()=>{},notifyOperationWarning:()=>{},
  runtimeMessage:async()=>{
   if(++inspect===1)return {ok:true,action:'new-chat',messages:[],incomplete:true};
   return new Promise(resolve=>{finish=resolve;});
  },
  beginHandoff:async()=>{
   if(++begins===1)throw Error('Не удалось получить полные последние сообщения; исходный чат сохранён');
  },
  setTimeout:(callback:()=>void)=>{timer=callback;return 1;},draft
 });
 const alert={isConnected:true};
 runInContext(source.slice(start,end),ctx);ctx.alert=alert;
 await runInContext("routeError({response:'Terminal limit'},'prompt-a',alert)",ctx);
 assert.equal(begins,1);assert.equal(inspect,1);assert.ok(timer);
 (timer as ()=>void)();assert.equal(inspect,2);
 if(change==='attempt')ctx.__chatgptNotifierAttemptId='attempt-b';
 if(change==='request')ctx.__chatgptNotifierRequestId='request-b';
 finish({ok:true,action:'new-chat',messages:[{role:'user',text:'Older task'}],incomplete:false});
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(begins,change==='none'?2:1,'only the exact inspected request may begin a delayed handoff: '+change);
 assert.equal(ctx.draft,draft,'inspection does not change the owner draft');
}
console.log('Delayed terminal history: post-inspection attempt/request identity changes refuse handoff; unchanged request proceeds.');
