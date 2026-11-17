import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createContext,runInContext}from'node:vm';
const source=readFileSync('extension/service-worker.js','utf8'),start=source.indexOf('function retryConfirmationUnproven('),end=source.indexOf('const retryReadinessRecoveries=',start);assert.ok(start>0&&end>start);
const url='https://chatgpt.com/c/late-integration',promptKey='/c/late-integration|new',oldPrompt='/c/late-integration|old',op='late-op',request='new-request',attempt='120000';
async function fixture(variant:'ok'|'newer'|'stop'|'journal-race'|'manual-race'='ok') {
 const events:any[]=[{kind:'retry.planned',retryUserId:'old-user'},{kind:'send.authorized'},{kind:'send.dispatched',text:'Continue',recordedAt:103000},{kind:'retry.clicked'},{kind:'request.started',requestId:request,eventAt:120000},{kind:'request.completed',requestId:request,statusCode:200},{kind:'retry.failed',clicked:true,confirmed:false,error:'Не удалось подтвердить отправку'},{kind:'retry.finished',clicked:true,confirmed:false}].map((e,i)=>({tabId:7,sourceUrl:url,operationId:op,sequence:i+1,recordedAt:100000+i*1000,...e}));
 if(variant==='newer')events.push({kind:'request.started',tabId:7,sourceUrl:url,requestId:'newer',sequence:9,recordedAt:130000});
 const claim={operationId:op,tabId:7,sourceUrl:url,phase:'consumed',retryUserId:'old-user'};
 const state={blocked:true,terminal:false,reason:'Автопродолжение остановлено: Не удалось подтвердить отправку',blockedAttemptId:attempt,lastAttemptId:attempt,lastPromptKey:promptKey,failures:[],recentErrors:[]};
 const goal={id:'goal-id',url,goal:'Goal',rules:'',phase:'blocked',reason:'Восстановление запроса завершилось ошибкой',startedAt:90000,deadlineAt:500000,continuations:1,maxContinuations:30,maxMinutes:60,expectedPromptKey:oldPrompt,...(variant==='stop'?{stopRequested:true}:{})};
 const data:Record<string,any>={['chatgpt-goal:'+url]:goal,'chatgpt-journal:meta':{sequence:events.length,startedAt:90000,active:{},requests:{},tabs:{},retrySchema:1,retryByChat:{'late-integration':state},handoffSourceClaimSchema:1,handoffSourceClaims:{},retrySendClaimSchema:2,retrySendClaims:{claim},retryConsumedOperations:{[op]:1},retryReleasedOperations:{},retryPreparingByChat:{},retryDraftSchema:1,retryDraftByChat:{},retryDraftClaims:{}}};
 for(const e of events)data['chatgpt-journal:event:'+String(e.sequence).padStart(12,'0')]=e;
 const storage={get:async(keys:string|string[]|null)=>structuredClone(keys===null?data:Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]))),set:async(v:any)=>Object.assign(data,structuredClone(v))};
 const native={ok:true,isLatest:true,isReadOnly:false,generating:false,turnStatus:'complete',hasError:true,userId:'new-user',promptKey,userSentAtMs:103001,userText:'Continue'};
 const checkpoint={state:'active',url,requestId:request,startedAt:120000,httpCompleted:true,promptKey:''},receipt={operationId:op,requestId:request,startedAt:120000};
 function inspectCompletedTurn(){}function inspectChatError(){}function inspectObservedStreamStatus(){}function controlChatComposer(){}
 const chrome={runtime:{getManifest:()=>({version:'fixture'})},storage:{local:storage},tabs:{get:async()=>({id:7,url,status:'complete'})},scripting:{executeScript:async(o:any)=>[{result:o.func===inspectCompletedTurn?native:o.func===inspectChatError?{action:'retry',deliveryUserSentAtMs:103001}:o.func===inspectObservedStreamStatus?{ok:true}:o.func===controlChatComposer?{ok:true}:{attemptId:attempt,requestId:request}}]}};
 const ctx=createContext({URL,Number,Math,Date:class extends Date{static now(){return 130000}},console,chrome,inspectCompletedTurn,inspectChatError,inspectObservedStreamStatus,controlChatComposer,completionCheckpointRead:async()=>structuredClone(checkpoint),latestRequestReceipt:async()=>structuredClone(receipt)});
 for(const f of ['goal-policy','journal-store','goal-store'])runInContext(readFileSync('extension/'+f+'.js','utf8'),ctx);
 if(variant==='journal-race'||variant==='manual-race')runInContext(`{
   const original=appendJournal;let injected=false;
   appendJournal=async(event,tab)=>{if(event.kind==='retry.late_recovered'&&!injected){injected=true;
     await original({kind:${JSON.stringify(variant==='manual-race'?'request.started':'tab.snapshot')},sourceUrl:${JSON.stringify(url)},requestId:'racing-request'},tab);}
     return original(event,tab);};
 }`,ctx);
 runInContext('const goalController=ChatGPTGoalStore.create({storage:chrome.storage.local,tabs:chrome.tabs,appendJournal,now:()=>130000});',ctx);runInContext(source.slice(start,end),ctx);
 const recovered=await runInContext(`recoverLateRetry(7,${JSON.stringify(url)})`,ctx);return {data,recovered,ctx};
}
const valid=await fixture();assert.equal(valid.recovered.blocked,false);assert.equal(valid.data['chatgpt-goal:'+url].phase,'waiting');assert.equal(valid.data['chatgpt-goal:'+url].expectedPromptKey,promptKey);
const before=(valid.data['chatgpt-journal:meta'] as any).sequence;await runInContext(`recoverLateRetry(7,${JSON.stringify(url)})`,valid.ctx);assert.equal((valid.data['chatgpt-journal:meta'] as any).sequence,before,'late recovery is idempotent');
for(const variant of ['newer','stop'] as const){const f=await fixture(variant);assert.equal(f.recovered.blocked,true,variant);assert.equal((f.data['chatgpt-journal:meta'] as any).sequence,variant==='newer'?9:8,variant)}
const race=await fixture('journal-race');assert.equal(race.recovered.blocked,false,'an unrelated journal race is rechecked and safely recovered');
const manualRace=await fixture('manual-race');assert.equal(manualRace.recovered.blocked,true,'a newer manual request during the commit fence prevents recovery');
console.log('Late retry integration: actual journal/coordinator recover once; later user requests and Stop stay fenced.');
