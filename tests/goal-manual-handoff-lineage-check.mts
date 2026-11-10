import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const context=createContext({URL});
for(const file of ['goal-policy.js','goal-lineage.js'])runInContext(readFileSync('extension/'+file,'utf8'),context);
const lineage=runInContext('ChatGPTGoalLineage',context);
const a='https://chatgpt.com/c/source',b='https://chatgpt.com/c/manual',c='https://chatgpt.com/c/next';
const rows=[
 {kind:'handoff.navigating',sourceUrl:a,operationId:'first'},
 {kind:'handoff.failed',sourceUrl:a,operationId:'first',reason:'Не удалось дождаться готовности нового чата'},
 {kind:'request.started',sourceUrl:'https://chatgpt.com/',operationId:null,requestId:'manual',eventAt:1000},
 {kind:'tab.updated',changes:{url:b},operationId:null},
 {kind:'handoff.navigating',sourceUrl:b,operationId:'second'},
 {kind:'request.started',sourceUrl:'https://chatgpt.com/',operationId:'second',requestId:'second-request'},
 {kind:'tab.updated',changes:{url:c},operationId:'second'},
 {kind:'handoff.sent',sourceUrl:b,targetUrl:c,operationId:'second'}
].map((event,i)=>({...event,tabId:7,sequence:i+1}));
const trace=(events:any[])=>lineage.traceManualSuccessor(events,7,a,'first');
const proof=trace(rows);assert.equal(proof.firstTargetUrl,b);assert.equal(proof.targetUrl,c);assert.equal(proof.manualRequestId,'manual');
for(const change of [
 (e:any[])=>e.splice(1,0,{kind:'send.dispatched',tabId:7,operationId:'first',sequence:1.5}),
 (e:any[])=>{e[2].operationId='other';},
 (e:any[])=>{e[3].operationId='other';},
 (e:any[])=>{e[4].sourceUrl=a;},
 (e:any[])=>{e.pop();},
 (e:any[])=>e.push({...e[7],sequence:9}),
 (e:any[])=>{e[5].operationId='foreign';},
 (e:any[])=>{e[6].operationId='foreign';},
 (e:any[])=>{e[1].reason='Other failure';}
]) {const copy=structuredClone(rows);change(copy);assert.equal(trace(copy),null);}
assert.equal(lineage.traceManualSuccessor(rows,8,a,'first'),null);
const bridged=[
 {kind:'request.started',sourceUrl:'https://chatgpt.com/',operationId:null,requestId:'initial',eventAt:500},
 {kind:'tab.updated',changes:{url:a},operationId:null},...rows
].map((e,i)=>({...e,tabId:7,sequence:i+1}));
const explicit=(events:any[])=>lineage.traceExplicitManualBridge(events,7,{requestId:'initial',startedAt:500});
const restored=explicit(bridged);assert.equal(restored.originUrl,a);assert.equal(restored.targetUrl,c);
assert.equal(restored.handoffs[0].manualBridge,true);assert.equal(restored.handoffs[0].requestId,'manual');
for(const mutate of [
 (e:any[])=>e.splice(3,0,{kind:'send.dispatched',tabId:7,operationId:'first',sequence:3.5}),
 (e:any[])=>e.push({kind:'request.started',tabId:7,sourceUrl:'https://chatgpt.com/',requestId:'foreign',operationId:null,sequence:99}),
 (e:any[])=>e.push({kind:'tab.updated',tabId:7,changes:{url:'https://chatgpt.com/c/unrelated'},sequence:99}),
 (e:any[])=>{e[1].changes.url='https://chatgpt.com/c/unrelated';},
 (e:any[])=>{e[4].operationId='other';}
]) {const copy=structuredClone(bridged);mutate(copy);assert.equal(explicit(copy),null);}
assert.equal(lineage.traceExplicitManualBridge(bridged,7,{requestId:'initial',startedAt:501}),null);
console.log('Manual handoff lineage: no-click failure, manual allocation, accepted successor and ambiguity fences passed.');
