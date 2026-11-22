import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

type V=Record<string,any>;
const url='https://chatgpt.com/c/waiting-range',other='https://chatgpt.com/c/other',prefix='chatgpt-journal:event:',metaKey='chatgpt-journal:meta';
const source=readFileSync('extension/service-worker.js','utf8');
const helper=source.slice(source.indexOf('async function reconcileWaitingGoalAnswer('),source.indexOf('async function reconcileCompletedSourceHandoff('));
const eventKey=(sequence:number)=>prefix+String(sequence).padStart(12,'0');
async function fixture(realStore=false) {
 const first=108000,head=first+55,startedAt=1000000,prompt='/c/waiting-range|user';
 const fence={requestId:'request',startedAt,userId:'user',requestSequence:first};
 const goal:V={schema:1,id:'goal',url,phase:'waiting',operation:null,queuedResumeFence:fence,expectedPromptKey:prompt,
  goal:'Keep working',rules:'',startedAt,deadlineAt:startedAt+600000,maxContinuations:3,continuations:0,maxMinutes:10};
 const native:V={ok:true,url,promptKey:prompt,userId:'user',isLatest:true,isReadOnly:false,generating:false,hasError:false,
  turnStatus:'complete',assistantCompleted:true,assistantPhase:'final_answer',assistantKey:'answer',goalResponse:'Still working',goalRawExact:false};
 const receipt:V={requestId:'request',startedAt,submittedUserId:'user'},data:V={},reads:any[]=[],completions:V[]=[],sent:V[]=[];
 let recovery=false,probes=0,route=url,afterRead:((keys:any)=>void)|null=null,onProbe:((count:number)=>void)|null=null,onCompletion:(()=>Promise<void>)|null=null;
 const storage={get:async(keys:any)=>{
  if(recovery)assert.notEqual(keys,null,'background waiting recovery must not read all storage');reads.push(structuredClone(keys));
  const copy=structuredClone(keys===null?data:Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])));
  afterRead?.(keys);return copy;
 },set:async(items:V)=>Object.assign(data,structuredClone(items))};
 const tabs={get:async()=>({id:7,url:route}),sendMessage:async(_id:number,message:V)=>{sent.push(message);return {ok:true};}};
 const ctx=createContext({URL,console,chrome:{runtime:{getManifest:()=>({version:'test'})},storage:{local:storage},tabs,
  scripting:{executeScript:async()=>{probes++;onProbe?.(probes);return [{result:structuredClone(native)}];}}},
  inspectCompletedTurn:()=>{},latestRequestReceipt:async()=>structuredClone(receipt),readJournal:async()=>{throw Error('Full journal forbidden');}});
 for(const name of ['goal-policy.js','journal-store.js','goal-store.js'])runInContext(readFileSync('extension/'+name,'utf8'),ctx);
 await runInContext("initializeJournal('test')",ctx);
 for(let sequence=first;sequence<=head;sequence++)data[eventKey(sequence)]={sequence,kind:'fixture.unrelated',tabId:8,sourceUrl:other};
 data[eventKey(first)]={sequence:first,kind:'request.started',tabId:7,sourceUrl:url,requestId:'request',eventAt:startedAt};
 data[metaKey].sequence=head;data['chatgpt-goal:'+url]=goal;
 ctx.dependencies={storage,tabs,appendJournal:(event:V,tab:V,options:V)=>{ctx.event=event;ctx.tab=tab;ctx.options=options;return runInContext('appendJournal(event,tab,options)',ctx);},now:()=>startedAt+1000,uuid:()=> 'continuation'};
 const store=realStore?runInContext('ChatGPTGoalStore.create(dependencies)',ctx):null;
 ctx.goalController={get:async()=>structuredClone(data['chatgpt-goal:'+url]),completion:async(input:V)=>{
  completions.push(input);await onCompletion?.();return store?store.completion(input):{ok:true};
 }};
 runInContext(helper,ctx);reads.length=0;recovery=true;
 return {first,head,fence,data,native,receipt,reads,completions,sent,goal,
  afterRead:(fn:(keys:any)=>void)=>{afterRead=fn;},onProbe:(fn:(count:number)=>void)=>{onProbe=fn;},
  onCompletion:(fn:()=>Promise<void>)=>{onCompletion=fn;},route:(value:string)=>{route=value;},
  append:(row:V)=>{const sequence=++data[metaKey].sequence;data[eventKey(sequence)]={...row,sequence};},
  failure:()=>runInContext("journalFailure='write failed'",ctx),
  run:()=>runInContext(`reconcileWaitingGoalAnswer(7,${JSON.stringify(url)})`,ctx)};
}
{
 const h=await fixture();assert.equal((await h.run()).ok,true);assert.equal(h.completions.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(h.completions[0].verifiedQueuedResumeFence)),h.fence);
 const batches=h.reads.filter(Array.isArray);assert.deepEqual(batches.map(x=>x.length),[50,6]);
 assert.equal(batches.flat().length,56,'108k old events are neither fetched nor needed; the proven prefix is not fetched twice');
 assert.equal(batches[0][0],eventKey(h.first));assert.equal(batches[1].at(-1),eventKey(h.head));
}
for(const scenario of ['missing','wrong-sequence','anchor-error','tail-error','anchor-request','anchor-time','anchor-tab','anchor-url','future-anchor','receipt','stop','pause','write-error']) {
 const h=await fixture();
 if(scenario==='missing')delete h.data[eventKey(h.first+1)];
 if(scenario==='wrong-sequence')h.data[eventKey(h.first+1)].sequence=h.first;
 if(scenario==='anchor-error')h.data[eventKey(h.first)].previousWriteError='lost write';
 if(scenario==='tail-error')h.data[eventKey(h.head)].previousWriteError='lost write';
 if(scenario==='anchor-request')h.data[eventKey(h.first)].requestId='other';
 if(scenario==='anchor-time')h.data[eventKey(h.first)].eventAt++;
 if(scenario==='anchor-tab')h.data[eventKey(h.first)].tabId=8;
 if(scenario==='anchor-url')h.data[eventKey(h.first)].sourceUrl=other;
 if(scenario==='future-anchor')h.fence.requestSequence=h.head+1;
 if(scenario==='receipt')h.receipt.requestId='wrong';
 if(scenario==='stop')h.goal.stopRequested=true;
 if(scenario==='pause')h.goal.pauseRequested=true;
 if(scenario==='write-error')h.failure();
 await h.run();assert.equal(h.completions.length,0,scenario);
}
for(const scenario of ['same-tab','same-chat','observed-chat','unknown-source','other-chat','delta-gap','delta-error','head-rollback','native','stop','pause']) {
 const h=await fixture();
 h.onProbe(count=>{
  if(count!==2)return;
  if(scenario==='head-rollback'){h.data[metaKey].sequence=h.first;return;}
  if(scenario==='native'){h.native.assistantKey='changed';return;}
  if(scenario==='stop'){h.goal.stopRequested=true;return;}
  if(scenario==='pause'){h.goal.pauseRequested=true;return;}
  const row:V={kind:'request.started',tabId:8,sourceUrl:other,observedTabUrl:other};
  if(scenario==='same-tab')row.tabId=7;
  if(scenario==='same-chat')row.sourceUrl=url;
  if(scenario==='observed-chat')row.observedTabUrl=url;
  if(scenario==='unknown-source')row.sourceUrl=row.observedTabUrl='https://chatgpt.com/';
  if(scenario==='delta-error'){row.kind='fixture.unrelated';row.previousWriteError='lost write';}
  h.append(row);if(scenario==='delta-gap')delete h.data[eventKey(h.head+1)];
 });
 await h.run();assert.equal(h.completions.length,scenario==='other-chat'?1:0,scenario+' between native snapshots');
 if(scenario==='other-chat')assert.deepEqual(h.reads.filter(Array.isArray).map(x=>x.length),[50,6,1],'only the new contiguous delta is read again');
}
for(const row of [
 {tabId:7,sourceUrl:other},{tabId:8,sourceUrl:url},{tabId:8,sourceUrl:other,observedTabUrl:url},
 {tabId:8,sourceUrl:'https://chatgpt.com/',observedTabUrl:'https://chatgpt.com/'}
]) {
 const h=await fixture();h.append({kind:'request.started',...row});
 await h.run();assert.equal(h.completions.length,0,'same tab/chat, observed same chat and unknown requests veto the initial suffix');
}
for(const scenario of ['head-growth','head-rollback','stop','pause','receipt','route','native']) {
 const h=await fixture();let changed=false;
 h.afterRead(keys=>{if(changed||!Array.isArray(keys))return;changed=true;
  if(scenario==='head-growth')h.append({kind:'fixture.unrelated'});
  if(scenario==='head-rollback')h.data[metaKey].sequence=h.first;
  if(scenario==='stop')h.goal.stopRequested=true;
  if(scenario==='pause')h.goal.pauseRequested=true;
  if(scenario==='receipt')h.receipt.requestId='later';
  if(scenario==='route')h.route(other);
  if(scenario==='native')h.native.userId='later';
 });
 await h.run();assert.equal(h.completions.length,0,scenario+' during batched storage reads fails closed');
}
for(const scenario of ['success','new-request','stop','pause']) {
 const h=await fixture(true);
 if(scenario!=='success')h.onCompletion(async()=>{
  if(scenario==='new-request')h.append({kind:'request.started',tabId:8,sourceUrl:url,requestId:'late',eventAt:1001001});
  else {h.goal.phase=scenario==='stop'?'stopped':'paused';h.goal[scenario==='stop'?'stopRequested':'pauseRequested']=true;}
 });
 const result=await h.run();assert.equal(h.sent.length,scenario==='success'?1:0,'production Goal/journal CAS rechecks before any dispatch: '+scenario);
 if(scenario==='success')assert.equal(result.ok,true);
}
console.log('Waiting Goal exact range: 108k prefix skipped, bounded batches/delta, gaps/write failures/native/state races and production atomic send fences passed.');
