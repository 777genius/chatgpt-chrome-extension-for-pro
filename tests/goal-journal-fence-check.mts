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
