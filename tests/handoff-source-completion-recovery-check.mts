import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createContext,runInContext}from'node:vm';
const source=readFileSync('extension/service-worker.js','utf8'),begin=source.indexOf('async function reconcileCompletedSourceHandoff('),end=source.indexOf('async function reconcileGoalPreparation(',begin);assert.ok(begin>0&&end>begin);
const url='https://chatgpt.com/c/source-fixture',reason='В исходном чате идёт генерация; переход отменён';
async function fixture(change=''){
 const goal:any={id:'goal',phase:'blocked',handoffTabId:7,handoffId:'handoff',preHandoffPhase:'waiting',reason:'Передача Goal остановлена: '+reason,expectedPromptKey:'/c/source-fixture|old',deadlineAt:Date.now()+100000};
 const handoff:any={id:'handoff',stage:'failed',reason,sourceUrl:url,lastUserText:'own test text'};
 const native:any={ok:true,url,isLatest:true,isReadOnly:false,generating:false,hasError:false,turnStatus:'complete',assistantCompleted:true,assistantPhase:'final_answer',assistantKey:'a1',promptKey:'/c/source-fixture|new',userId:'u1',userText:handoff.lastUserText,userSentAtMs:100000};
 const events:any[]=[{kind:'request.started',tabId:7,sourceUrl:url,operationId:'retry',requestId:'r1',eventAt:100000},{kind:'send.dispatched',tabId:7,operationId:'retry',text:handoff.lastUserText},{kind:'retry.confirmed',tabId:7,operationId:'retry'},{kind:'request.failed',tabId:7,operationId:'retry',requestId:'r1'},{kind:'handoff.navigating',tabId:7,operationId:'handoff',sourceUrl:url},{kind:'handoff.failed',tabId:7,operationId:'handoff',reason}].map((e,i)=>({...e,sequence:i+1}));
 if(change==='generating')native.generating=true;if(change==='error')native.hasError=true;if(change==='incomplete')native.assistantCompleted=false;
 if(change==='wrong-user')native.userText='new owner message';if(change==='wrong-phase')goal.phase='stopped';if(change==='paused')goal.pauseRequested=true;
 if(change==='intent')events.push({kind:'handoff.navigation_intent',tabId:7,operationId:'handoff',sequence:events.length+1});
 if(change==='later-send')events.push({kind:'request.started',tabId:7,sourceUrl:url,operationId:'later',eventAt:200000,sequence:events.length+1});
 if(change==='gap')events[2].sequence=99;if(change==='wrong-send')events[1].text='another message';
 let restored=0,reconciled=0,probes=0,journals=0;
 const data:any={['chatgpt-goal:'+url]:goal,key:handoff};
 const ctx=createContext({Date,JSON,Number,Object,Array,console,handoffKey:()=> 'key',inspectCompletedTurn:()=>{},
  chrome:{storage:{local:{get:async()=>structuredClone(data)}},tabs:{get:async()=>({url})},scripting:{executeScript:async()=>{probes++;let value=structuredClone(native);if(change==='changed-native'&&probes===2)value.userId='different';return[{result:value}];}}},
  readJournal:async()=>{journals++;let rows=structuredClone(events);if(change==='later-race'&&journals===2)rows.push({kind:'request.started',tabId:7,sourceUrl:url,operationId:'later',sequence:rows.length+1});return{ok:true,storageError:'',meta:{sequence:rows.length},events:rows};},
  ChatGPTGoalPolicy:{canonical:(x:string)=>x},goalController:{handoffSourceCompleted:async(input:any)=>{restored++;assert.equal(input.goalId,'goal');assert.equal(input.promptKey,native.promptKey);return{ok:true};}},
  reconcileWaitingGoalAnswer:async()=>{reconciled++;return {ok:true};}});
 runInContext(source.slice(begin,end),ctx);const result=await runInContext(`reconcileCompletedSourceHandoff(7,${JSON.stringify(url)})`,ctx);
 return {result,restored,reconciled};
}
const ok=await fixture();assert.equal(ok.result.ok,true);assert.equal(ok.restored,1);assert.equal(ok.reconciled,1);
for(const c of ['generating','error','incomplete','wrong-user','wrong-phase','paused','intent','later-send','gap','wrong-send','changed-native','later-race']){const f=await fixture(c);assert.equal(f.restored,0,c);assert.equal(f.reconciled,0,c);}
console.log('Historical source handoff recovery: exact completed turn, no navigation/send, changed native or new request and stop fences passed.');
