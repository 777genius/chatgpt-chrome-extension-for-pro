import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/service-worker.js','utf8');
const code=source.slice(source.indexOf('async function restoreAcceptedRetryDraft('),source.indexOf('const retryReadinessRecoveries='));
const url='https://chatgpt.com/c/accepted',op='operation',prefix='chatgpt-journal:event:';
async function fixture(variant='ok') {
 const kinds=['retry.planned','draft.saved','draft.replaced','send.authorized','send.dispatched','request.started','retry.clicked','request.failed','completion.confirmed','retry.failed','retry.finished'];
 const rows=kinds.map((kind,i)=>({kind,sequence:100001+i,sourceUrl:url,tabId:7,operationId:op,...(kind==='send.dispatched'?{text:'retry'}:{}),
  ...(kind==='draft.saved'?{draft:'private',text:'retry'}:{}),...(kind==='request.started'?{requestId:'12540',eventAt:1000}:{}),...(kind==='retry.failed'?{clicked:true,confirmed:false,errorCode:'RETRY_CONFIRMATION_UNPROVEN'}:{}),
  ...(kind==='retry.finished'?{clicked:true,confirmed:false}:{})})) as any[];
 const checkpointMode=variant.startsWith('checkpoint');
 if(checkpointMode) {
  const pos=rows.findIndex((e:any)=>e.kind==='completion.confirmed');
  rows.splice(pos,0,{kind:'completion.bound',sourceUrl:url,tabId:7,startedAt:1000,promptKey:'/c/accepted|native'});
  Object.assign(rows.find((e:any)=>e.kind==='completion.confirmed'),{startedAt:1000,promptKey:'/c/accepted|native',assistantKey:'assistant-key',proof:'native-final'});
  if(variant==='checkpoint-duplicate')rows.splice(pos+2,0,{...rows[pos+1]});
  if(variant==='checkpoint-stop')rows.push({kind:'goal.stop_requested',sourceUrl:url,tabId:7});
  rows.forEach((row:any,i:number)=>row.sequence=100001+i);
 }
 if(['two-saves','old-pointer','mismatched-save'].includes(variant)) {
  rows.splice(2,0,{...rows[1],sequence:100003,draft:'private'});
  rows.forEach((row:any,i:number)=>row.sequence=100001+i);
 }
 if(variant==='request-first'||variant==='request-before-grant') {
  const a=rows.find((e:any)=>e.kind==='request.started'),b=rows.find((e:any)=>e.kind=== (variant==='request-first'?'send.dispatched':'send.authorized'));
  [a.sequence,b.sequence]=[b.sequence,a.sequence];rows.sort((a:any,b:any)=>a.sequence-b.sequence);
 }
 if(variant==='later'||variant==='unknown')rows.push({kind:'request.started',sequence:100012,sourceUrl:variant==='later'?url:'https://chatgpt.com/',tabId:8});
 if(variant==='gap')rows.splice(2,1);
 const meta:any={sequence:variant==='gap'?100011:rows.at(-1)!.sequence,active:{},retryPreparingByChat:{[url]:{operationId:op,tabId:7,claimKey:'claim',plannedSequence:100001}},retrySendClaims:{claim:{operationId:op,tabId:7,sourceUrl:url,phase:'consumed'}},retryConsumedOperations:{[op]:100004}};
 const draft:any={phase:'unknown',operationId:op,savedSequence:['two-saves','mismatched-save'].includes(variant)?100003:100002,replacementProven:true,retryText:'retry',draft:variant==='mismatched-save'?'other':'private'};
 let receipt:any=checkpointMode?null:{operationId:op,requestId:'12540',startedAt:1000,url:'',submittedUserId:variant==='wrong-user'?'different':'user'};
 const checkpoint:any={state:'complete',url,requestId:'12540',startedAt:1000,nativeUserId:'user',nativeUserSentAtMs:999,promptKey:'/c/accepted|native'};
 if(variant==='checkpoint-user')checkpoint.nativeUserId='other';if(variant==='checkpoint-time')checkpoint.nativeUserSentAtMs=998;
 if(variant==='checkpoint-request')checkpoint.requestId='other';if(variant==='checkpoint-prompt')checkpoint.promptKey='other';
 const native:any={ok:true,isLatest:true,isReadOnly:false,hasError:false,generating:false,turnStatus:'complete',assistantCompleted:true,assistantPhase:'final_answer',assistantId:'answer',assistantKey:'assistant-key',promptKey:'/c/accepted|native',userId:'user',userSentAtMs:999,userText:'retry'};
 if(variant==='not-final')native.assistantCompleted=false;if(variant==='generating')native.generating=true;
 let inserts=0,receiptReads=0,checkpointReads=0;const writes:any[]=[];function inspectCompletedTurn(){}function controlChatComposer(){}
 const values:any={'chatgpt-journal:meta':meta};for(const row of rows)values[prefix+String(row.sequence).padStart(12,'0')]=row;
 const chrome={storage:{local:{get:async(k:any)=>structuredClone(Array.isArray(k)?Object.fromEntries(k.map((x:string)=>[x,values[x]])):{[k]:values[k]})}},
 tabs:{get:async()=>({id:7,url})},scripting:{executeScript:async(o:any)=>{if(o.func===inspectCompletedTurn)return [{result:native}];
 if(o.args[0].action==='inspect-plain-retry-draft')return [{result:{ok:variant!=='editor-busy',matches:variant!=='editor-busy'}}];
 if(variant==='editor-race')return [{result:{ok:false}}];inserts++;return [{result:{ok:true}}];}}};
 const ctx=createContext({chrome,URL,Number,JSON,inspectCompletedTurn,controlChatComposer,journalFailure:variant==='journal-failure'?'failure':'',JOURNAL_META:'chatgpt-journal:meta',JOURNAL_PREFIX:prefix,RETRY_MIGRATION_BATCH_SIZE:50,
 retryDraftUrl:(x:string)=>x?.startsWith('https://chatgpt.com/c/')?x:null,readRetryDraft:async()=>structuredClone(draft),latestRequestReceipt:async()=>{receiptReads++;return variant==='checkpoint-receipt-race'&&receiptReads>1?{requestId:'new'}:structuredClone(receipt)},
 completionCheckpointRead:async()=>{checkpointReads++;return variant==='checkpoint-race'&&checkpointReads>1?{...checkpoint,requestId:'new'}:structuredClone(checkpoint)},
 appendJournal:async(e:any)=>{if(variant==='journal-race')throw Error('changed');writes.push(e);}});
 runInContext(code,ctx);const ok=await runInContext(`restoreAcceptedRetryDraft(7,${JSON.stringify(url)})`,ctx);return {ok,inserts,writes};
}
const good=await fixture();assert.equal(good.ok,true);assert.equal(good.inserts,1);assert.deepEqual(good.writes.map((x:any)=>x.kind),['draft.restore_intent','draft.restored']);
assert.equal((await fixture('checkpoint-ok')).inserts,1,'durable exact checkpoint and native-final binding survive lost receipt');
for(const v of ['checkpoint-user','checkpoint-time','checkpoint-request','checkpoint-prompt','checkpoint-duplicate','checkpoint-stop','checkpoint-receipt-race','checkpoint-race'])assert.equal((await fixture(v)).inserts,0,v);
assert.equal((await fixture('two-saves')).inserts,1,'the exact latest saved sequence is accepted when an earlier backup exists');
assert.equal((await fixture('request-first')).inserts,1,'network request can be recorded before send.dispatched');
for(const v of ['old-pointer','mismatched-save','journal-failure','request-before-grant','later','unknown','gap','wrong-user','not-final','generating','editor-busy','editor-race','journal-race'])assert.equal((await fixture(v)).inserts,0,v);
console.log('Accepted retry: exact native and receipt proof restores saved draft once without replay.');
