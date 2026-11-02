import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/journal-store.js','utf8');
const storage:Record<string,any>={};
let fail=false;
function boot(){
 const ctx=createContext({URL,console,chrome:{runtime:{getManifest:()=>({version:'1.2.0'})},storage:{local:{
  get:async(key:string|null)=>structuredClone(key===null?storage:{[key]:storage[key]}),
  set:async(value:any)=>{if(fail)throw new Error('Disk full'); await new Promise(r=>setTimeout(r,1));Object.assign(storage,structuredClone(value));}
 }}}});
 runInContext(source,ctx);return ctx;
}
let ctx=boot();
async function append(event:Record<string,any>,tab={id:7,url:'https://chatgpt.com/c/source-chat',title:'Source'}){
 ctx.event=event;ctx.tab=tab;return await runInContext('appendJournal(event,tab)',ctx);
}
await runInContext("initializeJournal('test')",ctx);
await Promise.all(Array.from({length:30},(_,i)=>append({kind:'retry.planned',operationId:`op-${i}`,text:'доделай е2е'})));
let result=await runInContext('readJournal()',ctx);
assert.equal(result.events.length,32,'concurrent writes must not lose events');
assert.deepEqual(Array.from(result.events,(e:any)=>e.sequence),Array.from({length:32},(_,i)=>i+1));
const payload='History\n'.repeat(5000);
await append({kind:'handoff.navigating',operationId:'handoff',text:payload,sourceUrl:'https://chatgpt.com/c/source-chat'});
await append({kind:'handoff.sending',operationId:'handoff',sourceUrl:'https://chatgpt.com/c/source-chat',targetUrl:'https://chatgpt.com/'});
ctx=boot(); // Service worker suspension must retain active operation and sequence.
await append({kind:'request.started',requestId:'r-1',sourceUrl:'https://chatgpt.com/'});
await append({kind:'handoff.sent',operationId:'handoff',sourceUrl:'https://chatgpt.com/c/source-chat',targetUrl:'https://chatgpt.com/c/target-chat'});
await append({kind:'request.completed',requestId:'r-1',statusCode:200});
result=await runInContext('readJournal()',ctx);
const sent=result.events.find((e:any)=>e.kind==='handoff.sent');
assert.equal(sent.sourceChatId,'source-chat');assert.equal(sent.targetChatId,'target-chat');
assert.equal(result.events.find((e:any)=>e.kind==='request.started').operationId,'handoff');
assert.equal(result.events.at(-1).operationId,'handoff','network completion must retain correlation after confirmed send');
assert.equal(result.events.find((e:any)=>e.kind==='handoff.navigating').text,payload,'full payload must survive export and restart');
await append({kind:'request.started',requestId:'r-2'});
result=await runInContext('readJournal()',ctx);assert.equal(result.events.at(-1).automatic,false,'later manual send must not inherit completed operation');
const before=result.events.length;fail=true;await assert.rejects(append({kind:'retry.send_intent',operationId:'no-send'}),/Disk full/);
result=await runInContext('readJournal()',ctx);assert.equal(result.events.length,before);assert.match(result.storageError,/Disk full/);
fail=false;await append({kind:'watcher.started'});result=await runInContext('readJournal()',ctx);assert.equal(result.events.length,before+1);assert.equal(result.storageError,'');
console.log('PASS: concurrent durable audit, exact payload export, worker restart correlation, source/target chat IDs, no false manual attribution, disk failure recovery');
