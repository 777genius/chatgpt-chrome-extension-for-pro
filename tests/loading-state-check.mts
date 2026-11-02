import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const storage:Record<string,any>={'chatgpt-status:migration':{schema:1}};
const ctx=createContext({Date,Math,chrome:{storage:{local:{
 get:async(key:string)=>structuredClone({[key]:storage[key]}),
 set:async(value:Record<string,unknown>)=>Object.assign(storage,structuredClone(value))
}},notifications:{clear:async()=>true}}});
runInContext(readFileSync('extension/status-store.js','utf8'),ctx);
const evaluate=(source:string)=>runInContext(source,ctx) as Promise<any>;
await evaluate("globalThis.url='https://chatgpt.com/c/fixture';globalThis.a=statusReceipt();stopChatLoading(url,100,statusReceipt(),a)");
assert.equal((await evaluate('markChatLoading(url,100,a)')).status,null,'stop before the first loading write fences that delayed write');
assert.equal((await evaluate('visitChatNotifications(url,a,{manual:true,startedAt:100})')).status,null,'late manual acknowledgement cannot restart a stopped request');
assert.equal((await evaluate('globalThis.b=statusReceipt();markChatLoading(url,200,b)')).status.kind,'loading');
assert.equal((await evaluate('stopChatLoading(url,100,statusReceipt(),a)')).status.kind,'loading','late stop A cannot stop newer request B');
assert.equal((await evaluate('stopChatLoading(url,200,statusReceipt(),b)')).status,null);
assert.equal((await evaluate('markChatLoading(url,200,b)')).status,null,'delayed start B cannot resurrect the stopped loader');
assert.equal((await evaluate('markChatLoading(url,100,a)')).status,null,'even older starts remain fenced after stopping B');
await evaluate('globalThis.c=statusReceipt();markChatLoading(url,300,c)');
await evaluate("reserveChatNotification(url,7,'success',400,statusReceipt())");
assert.equal((await evaluate('stopChatLoading(url,300,statusReceipt(),c)')).status.kind,'success','late stop cannot erase a terminal response');
assert.equal((await evaluate('markChatLoading(url,300,c)')).status.kind,'success','late start cannot erase a terminal response');
// The stopped-generation fence is durable, not a per-worker timer flag.
const reboot=createContext({Date,Math,chrome:ctx.chrome});runInContext(readFileSync('extension/status-store.js','utf8'),reboot);
reboot.oldFence=structuredClone(storage['chatgpt-status:'+ctx.url].loadingStoppedThrough);
const result=await runInContext(`markChatLoading('https://chatgpt.com/c/fixture',200,oldFence)`,reboot);
assert.equal(result.status.kind,'success');
const virgin=await evaluate("observeChatLoading('https://chatgpt.com/c/allocated-chat',500,statusReceipt())");
assert.equal(virgin.status.kind,'loading','a newly allocated chat can display its native generation state');
assert.equal(virgin.status.observed,true);
assert.equal((await evaluate('observeChatLoading(url,600,statusReceipt())')).status.kind,'success','native generation snapshots cannot replace a known terminal status');
await evaluate("globalThis.v=statusReceipt();stopChatLoading('https://chatgpt.com/c/stopped-virgin',700,statusReceipt(),v)");
assert.equal((await evaluate("observeChatLoading('https://chatgpt.com/c/stopped-virgin',700,statusReceipt())")).status,null,'stale UI cannot seed a stopped virgin generation');
console.log('Loading state: stop-before-start, delayed manual ACK, older generations, terminal results and restart passed.');

await evaluate("globalThis.unreadURL='https://chatgpt.com/c/unread-fixture';globalThis.oldResult=statusReceipt();globalThis.visit=statusReceipt();globalThis.newResult=statusReceipt();");
await evaluate("reserveChatNotification(unreadURL,7,'error',800,oldResult)");
assert.equal((await evaluate('readChatStatus(unreadURL)')).status.unread,true);
await evaluate("reserveChatNotification(unreadURL,7,'success',900,newResult)");
const unread=await evaluate('markChatViewed(unreadURL,visit)');
assert.equal(unread.status.unread,true,'a stale visit cannot acknowledge a newer terminal generation');
assert.equal(unread.seenChanged,false);
const viewed=await evaluate('markChatViewed(unreadURL,statusReceipt())');
assert.equal(viewed.status.unread,false);assert.equal(viewed.status.kind,'success');assert.equal(viewed.seenChanged,true);
assert.equal((await evaluate('markChatViewed(unreadURL,statusReceipt())')).revision,viewed.revision,'repeat visits do not create extra revisions');
const seenAgain=await runInContext(`readChatStatus('https://chatgpt.com/c/unread-fixture')`,reboot);
assert.equal(seenAgain.status.unread,false,'seen state persists across worker restart');
await evaluate("reserveChatNotification(unreadURL,7,'error',1000,statusReceipt())");
assert.equal((await evaluate('readChatStatus(unreadURL)')).status.unread,true,'every later background result becomes unread again');
storage['chatgpt-status:https://chatgpt.com/c/legacy-seen']={url:'https://chatgpt.com/c/legacy-seen',revision:9,sequence:1,returnedThrough:0,status:{kind:'error'},notifications:[]};
assert.equal((await evaluate("readChatStatus('https://chatgpt.com/c/legacy-seen')")).status.unread,false,'legacy absence of view history is conservatively seen');
assert.equal(storage['chatgpt-status:https://chatgpt.com/c/legacy-seen'].status.unread,false,'the legacy default is durably normalized');
const realTerminal=await evaluate('readChatStatus(unreadURL)');
await evaluate("reserveChatNotification(unreadURL,7,'warning',1100,statusReceipt())");
const afterWarning=await evaluate('readChatStatus(unreadURL)');
assert.equal(afterWarning.revision,realTerminal.revision);assert.deepEqual(afterWarning.status,realTerminal.status,'metadata warning receipts do not change response color, unread state or generation');
await evaluate("reserveChatNotification('https://chatgpt.com/c/new-handoff',7,'warning',1200,statusReceipt())");
assert.equal((await evaluate("readChatStatus('https://chatgpt.com/c/new-handoff')")).status,null,'an awaiting-handoff warning cannot invent a response failure for a new chat');
assert.equal((await evaluate("observeChatLoading('https://chatgpt.com/c/new-handoff',1250,statusReceipt())")).status.kind,'loading','verified generation can still seed the new chat after an operational warning');
console.log('Unread state: receipt-fenced visits, later results, stable revisions, restart and conservative legacy migration passed.');

await evaluate("globalThis.raceUrl='https://chatgpt.com/c/completion-race';globalThis.oldCompletion=statusReceipt();globalThis.newLoading=statusReceipt();markChatLoading(raceUrl,1500,newLoading)");
const newerLoading=await evaluate('readChatStatus(raceUrl)');
await evaluate("reserveChatNotification(raceUrl,7,'success',1400,oldCompletion)");
const afterOldCompletion=await evaluate('readChatStatus(raceUrl)');
assert.deepEqual(afterOldCompletion.status,newerLoading.status,'a queued old completion receipt must not overwrite a newer loading generation');
assert.equal(afterOldCompletion.revision,newerLoading.revision);
console.log('Loading state: older completion receipt cannot overwrite newer loading.');
