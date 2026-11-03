import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const url='https://chatgpt.com/c/destination',source='https://chatgpt.com/c/source';
function setup(change:Record<string,any>={}){
 const handoff={id:'handoff-id',stage:'sent',sourceUrl:source,targetUrl:url,sendReceipt:{operationId:'handoff-id',submittedText:'EXACT PRIVATE PAYLOAD'},acceptance:{messageId:'user-id',entryId:'fallback-turn-0',targetUrl:url}};
 const storage:Record<string,any>={'chatgpt-status:migration':{schema:1},['chatgpt-status:'+url]:{url,revision:1,sequence:1,notifications:[],status:{kind:'loading',observed:true,eventAt:100,receipt:{epoch:'old',order:1}}},'chatgpt-handoff:7':handoff};
 let native={ok:true,url,userId:'user-id',promptKey:'/c/destination|fallback-turn-0:0:user',assistantKey:'fallback-turn-0:2:assistant',assistantId:'assistant-id',assistantPhase:'final_answer',assistantCompleted:true,turnStatus:'complete',isLatest:true,isReadOnly:false,generating:false,hasError:false,...change.native};
 if(change.status)Object.assign(storage['chatgpt-status:'+url],change.status);
 if(change.handoff)Object.assign(handoff,change.handoff);
 if(change.checkpoint)storage['chatgpt-completion-checkpoint:7']=change.checkpoint;
 const requests=new Map(),logs:any[]=[],broadcasts:any[]=[];let request:any=null;
 const context=createContext({URL,Date,Math,manualRequestReceiptsByTab:requests,
  latestRequestReceipt:async()=>request,
  handoffKey:(id:number)=>'chatgpt-handoff:'+id,
  inspectHandoffAcceptance:function inspectHandoffAcceptance(){},inspectCompletedTurn:function inspectCompletedTurn(){},
  journalInBackground:(event:unknown)=>logs.push(event),broadcastChatStatus:async(view:unknown)=>broadcasts.push(view),
  chrome:{storage:{local:{get:async(key:string)=>structuredClone({[key]:storage[key]}),set:async(values:Record<string,unknown>)=>{if(change.writeFailure&&Object.hasOwn(values,'chatgpt-status:'+url))throw Error('fixture storage refused');Object.assign(storage,structuredClone(values));}}},
   tabs:{get:async()=>({id:7,url:change.tabUrl||url})},scripting:{executeScript:async(options:any)=>{
    if(options.func.name==='inspectHandoffAcceptance')return [{result:{ok:true,accepted:options.args[0].submittedText==='EXACT PRIVATE PAYLOAD'&&!change.payloadMismatch,targetUrl:url,messageId:'user-id',entryId:'fallback-turn-0'}}];
    if(change.newRequest){request={startedAt:200};requests.set(7,request);}
    if(change.stopRace)runInContext('cancelLegacyHandoffStatus(7)',context);
    return [{result:native}];
   }}}});
 for(const file of ['handoff-title.js','status-store.js','completion-checkpoint.js','legacy-handoff-status.js'])runInContext(readFileSync('extension/'+file,'utf8'),context);
 return {storage,logs,broadcasts,run:()=>runInContext(`reconcileLegacyHandoffStatus(7,${JSON.stringify(url)})`,context) as Promise<any>};
}
const good=setup();const result=await good.run();
assert.equal(result.status.kind,'success');assert.equal(result.status.unread,false);assert.equal(result.revision,2);
assert.equal(good.broadcasts.length,1);assert.equal(good.logs[0].kind,'completion.legacy_handoff_reconciled');
assert.equal(good.storage['chatgpt-completion-checkpoint:7'],undefined,'legacy observation never invents a request checkpoint');
assert.equal(await good.run(),null,'terminal state makes reconciliation idempotent');
for(const bad of [{payloadMismatch:true},{native:{userId:'other-user'}},{tabUrl:source},{newRequest:true},{stopRace:true},
 {native:{generating:true}},{native:{assistantCompleted:false}},{native:{hasError:true}},
 {status:{loadingStoppedThrough:{epoch:'old',order:2}}},{status:{status:{kind:'success'}}},
 {checkpoint:{state:'active',url,startedAt:100}},{checkpoint:{state:'active',url:'https://chatgpt.com/',startedAt:101}},
 {handoff:{stage:'awaiting-confirmation'}}]){
 const fixture=setup(bad);assert.equal(await fixture.run(),null,JSON.stringify(bad));assert.equal(fixture.broadcasts.length,0);
}
const decorated=setup({tabUrl:url+'/?view=1#fragment',native:{promptKey:'/c/destination/|fallback-turn-0:0:user'}});
assert.equal((await decorated.run()).status.kind,'success','same-chat query/hash/trailing slash preserves exact accepted user identity');
const root=setup({checkpoint:{schema:1,state:'active',url:'https://chatgpt.com/',startedAt:100,requestId:'root-id'}});
assert.equal((await root.run()).status.kind,'success','only an exact root checkpoint plus independently confirmed handoff may be reconciled');
assert.equal(root.storage['chatgpt-completion-checkpoint:7'].state,'complete');
const storageFailure=setup({writeFailure:true});
await assert.rejects(storageFailure.run(),/fixture storage refused/);
assert.equal(storageFailure.logs.length,0,'a failed durable write must not journal a completed reconciliation');
assert.equal(storageFailure.broadcasts.length,0);
assert.equal(storageFailure.storage['chatgpt-status:'+url].status.kind,'loading');
console.log('Legacy handoff status: exact payload/native user, UI-only terminal, root allocation and request/stop/route/checkpoint fences passed.');
