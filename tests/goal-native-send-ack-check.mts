import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const url='https://chatgpt.com/c/native-ack-fixture',baseline='/c/native-ack-fixture|before',prompt='/c/native-ack-fixture|native-user';
const source=readFileSync('extension/service-worker.js','utf8');
const helper=source.slice(source.indexOf('async function confirmNativeGoalSend('),source.indexOf('async function bindNativeManualSupplement('));
type Value=Record<string,any>;
function fixture() {
 const text='Long goal with paragraphs\n\nOriginal objective, full link https://example.test/task\nAdditional user instructions';
 const data:Value={['chatgpt-goal:'+url]:{id:'goal',url,phase:'clicked',operation:{id:'operation',tabId:7,kind:'continuation',createdAt:1000,status:'clicked',baselineKey:baseline,text}}};
 let request:Value|null={requestId:'actual-request',startedAt:1100,url,operationId:'operation'},live=url,afterProbe:(()=>void)|null=null;
 let native:Value={ok:true,url,isLatest:true,isReadOnly:false,userId:'native-id',userSentAtMs:1100,userText:text,
  userVisibleText:'Long goal… Show more',promptKey:prompt};
 let proof:Value|null=null;
 const reports:Value[]=[],probes:Value[]=[],completions:Value[]=[];
 const context=createContext({URL,readGoalAckProof:async()=>proof,goalController:{report:async(value:Value)=>{reports.push(value);return {ok:true};},completion:async(value:Value)=>{completions.push(value);return {ok:true};}},
  latestRequestReceipt:async()=>structuredClone(request),inspectCompletedTurn:function(){},ChatGPTGoalPolicy:{canonical:(v:string)=>v===url?url:''},
  chrome:{storage:{local:{get:async(key:string)=>({[key]:structuredClone(data[key])})}},tabs:{get:async()=>({id:7,url:live})},
   scripting:{executeScript:async(options:Value)=>{probes.push(options);const result=structuredClone(native);afterProbe?.();return [{result}];}}}});
 runInContext(helper,context);
 const args={url,tabId:7,id:'goal',operationId:'operation',requestId:'actual-request',startedAt:1100};
 return {data,reports,probes,args,completions,setProof:(value:Value)=>{proof=value;},record:()=>data['chatgpt-goal:'+url],native,setRequest:(v:Value|null)=>{request=v;},route:(v:string)=>{live=v;},onProbe:(fn:()=>void)=>{afterProbe=fn;},run:(patch:Value={})=>{context.args={...args,...patch};return runInContext('confirmNativeGoalSend(args)',context) as Promise<Value>;}};
}
{
 const h=fixture();assert.equal((await h.run()).ok,true);assert.equal(h.reports.length,1);
 assert.equal(h.reports[0].newPromptKey,prompt);assert.equal(h.reports[0].status,'confirmed');
 assert.deepEqual(JSON.parse(JSON.stringify(h.probes[0].args)),[url,true]);
}
for(const patch of [{userText:'Wrong native text'},{userSentAtMs:-10000},{userId:''},{promptKey:baseline},{isLatest:false},{isReadOnly:true},{url:'https://chatgpt.com/c/other'}]) {
 const h=fixture();Object.assign(h.native,patch);assert.equal((await h.run()).ok,false);assert.equal(h.reports.length,0);
}
for(const request of [null,{requestId:'actual-request',startedAt:1100,url},{operationId:'new-manual-operation',requestId:'actual-request',startedAt:1100,url},
 {operationId:'operation',requestId:'other',startedAt:1100,url},{operationId:'operation',requestId:'actual-request',startedAt:900,url}]) {
 const h=fixture();h.setRequest(request);assert.equal((await h.run()).ok,false);assert.equal(h.reports.length,0);assert.equal(h.probes.length,0);
}
{
 const h=fixture();h.onProbe(()=>h.setRequest({requestId:'new-manual',startedAt:1200,url}));assert.equal((await h.run()).ok,false);assert.equal(h.reports.length,0,'a newer manual request with identical text cannot acknowledge the older consumed Goal operation');
}
for(const mutate of [(h:ReturnType<typeof fixture>)=>{h.record().operation.id='replaced';},(h:ReturnType<typeof fixture>)=>{h.record().operation.text='replaced';},
 (h:ReturnType<typeof fixture>)=>{h.record().phase='blocked';},(h:ReturnType<typeof fixture>)=>h.route('https://chatgpt.com/c/other')]) {
 const h=fixture();h.onProbe(()=>mutate(h));assert.equal((await h.run()).ok,false);assert.equal(h.reports.length,0);
}
{
 const h=fixture();h.native.userText='Long goal [link](https://example.test/task)';h.native.userVisibleText=h.record().operation.text;
 assert.equal((await h.run()).ok,true,'bound native visible text can prove a known rich serialization without consulting collapsed DOM');
}
// Correlation derives only from the worker's committed request-start event.
{
 const data:Value={};const ctx=createContext({chrome:{storage:{local:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:Value)=>Object.assign(data,structuredClone(v))}}}});
 runInContext(readFileSync('extension/request-receipts.js','utf8'),ctx);
 await runInContext(`rememberRequestReceipt(7,{requestId:'actual-request',startedAt:1100,receipt:{epoch:'fixture',order:1},url:${JSON.stringify(url)}})`,ctx);
 assert.equal(await runInContext("bindRequestOperationReceipt(7,'wrong',1100,'operation')",ctx),false);
 assert.equal(await runInContext("bindRequestOperationReceipt(7,'actual-request',1000,'operation')",ctx),false);
 assert.equal(await runInContext("bindRequestOperationReceipt(7,'actual-request',1100,'operation')",ctx),true);
 assert.equal(await runInContext("bindRequestOperationReceipt(7,'actual-request',1100,'other')",ctx),false);
 assert.equal((await runInContext("readRequestReceipt(7,{requestId:'actual-request'})",ctx)).operationId,'operation');
}
console.log('Native Goal send ACK: collapsed DOM independent, exact worker operation/request/time/user proof, late races and durable correlation passed.');

for(const change of [{manualStartedAt:1200},{manualPending:{requestId:'manual-newer'}}]) {
 const h=fixture();Object.assign(h.record(),change);assert.equal((await h.run()).ok,false);assert.equal(h.reports.length,0);
}
{
 const h=fixture();h.record().phase='blocked';h.native.userText='Native escaped [literal](https://example.test/task)';
 h.setProof({submittedText:h.native.userText,request:{requestId:'actual-request',startedAt:1100,url,operationId:'operation'}});
 h.setRequest(null);
 Object.assign(h.native,{turnStatus:'complete',generating:false,hasError:false,assistantCompleted:true,
  assistantPhase:'final_answer',assistantKey:'done',goalResponse:'GOAL_COMPLETE',goalRawExact:true});
 assert.equal((await h.run()).ok,true,'a durable actual serialization confirms the old click after its cache disappears');
 assert.equal(h.reports[0].nativeConfirmed,true);assert.equal(h.completions.length,1,'a completion that preceded ACK recovery is processed once by the coordinator');
}
{
 const h=fixture();h.record().phase='blocked';h.record().operation.status='reserved';
 assert.equal((await h.run()).ok,false);assert.equal(h.reports.length,0,'a blocked preparation has no proven click to acknowledge');
}
{
 const h=fixture();h.record().phase='blocked';h.native.userText='Changed URL https://example.test/wrong';
 h.setProof({submittedText:'Original URL https://example.test/task'});
 assert.equal((await h.run()).ok,false);assert.equal(h.reports.length,0,'receipt comparison is exact and does not discard link targets');
}
