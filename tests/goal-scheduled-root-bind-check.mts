import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Exercise the worker binder and its real scheduled root recovery, not merely
// the isolated trace helper. A retained original request can be current while
// assistant-only turns make the ordinary root probe return messages-missing.
// Scheduled fallback supplies user identity only: it must not certify completion.
const worker=readFileSync('extension/service-worker.js','utf8');
const start=worker.indexOf('async function recoverNativeComposerGoal(');
const end=worker.indexOf('async function inspectBoundNativeTurn(',start);
assert.ok(start>0&&end>start);
const source=worker.slice(start,end);
const root='https://chatgpt.com/',url='https://chatgpt.com/c/scheduled-recovery';
const now=Date.now(),eventAt=now-40000,startedAt=eventAt+200;
type Variant='scheduled'|'missing-history'|'changed-composer'|'saved-chat'|'other-probe';
async function run(variant:Variant) {
 const rootIntent=variant!=='saved-chat';
 const pending:any={
   id:'arm',phase:'intent',url:rootIntent?root:url,
   intent:{eventAt,text:'Original objective',baselineKey:rootIntent?'':'/c/scheduled-recovery|old'},
   request:{requestId:'original-request',startedAt,url:rootIntent?root:url,
     submission:{userId:'native-user',userText:'Original objective'}}
 };
 const receipt={requestId:'original-request',startedAt};
 const user={userId:'native-user',userText:'Original objective',userSentAtMs:startedAt,
   promptKey:'/c/scheduled-recovery|native-user'};
 const native:any={ok:true,url,isLatest:true,isReadOnly:false,...user,
   userVisibleText:user.userText,recoveryTimeline:[user],firstTurn:false};
 if(variant==='missing-history')native.recoveryTimeline=[];
 const events:any[]=[
   {kind:'request.started',tabId:7,sourceUrl:rootIntent?root:url,
     requestId:receipt.requestId,eventAt:startedAt,sequence:1},
   {kind:'tab.updated',tabId:7,changes:{url},sequence:2}
 ];
 const calls:string[]=[],scheduledFlags:boolean[]=[];
 let probeCount=0,composerReads=0;
 const ctx=createContext({URL,Date,JSON,Number,Math,inspectCompletedTurn:()=>{},
   latestRequestReceipt:async()=>structuredClone(receipt),
   readJournal:async()=>({ok:true,storageError:'',events:structuredClone(events),meta:{sequence:2}}),
   chrome:{
     tabs:{get:async()=>({url})},
     scripting:{executeScript:async({args}:any)=>{
       probeCount++;
       if(args.length===2)return[{result:variant==='other-probe'?{ok:false,reason:'native-turn-missing'}:
         {ok:false,reason:'bound-messages-missing'}}];
       scheduledFlags.push(args.at(-1)===true);
       return[{result:{...structuredClone(native),isLatest:!Number.isFinite(args[3])}}];
     }}
   },
   goalController:{
     composerGet:async()=>{composerReads++;return structuredClone(
       variant==='changed-composer'&&composerReads>=2?{...pending,phase:'armed'}:pending);},
     composerObserveOrigin:async()=>{calls.push('observe');return{ok:true};},
     composerBind:async()=>{calls.push('bind');return{ok:true,record:{phase:'bound'}};},
     completion:async()=>{calls.push('complete');return{ok:true};},
     get:async()=>({id:'arm',phase:'completed'})
   }
 });
 for(const name of ['goal-policy.js','goal-lineage.js'])
   runInContext(readFileSync('extension/'+name,'utf8'),ctx);
 runInContext(source,ctx);
 ctx.url=url;
 const result=await runInContext('bindNativeComposerGoal(7,url,"arm")',ctx);
 return{result,calls,scheduledFlags,probeCount};
}
{
 const f=await run('scheduled');
 assert.equal(f.result.ok,true);
 assert.deepEqual(f.calls,['bind'],
   'the scheduled tail proves original identity only: no false native ACK or Goal completion');
 assert.deepEqual(f.scheduledFlags,[true,true],
   'both recovery probes inspect the exact scheduled native turn');
 assert.equal(f.probeCount,3,'ordinary probe fails before two scheduled recovery inspections');
}
for(const variant of ['missing-history','changed-composer','saved-chat','other-probe'] as const){
 const f=await run(variant);
 assert.equal(f.result.pending,true,variant);
 assert.equal(f.calls.includes('bind'),false,variant);
 assert.equal(f.calls.includes('complete'),false,variant);
 // Missing history also invokes the independent submitted-body restoration
 // probe; it must still refuse binding and completion.
 assert.equal(f.probeCount,variant==='saved-chat'||variant==='other-probe'?1:3,variant);
}
console.log('Scheduled root Goal binding: unchanged receipt, identity-only assistant tail, no false completion, history and disarm fences passed.');
