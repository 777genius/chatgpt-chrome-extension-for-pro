import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('extension/service-worker.js','utf8');
const code=source.slice(source.indexOf('async function proveInactiveRecoveryIdle('),source.indexOf('const goalAckProofs=new Map();'));
const url='https://chatgpt.com/c/idle-recovery-fixture';
async function fixture(extra:any={}){
 const message={attemptId:'1000000',requestId:'request',promptKey:'/c/idle-recovery-fixture|user',alertIndex:0,recoveryBinding:{kind:'user',userId:'user'}};
 const cp={state:'active',url,promptKey:message.promptKey,startedAt:1000000,requestId:'request',requestFailedAt:1000100,...extra.checkpoint};
 const native={ok:true,isLatest:true,isReadOnly:false,hasError:true,generating:false,nativeConversationInactive:true,promptKey:message.promptKey,userId:'user',lastUserSentAtMs:999990,...extra.native};
 const receipt={requestId:'request'};let reads=0,probes=0;
 function controlChatComposer(){}function inspectChatError(){}
 const chrome={tabs:{get:async()=>({url:extra.url||url})},scripting:{executeScript:async(o:any)=>{probes++;return [{result:o.func===controlChatComposer?{ok:extra.editor!==false}:{needsIdleProof:extra.fresh!==false,editorSubmitIdle:extra.freshSubmitIdle===true}}];}}};
 const fn=new Function('completionCheckpointRead','inspectBoundNativeTurn','chrome','controlChatComposer','inspectChatError','latestRequestReceipt',code+';return proveInactiveRecoveryIdle;')(
  async()=>++reads>1&&extra.race?{...cp,requestId:'new'}:cp,async()=>native,chrome,controlChatComposer,inspectChatError,async()=>extra.requestRace?{}:receipt);
 return {result:await fn(7,url,{...message,...extra.message},receipt,extra.surfaceProof||{}),probes};
}
assert.equal((await fixture()).result.proof,'native-inactive-error-editor','a plain draft does not require the voice button');
for(const extra of [{checkpoint:{requestFailedAt:undefined,httpCompleted:false}},
 {native:{generating:true}},{native:{nativeConversationInactive:false}},{native:{hasError:false}},
 {native:{userId:'other'}},{native:{promptKey:'other'}},{native:{isReadOnly:true}},
 {checkpoint:{requestId:'other'}},{editor:false},{fresh:false},{race:true},{requestRace:true},
 {message:{recoveryBinding:{kind:'assistant-only'}}},{url:'https://chatgpt.com/c/other'}])
 assert.equal((await fixture(extra)).result,null,JSON.stringify(extra));
assert.equal((await fixture({checkpoint:{requestFailedAt:undefined,httpCompleted:true}})).result.idle,true);
console.log('Inactive recovery: terminal transport, exact native user/request/controller, fresh surface and race fences; no Stop/Send effects.');

assert.equal((await fixture({native:{nativeConversationInactive:false},surfaceProof:{editorSubmitIdle:true},freshSubmitIdle:true})).result.idle,true,'exact terminal error plus native draft Send readiness is an idle proof');
assert.equal((await fixture({native:{nativeConversationInactive:false},surfaceProof:{editorSubmitIdle:true}})).result,null,'native Send readiness must still be present on the fresh error surface');
