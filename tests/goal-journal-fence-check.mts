import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const storage:Record<string,any>={};
const local={
  get:async(keys:string|string[]|null)=>{
    const names=keys===null?Object.keys(storage):Array.isArray(keys)?keys:[keys];
    return structuredClone(Object.fromEntries(names.map(key=>[key,storage[key]])));
  },
  set:async(values:Record<string,unknown>)=>Object.assign(storage,structuredClone(values))
};
const sandbox=createContext({URL,Date,console,
  chrome:{storage:{local},runtime:{getManifest:()=>({version:'test'})}}});
runInContext(readFileSync('extension/journal-store.js','utf8'),sandbox);
const api=runInContext('({appendJournal,readJournal})',sandbox) as {
  appendJournal:(event:Record<string,unknown>,tab:Record<string,unknown>)=>Promise<any>;
  readJournal:()=>Promise<any>;
};
const url='https://chatgpt.com/c/goal-fence';
const other='https://chatgpt.com/c/unrelated';
const log=(kind:string,operationId:string,tabId:number,sourceUrl=url,extra:Record<string,unknown>={})=>
  api.appendJournal({kind,operationId,sourceUrl,...extra},{id:tabId,url:sourceUrl});

// Goal and retry share a chat-level preparation window. Neither mode may
// begin while the other's durable claim is active.
const goalFirst='https://chatgpt.com/c/goal-first';
storage['chatgpt-goal:'+goalFirst]={id:'g-first',phase:'preparing',
  operation:{id:'g-op',status:'reserved',tabId:7}};
await assert.rejects(()=>log('retry.planned','legacy-after-goal',8,goalFirst,
  {promptKey:'/c/goal-first|previous'}),/Автоповтор/);
assert.equal(storage['chatgpt-journal:meta']?.retryPreparingByChat?.[goalFirst],undefined);
delete storage['chatgpt-goal:'+goalFirst];

const retryFirst='https://chatgpt.com/c/retry-first';
await log('retry.planned','legacy-first',8,retryFirst,
  {promptKey:'/c/retry-first|previous'});
await assert.rejects(()=>log('goal.started','goal-after-retry',7,retryFirst,
  {goalId:'pending-goal'}),/автоматическая отправка/);
await log('retry.finished','legacy-first',8,retryFirst,{clicked:false,confirmed:false});
assert.equal((await log('goal.started','goal-after-retry',7,retryFirst,
  {goalId:'pending-goal'})).ok,true);

// Simulate the intentional crash window: Goal state was persisted but its
// journal grant was not. Another tab still must not obtain a retry grant.
storage['chatgpt-goal:'+url]={id:'goal-fixture',phase:'sending',
  operation:{id:'unacknowledged',status:'intent'}};
await assert.rejects(()=>log('retry.send_intent','race-after-crash',8,url,
  {promptKey:'/c/goal-fence|previous'}),
  /Автоповтор/);
delete storage['chatgpt-goal:'+url];

await log('goal.send_intent','goal-1',7);
const meta=()=>storage['chatgpt-journal:meta'];
assert.equal(meta().active[7].chatUrl,url);
await assert.rejects(()=>log('retry.send_intent','retry-2',8),/незавершённая/);
await assert.rejects(()=>log('goal.send_intent','goal-3',8),/незавершённая/);
await assert.rejects(()=>log('handoff.sending','handoff-4',8,url,{targetUrl:url}),/незавершённая/);
assert.equal((await log('retry.send_intent','other-chat',9,other)).ok,true,
  'an unrelated conversation can still progress');
// Closing a tab is not proof the previous Goal send did not go through.
await api.appendJournal({kind:'tab.closed',tabId:7,sourceUrl:url},{id:7,url});
assert.equal(meta().active[7].operationId,'goal-1');
await assert.rejects(()=>log('retry.send_intent','retry-5',10),/незавершённая/);
await log('goal.blocked','goal-1',7,url,{reason:'Lost click acknowledgement'});
await assert.rejects(()=>log('retry.send_intent','retry-6',8),/незавершённая/);
await log('goal.confirmed','goal-1',7,url,{promptKey:'/c/goal-fence|goal-user'});
assert.equal(meta().active[7],undefined,'only the same exact confirmed operation frees its lock');
assert.equal((await log('retry.send_intent','retry-7',8)).ok,true,
  'a confirmed operation releases the conversation-level lock');
await assert.rejects(()=>log('retry.send_intent','retry-8',8),/незавершённая/);
await log('retry.failed','retry-7',8,url,{clicked:false});
assert.equal(meta().active[8],undefined);
assert.equal((await log('retry.send_intent','retry-9',8)).ok,true);
assert.equal((await api.readJournal()).events.some((e:any)=>
  e.kind==='goal.confirmed'&&e.operationId==='goal-1'),true);
console.log('Journal: cross-tab Goal fences, tab-close uncertainty, exact grant clearing and unrelated chats passed.');
// Reopened-tab acknowledgement must release the old owner through the same
// normal confirmed event, not just change the Goal's UI state.
for(const f of ['goal-policy.js','goal-store.js'])runInContext(readFileSync('extension/'+f,'utf8'),sandbox);
sandbox.deps={storage:local,tabs:{get:async()=>({id:17,url:'https://chatgpt.com/c/reopened-fence'}),sendMessage:async()=>({ok:true})},
 appendJournal:api.appendJournal,now:()=>1000,uuid:()=> 'reopened-operation'};
const store=runInContext('ChatGPTGoalStore.create(deps)',sandbox);
const reopened='https://chatgpt.com/c/reopened-fence';
await store.start({url:reopened,tabId:17,goal:'Synthetic objective',maxContinuations:10,maxMinutes:1440});
let goal=storage['chatgpt-goal:'+reopened];
await store.intent({url:reopened,tabId:17,id:goal.id,operationId:goal.operation.id,text:goal.operation.text,baselineKey:'/c/reopened-fence|before'});
await api.appendJournal({kind:'send.authorized',sourceUrl:reopened,operationId:goal.operation.id},{id:17,url:reopened});
await store.report({url:reopened,tabId:17,id:goal.id,operationId:goal.operation.id,status:'clicked'});
await store.report({url:reopened,tabId:17,id:goal.id,operationId:goal.operation.id,status:'blocked'});
goal=storage['chatgpt-goal:'+reopened];
assert.equal(meta().active[17].consumed,true);
await store.recoverAcknowledgement({url:reopened,tabId:18,expectedRecord:structuredClone(goal),operationId:goal.operation.id,
 promptKey:'/c/reopened-fence|accepted',userId:'accepted-native',nativeVerified:true});
assert.equal(meta().active[17],undefined,'native recovery retires only the accepted old grant');
assert.equal((await log('retry.send_intent','next-recovery',18,reopened,{promptKey:'/c/reopened-fence|accepted'})).ok,true);
