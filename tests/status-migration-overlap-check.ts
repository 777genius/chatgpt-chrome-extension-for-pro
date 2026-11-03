import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const source=readFileSync('extension/status-store.js','utf8');
const url='https://chatgpt.com/c/overlapping-notices';
const ambiguousUrl='https://chatgpt.com/c/ambiguous-notices';
const journalPrefix='chatgpt-journal:event:';
const storage:Record<string,any>={};
const rows:any[]=[];
const push=(row:Record<string,unknown>)=>{
  const sequence=rows.length+1;
  const value={sequence,recordedAt:sequence,...row};
  rows.push(value);storage[`${journalPrefix}${String(sequence).padStart(12,'0')}`]=value;
};
const notice=(sourceUrl:string,tabId:number,response:string)=>push({kind:'notification.requested',sourceUrl,tabId,title:'Synthetic',response});
const result=(sourceUrl:string,tabId:number,notificationId:string,message:string)=>push({kind:'notification.result',sourceUrl,tabId,notificationId,message,title:'❌ Synthetic',notification:'fulfilled',isError:true});
const first='chatgpt-prompt-bound:7:first',second='chatgpt-prompt-bound:7:second';
const uncertain='chatgpt-prompt-bound:8:ambiguous';
notice(url,7,'First pending alert');notice(url,7,'Second pending alert');
// Both creates are outstanding when the older result returns first.
result(url,7,first,'First pending alert');result(url,7,second,'Second pending alert');
notice(ambiguousUrl,8,'Identical');notice(ambiguousUrl,8,'Identical');
result(ambiguousUrl,8,uncertain,'Identical');
storage['chatgpt-journal:meta']={sequence:rows.length};
const immutable=structuredClone(storage);
let activeReads=0,writes=0,effects=0;
const ctx=createContext({Date,Math,JOURNAL_META:'chatgpt-journal:meta',JOURNAL_PREFIX:journalPrefix,
  ChatGPTHandoffTitle:{chatUrl:(value:string)=>value?.startsWith('https://chatgpt.com/c/')?value:null},
  cleanSessionTitle:(value:string)=>value,truncateResponse:(value:string)=>value,
  chrome:{storage:{local:{get:async(keys:string|string[])=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,storage[key]]))),set:async(value:Record<string,unknown>)=>{writes++;Object.assign(storage,structuredClone(value));}}},
    notifications:{getAll:async()=>{activeReads++;return {[first]:{},[second]:{},[uncertain]:{}};},create:async()=>{effects++;},clear:async()=>{effects++;}}}});
runInContext(source,ctx);
await runInContext('Promise.all([migrateChatStatuses(),migrateChatStatuses()])',ctx);
assert.deepEqual(storage[`chatgpt-status:${url}`].notifications.map((ticket:any)=>ticket.id),[first,second],'overlapping distinct notices retain both proven active IDs');
assert.equal(storage[`chatgpt-status:${ambiguousUrl}`].notifications.length,0,'identical pending notices cannot prove which generation created the active result');
assert.equal(activeReads,1);assert.equal(writes,1);assert.equal(effects,0,'migration only records bindings and never creates or clears OS notifications');
for(const [key,value] of Object.entries(immutable))assert.deepEqual(storage[key],value,'migration preserves every journal row and its metadata');
console.log('Status migration: overlapping active notices, ambiguous matches, shared migration and immutable journal passed.');
