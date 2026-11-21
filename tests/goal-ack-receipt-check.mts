import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const worker=readFileSync('extension/service-worker.js','utf8');
const source=worker.slice(worker.indexOf('const goalAckProofs='),worker.indexOf('async function confirmNativeGoalSend('));
const url='https://chatgpt.com/c/ack-receipt-fixture';
type V=Record<string,any>;
function fixture(){
 const op={id:'operation',text:'Literal [link](https://example.test/task)',createdAt:1000};
 const events:V[]=[{kind:'send.dispatched',operationId:op.id,tabId:7,sourceUrl:url,requestedText:op.text,text:'Native serialization'},
 {kind:'request.started',operationId:op.id,tabId:7,sourceUrl:url,requestId:'request',eventAt:1100}];
 let reads=0;
 const ctx=createContext({readJournal:async()=>{reads++;return {events:structuredClone(events)};}});
 runInContext(source,ctx);ctx.op=op;
 return {op,events,reads:()=>reads,proof:()=>runInContext(`readGoalAckProof(7,'${url}',op)`,ctx)};
}
{
 const h=fixture(),proof=await h.proof();
 assert.equal(proof.submittedText,'Native serialization');assert.equal(proof.request.operationId,'operation');
 assert.equal(proof.request.startedAt,1100);await h.proof();assert.equal(h.reads(),1,'immutable receipt is cached without repeatedly loading the full journal');
 h.op.text='Different payload';assert.equal(await h.proof(),null,'same operation ID cannot carry another requested payload');
}
for(const kind of ['duplicate-send','duplicate-request','other-tab','other-url','other-operation','wrong-requested-text','older-request']){
 const h=fixture();
 if(kind==='duplicate-send')h.events.push({...h.events[0]});
 if(kind==='duplicate-request')h.events.push({...h.events[1],requestId:'another'});
 if(kind==='other-tab')h.events[0].tabId=8;
 if(kind==='other-url')h.events[0].sourceUrl='https://chatgpt.com/c/other';
 if(kind==='other-operation')h.events[1].operationId='other';
 if(kind==='wrong-requested-text')h.events[0].requestedText='Another';
 if(kind==='older-request')h.events[1].eventAt=900;
 assert.equal(await h.proof(),null,kind);
}
// A blocked receipt needs positive native proof; accepting it only clears the
// old consumed operation and never dispatches another message by itself.
{
 const data:V={},events:V[]=[],sent:V[]=[];
 const ctx=createContext({URL,console});
 for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),ctx);
 ctx.dependencies={storage:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>Object.assign(data,structuredClone(v))},
  tabs:{get:async()=>({id:7,url}),sendMessage:async(id:number,m:V)=>{sent.push(m);return {ok:true};}},appendJournal:async(e:V)=>{events.push(e);return {ok:true};},now:()=>1000,uuid:()=> 'goal'};
 const store=runInContext('ChatGPTGoalStore.create(dependencies)',ctx);
 await store.start({url,tabId:7,goal:'Test goal',maxContinuations:10,maxMinutes:1440});
 const g=data['chatgpt-goal:'+url],op=g.operation;
 await store.intent({url,tabId:7,id:g.id,operationId:op.id,text:op.text,baselineKey:'/c/ack-receipt-fixture|before'});
 await store.report({url,tabId:7,id:g.id,operationId:op.id,status:'clicked'});
 await store.report({url,tabId:7,id:g.id,operationId:op.id,status:'blocked',reason:'Unknown click outcome'});
 const args={url,tabId:7,id:g.id,operationId:op.id,status:'confirmed',newPromptKey:'/c/ack-receipt-fixture|accepted'};
 assert.equal((await store.report(args)).ok,false);
 const before=sent.length;assert.equal((await store.report({...args,nativeConfirmed:true})).ok,true);
 assert.equal(data['chatgpt-goal:'+url].phase,'waiting');assert.equal(data['chatgpt-goal:'+url].operation,null);
 assert.equal(sent.length,before);
 const snapshot=structuredClone(data),eventCount=events.length;
 const repeated=await store.report({...args,nativeConfirmed:true});
 assert.equal(repeated.ok,true);assert.equal(repeated.alreadyConfirmed,true,'the exact spent operation receives an idempotent acknowledgement');
 assert.deepEqual(data,snapshot);assert.equal(events.length,eventCount,'duplicate acknowledgement does not write history again');
 for(const changed of [{id:'other-goal'},{operationId:'other-operation'},{tabId:8},{url:'https://chatgpt.com/c/other'}])
  assert.equal((await store.report({...args,...changed,nativeConfirmed:true})).ok,false,'another operation, owner or chat cannot reuse confirmation');
}
console.log('Goal ACK receipts: immutable native serialization, unique operation/request/URL/tab evidence, bounded cache and guarded blocked confirmation passed.');
{
 const h=fixture();h.events[0].recordedAt=3000;
 h.events.push({kind:'send.authorized',tabId:7,sourceUrl:url,operationId:h.op.id,recordedAt:2000});
 assert.deepEqual(JSON.parse(JSON.stringify((await h.proof()).sendWindow)),{notBefore:2000,notAfter:3000});
}
for(const scenario of ['duplicate-grant','grant-before-operation','dispatch-before-grant','missing-time']) {
 const h=fixture();h.events[0].recordedAt=3000;
 h.events.push({kind:'send.authorized',tabId:7,sourceUrl:url,operationId:h.op.id,recordedAt:2000});
 if(scenario==='duplicate-grant')h.events.push({...h.events[2]});
 if(scenario==='grant-before-operation')h.events[2].recordedAt=900;
 if(scenario==='dispatch-before-grant')h.events[0].recordedAt=1500;
 if(scenario==='missing-time')delete h.events[2].recordedAt;
 assert.equal((await h.proof()).sendWindow,null,scenario);
}

// Both ACK sources may queue while clicked. Only the first confirmation may
// commit and process the early final reply; the loser must still restore drafts.
{
 const data:V={},events:V[]=[],sent:V[]=[];let writes=0;
 const ctx=createContext({URL,console});
 for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),ctx);
 ctx.dependencies={storage:{get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:V)=>{writes++;Object.assign(data,structuredClone(v));}},
  tabs:{get:async()=>({id:7,url}),sendMessage:async(id:number,m:V)=>{sent.push(m);return {ok:true};}},
  appendJournal:async(e:V)=>{events.push(e);return {ok:true};},now:()=>1000,uuid:()=> 'racing-goal'};
 const store=runInContext('ChatGPTGoalStore.create(dependencies)',ctx);
 await store.start({url,tabId:7,goal:'Synthetic race goal',maxContinuations:10,maxMinutes:1440});
 const goal=data['chatgpt-goal:'+url],op=goal.operation,promptKey='/c/ack-receipt-fixture|accepted';
 await store.intent({url,tabId:7,id:goal.id,operationId:op.id,text:op.text,baselineKey:'/c/ack-receipt-fixture|before'});
 await store.report({url,tabId:7,id:goal.id,operationId:op.id,status:'clicked'});
 await store.completion({url,tabId:7,promptKey,completionKey:promptKey+'|answer',response:'GOAL_COMPLETE',
  nativeVerified:true,rawExact:true,userId:'native-user'});
 const beforeWrites=writes,beforeSends=sent.length;
 const ack={url,tabId:7,id:goal.id,operationId:op.id,status:'confirmed',newPromptKey:promptKey,nativeConfirmed:true};
 const results=await Promise.all([store.report(ack),store.report(ack)]);
 assert.equal(results.every(result=>result.ok),true,'both racing observers receive a successful ACK');
 assert.equal(results.filter(result=>result.alreadyConfirmed).length,1);
 assert.equal(events.filter(event=>event.kind==='goal.confirmed').length,1);
 assert.equal(events.filter(event=>event.kind==='goal.answer_complete').length,1,'the staged answer is processed once');
 assert.equal(writes-beforeWrites,2,'only confirmation and answer completion are persisted');
 assert.equal(data['chatgpt-goal:'+url].phase,'completed');assert.equal(sent.length,beforeSends);
}
