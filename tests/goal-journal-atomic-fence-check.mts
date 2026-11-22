import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const source=readFileSync('extension/journal-store.js','utf8');
const url='https://chatgpt.com/c/atomic-fixture',tab={id:7,url},goalKey='chatgpt-goal:'+url;
async function fixture() {
 const data:Record<string,any>={},writes:any[]=[];
 let hold:((items:any)=>boolean)|null=null,holdAfter:((items:any)=>boolean)|null=null,fail:((items:any)=>boolean)|null=null;
 let entered:()=>void=()=>{},release:()=>void=()=>{},gate:Promise<void>|null=null;
 const chrome={runtime:{getManifest:()=>({version:'test'})},storage:{local:{
  get:async(keys:any)=>structuredClone(keys===null?data:Array.isArray(keys)?Object.fromEntries(keys.map(k=>[k,data[k]])):{[keys]:data[keys]}),
  set:async(items:any)=>{if(fail?.(items)){fail=null;throw Error('Synthetic storage failure');}if(hold?.(items)){hold=null;entered();await gate;}
   writes.push(structuredClone(items));Object.assign(data,structuredClone(items));if(holdAfter?.(items)){holdAfter=null;entered();await gate;}}
 }}};
 let ctx=createContext({URL,console,chrome});runInContext(source,ctx);
 const append=async(event:any,t=tab,options:any={})=>{ctx.e=event;ctx.t=t;ctx.o=options;return runInContext('appendJournal(e,t,o)',ctx)};
 await runInContext("initializeJournal('test')",ctx);
 const startedAt=123456789,requestId='manual-request';
 const started=await append({kind:'request.started',sourceUrl:url,requestId,eventAt:startedAt});
 const fence={requestId,startedAt,userId:'native-user',requestSequence:started.sequence};
 const expected={id:'goal',url,phase:'waiting',operation:null,queuedResumeFence:fence,continuations:1};
 data[goalKey]=structuredClone(expected);
 const next={...expected,queuedResumeFence:null,phase:'completed',lastCompletionKey:'user|answer'};
 const event={kind:'goal.answer_complete',sourceUrl:url,goalId:'goal',completionKey:'user|answer'};
 const cas=(n:Record<string,any>=next)=>append(event,tab,{goalCAS:{url,expected,next:n,fence}});
 function defer(predicate:(items:any)=>boolean,after=false) {
  const observed=new Promise<void>(resolve=>{entered=resolve;});
  gate=new Promise<void>(resolve=>{release=resolve;});if(after)holdAfter=predicate;else hold=predicate;
  return {observed,release:()=>release()};
 }
 const reboot=()=>{ctx=createContext({URL,console,chrome});runInContext(source,ctx);};
 const recover=()=>runInContext('recoverProvisionalGoalCAS()',ctx);
 return {data,writes,append,expected,next,event,fence,cas,defer,reboot,recover,failOnce:(p:(items:any)=>boolean)=>{fail=p;}};
}
{
 const f=await fixture(),before=f.data['chatgpt-journal:meta'].sequence;
 const result=await f.cas();assert.equal(result.ok,true);assert.deepEqual(f.data[goalKey],f.next);
 const atomic=f.writes.findLast(x=>x[goalKey]);assert.ok(atomic[goalKey]);assert.ok(atomic['chatgpt-journal:meta']);
 assert.ok(atomic['chatgpt-goal-cas:provisional'],'provisional receipt is committed atomically with Goal and journal');
 assert.equal(f.data['chatgpt-goal-cas:provisional'],null,'successful CAS resolves its provisional receipt before returning');
 assert.equal(atomic['chatgpt-journal:meta'].sequence,before+1,'Goal and journal are committed by one storage.set');
}
{
 const f=await fixture();f.data[goalKey].phase='paused';const before=structuredClone(f.data);
 await assert.rejects(()=>f.cas(),(e:any)=>e.code==='GOAL_FENCE_CHANGED');assert.deepEqual(f.data,before,'changed Goal is never overwritten');
}
{
 const f=await fixture();await f.append({kind:'request.started',sourceUrl:url,requestId:'later',eventAt:123456790},{id:8,url});const before=structuredClone(f.data);
 await assert.rejects(()=>f.cas(),(e:any)=>e.code==='GOAL_FENCE_CHANGED');assert.deepEqual(f.data,before,'newer cross-tab request refuses CAS without mutation');
}
{
 const f=await fixture();await f.append({kind:'request.started',sourceUrl:'https://chatgpt.com/',requestId:'unknown',eventAt:123456790},{id:8,url:'https://chatgpt.com/'});
 f.reboot();const before=structuredClone(f.data);await assert.rejects(()=>f.cas(),(e:any)=>e.code==='GOAL_FENCE_CHANGED');
 assert.deepEqual(f.data,before,'an unidentified request before enqueue remains a possible conflict after restart');
}
{
 const f=await fixture(),key='chatgpt-journal:event:'+String(f.fence.requestSequence).padStart(12,'0');delete f.data[key];const before=structuredClone(f.data);
 await assert.rejects(()=>f.cas(),(e:any)=>e.code==='GOAL_FENCE_CHANGED');assert.deepEqual(f.data,before,'a missing anchor cannot commit');
}
{
 const f=await fixture(),deferred=f.defer(x=>x[goalKey]?.phase==='completed');
 const completion=f.cas();await deferred.observed;
 const request=f.append({kind:'request.started',sourceUrl:url,requestId:'race',eventAt:123456790},{id:8,url});
 deferred.release();await assert.rejects(completion,(e:any)=>e.code==='GOAL_FENCE_CHANGED');await request;
 assert.deepEqual(f.data[goalKey],f.expected,'ingress during storage.set restores exactly the expected Goal');
 const events=Object.values(f.data).filter((x:any)=>x?.kind).sort((a:any,b:any)=>a.sequence-b.sequence) as any[];
 assert.deepEqual(events.slice(-3).map(x=>x.kind),['goal.answer_complete','goal.completion_rolled_back','request.started']);
}
{
 const f=await fixture(),next={...f.expected,queuedResumeFence:null,phase:'preparing',operation:{id:'op',tabId:7,status:'reserved',queuedResumeFence:f.fence}};
 await f.cas(next);f.data[goalKey]={...next,phase:'sending',operation:{...next.operation,status:'intent'}};
 await f.append({kind:'goal.send_intent',sourceUrl:url,goalId:'goal',operationId:'op',queuedResumeFence:f.fence});
 await f.append({kind:'request.started',sourceUrl:url,requestId:'cross-tab',eventAt:123456790},{id:8,url});
 await assert.rejects(()=>f.append({kind:'send.authorized',sourceUrl:url,operationId:'op'}),(e:any)=>e.code==='GOAL_FENCE_CHANGED');
 assert.notEqual(f.data['chatgpt-journal:meta'].active[7].consumed,true,'later same-chat request prevents the grant');
}
{
 const f=await fixture(),next={...f.expected,queuedResumeFence:null,phase:'preparing',operation:{id:'op',tabId:7,status:'reserved',queuedResumeFence:f.fence}};
 await f.cas(next);f.data[goalKey]={...next,phase:'sending',operation:{...next.operation,status:'intent'}};
 await f.append({kind:'goal.send_intent',sourceUrl:url,goalId:'goal',operationId:'op',queuedResumeFence:f.fence});
 const deferred=f.defer(x=>x['chatgpt-journal:meta']?.active?.[7]?.consumed===true);
 const grant=f.append({kind:'send.authorized',sourceUrl:url,operationId:'op'});await deferred.observed;
 const request=f.append({kind:'request.started',sourceUrl:url,requestId:'race',eventAt:123456790},{id:8,url});deferred.release();
 await assert.rejects(grant,(e:any)=>e.code==='GOAL_FENCE_CHANGED');await request;
 assert.equal(f.data['chatgpt-journal:meta'].active[7].consumed,true,'a grant whose result races ingress remains consumed and cannot be replayed');
}
{
 const f=await fixture(),next={...f.expected,queuedResumeFence:null,phase:'preparing',operation:{id:'op',tabId:7,status:'reserved',queuedResumeFence:f.fence}};
 await f.cas(next);f.data[goalKey]={...next,phase:'sending',operation:{...next.operation,status:'intent'}};
 await f.append({kind:'goal.send_intent',sourceUrl:url,goalId:'goal',operationId:'op',queuedResumeFence:f.fence});
 const deferred=f.defer(x=>x['chatgpt-journal:meta']?.active?.[7]?.consumed===true);
 const grant=f.append({kind:'send.authorized',sourceUrl:url,operationId:'op'});await deferred.observed;
 const unrelated=f.append({kind:'request.started',sourceUrl:'https://chatgpt.com/c/unrelated',requestId:'other',eventAt:123456790},{id:8,url:'https://chatgpt.com/c/unrelated'});
 deferred.release();assert.equal((await grant).ok,true,'an unrelated chat cannot cancel a protected grant');await unrelated;
}
{
 const f=await fixture(),next={...f.expected,queuedResumeFence:null,phase:'preparing',operation:{id:'op',tabId:7,status:'reserved',queuedResumeFence:f.fence}};
 await f.cas(next);f.data[goalKey]={...next,phase:'sending',operation:{...next.operation,status:'intent'}};
 await f.append({kind:'goal.send_intent',sourceUrl:url,goalId:'goal',operationId:'op',queuedResumeFence:f.fence});
 const deferred=f.defer(x=>x['chatgpt-journal:meta']?.active?.[7]?.consumed===true);
 const grant=f.append({kind:'send.authorized',sourceUrl:url,operationId:'op'});await deferred.observed;
 const unknown=f.append({kind:'request.started',sourceUrl:'https://chatgpt.com/',requestId:'unknown',eventAt:123456790},{id:8,url:'https://chatgpt.com/'});
 deferred.release();await assert.rejects(grant,(e:any)=>e.code==='GOAL_FENCE_CHANGED');await unknown;
}
{
 const f=await fixture(),next={...f.expected,queuedResumeFence:null,phase:'preparing',operation:{id:'op',tabId:7,status:'reserved',queuedResumeFence:f.fence}};
 await f.cas(next);f.data[goalKey]={...next,phase:'sending',operation:{...next.operation,tabId:8,status:'intent'}};
 const moved={id:8,url};await f.append({kind:'goal.send_intent',sourceUrl:url,goalId:'goal',operationId:'op',queuedResumeFence:f.fence},moved);
 assert.equal(f.data['chatgpt-journal:meta'].active[8].anchorTabId,7,'the request anchor remains on the original tab');
 assert.equal((await f.append({kind:'send.authorized',sourceUrl:url,operationId:'op'},moved)).ok,true,'a moved reservation may grant when no newer request exists');
}
{
 const f=await fixture(),next={...f.expected,queuedResumeFence:null,phase:'preparing',operation:{id:'op',tabId:7,status:'reserved',queuedResumeFence:f.fence}};
 await f.cas(next);f.data[goalKey]={...next,phase:'sending',operation:{...next.operation,tabId:8,status:'intent'}};
 const moved={id:8,url};await f.append({kind:'goal.send_intent',sourceUrl:url,goalId:'goal',operationId:'op',queuedResumeFence:f.fence},moved);
 const deferred=f.defer(x=>x['chatgpt-journal:meta']?.active?.[8]?.consumed===true);
 const grant=f.append({kind:'send.authorized',sourceUrl:url,operationId:'op'},moved);await deferred.observed;
 const newer=f.append({kind:'request.started',sourceUrl:'https://chatgpt.com/c/other',requestId:'old-tab-new',eventAt:123456790},{id:7,url:'https://chatgpt.com/c/other'});
 deferred.release();await assert.rejects(grant,(e:any)=>e.code==='GOAL_FENCE_CHANGED');await newer;
}
{
 const f=await fixture(),deferred=f.defer(x=>x[goalKey]?.phase==='completed',true);
 void f.cas();await deferred.observed;
 assert.ok(f.data['chatgpt-goal-cas:provisional'],'a crash after commit retains an atomic recovery receipt');
 f.reboot();const result=await f.recover();assert.equal(result.recovered,true);
 assert.deepEqual(f.data[goalKey],f.expected);assert.equal(f.data['chatgpt-goal-cas:provisional'],null);
 const last=f.data['chatgpt-journal:event:'+String(f.data['chatgpt-journal:meta'].sequence).padStart(12,'0')];
 assert.equal(last.kind,'goal.completion_rolled_back');assert.equal(last.previousSequence,f.fence.requestSequence+1);
 assert.equal((await f.recover()).recovered,false,'restart recovery is idempotent');
}
{
 const f=await fixture(),deferred=f.defer(x=>x[goalKey]?.phase==='completed',true);
 void f.cas();await deferred.observed;f.data[goalKey]={...f.next,phase:'paused'};const before=structuredClone(f.data);
 f.reboot();await assert.rejects(()=>f.recover(),(e:any)=>e.code==='GOAL_CAS_RECOVERY_UNCERTAIN');
 assert.deepEqual(f.data,before,'recovery cannot overwrite a Goal changed by another actor or discard its receipt');
}
{
 const f=await fixture();f.failOnce(x=>Object.hasOwn(x,'chatgpt-goal-cas:provisional')&&x['chatgpt-goal-cas:provisional']===null);
 await assert.rejects(()=>f.cas(),/Synthetic storage failure/);assert.ok(f.data['chatgpt-goal-cas:provisional']);
 f.reboot();assert.equal((await f.recover()).recovered,true);assert.deepEqual(f.data[goalKey],f.expected,'failed receipt cleanup is recovered on restart without replay');
}
{
 const f=await fixture();f.data['chatgpt-goal-cas:provisional']=false;const before=structuredClone(f.data);
 await assert.rejects(()=>f.recover(),(e:any)=>e.code==='GOAL_CAS_RECOVERY_UNCERTAIN');
 await assert.rejects(()=>f.cas(),(e:any)=>e.code==='GOAL_FENCE_CHANGED');
 assert.deepEqual(f.data,before,'a corrupt receipt cannot be mistaken for absence or discarded');
}
console.log('Goal journal CAS: atomic state, stale/cross-tab/gap fences and request ingress during commit/grant passed.');
