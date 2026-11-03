import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/journal-store.js','utf8');
const data:Record<string,any>={};
let failWrite=false;
const chrome={runtime:{getManifest:()=>({version:'fixture'})},storage:{local:{
  get:async(keys:string|string[]|null)=>structuredClone(keys===null?data:Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,data[key]]))),
  set:async(values:Record<string,unknown>)=>{if(failWrite)throw Error('fixture disk failure');Object.assign(data,structuredClone(values));}
}}};
function boot(){const world=createContext({chrome,Date,URL,console:{error(){}}});runInContext(source,world);return world;}
let world=boot();
const call=(code:string)=>runInContext(code,world) as Promise<any>;
const url='https://chatgpt.com/c/retry-fixture';
const tab={id:7,url};
async function event(kind:string,extra:Record<string,unknown>={}) {
  world.event={kind,operationId:'op-a',sourceUrl:url,promptKey:'/c/retry-fixture|'+(extra.operationId||'op-a'),...extra};world.tab=tab;
  return call('appendJournal(event,tab)');
}
async function read(){return call(`readRetryDraft('${url}?q=1#fragment')`);}
async function claim(record:any){world.record=record;return call(`claimRetryDraft('${url}/',record.operationId,record.savedSequence,{id:7,url:'${url}'})`);}
await event('draft.saved',{draft:'  private draft\n\n ',phase:'before-recovery-stop'});
let saved=await read();assert.equal(saved.draft,'  private draft\n\n ');
assert.equal(Object.hasOwn(data['chatgpt-journal:meta'].retryDraftByChat[url],'draft'),false,'large draft bytes remain only in their immutable event, not hot journal metadata');
world=boot();saved=await read();assert.equal(saved.phase,'saved','pre-STOP backup remains indexed through a full worker reload');
const [first,second]=await Promise.all([claim(saved),claim(saved)]);
assert.equal(Number(first.claimed)+Number(second.claimed),1,'concurrent restorers receive only one durable claim');
world=boot();assert.equal((await claim(saved)).claimed,false,'crash after the claim cannot duplicate draft insertion');
await event('retry.send_intent');
await assert.rejects(event('send.authorized'),/восстановление/,'claim fences a late sender even when its intent arrives later');
await event('retry.cancelled');
await event('draft.saved',{operationId:'op-b',draft:'new draft'});
await event('retry.send_intent',{operationId:'op-b'});
await event('send.authorized',{operationId:'op-b'});
saved=await read();assert.equal(saved.phase,'unknown');
world=boot();assert.equal((await claim(saved)).claimed,false,'a consumed send with no confirmation stays parked after restart');
await event('retry.failed',{operationId:'op-b',clicked:true,confirmed:false});
assert.equal((await claim(await read())).claimed,false,'uncertain retry failure is never permission to restore or resend');
await event('retry.confirmed',{operationId:'op-b'});
saved=await read();assert.equal(saved.phase,'confirmed');
assert.equal((await claim(saved)).claimed,true,'confirmed send can restore its backup once');
await event('draft.saved',{operationId:'op-c',draft:'before edit'});
const stale=await read();
await event('draft.saved',{operationId:'op-c',draft:'after edit'});
assert.equal((await claim(stale)).claimed,false,'the claim checks the exact saved draft sequence');
await event('retry.send_intent',{operationId:'op-a'});
await assert.rejects(event('send.authorized'),/восстановление/,'a newer draft cannot erase an older restoration claim fence');
saved=await read();
world.record=saved;assert.equal((await call("claimRetryDraft('https://chatgpt.com/c/other',record.operationId,record.savedSequence)")).claimed,false,'chat A cannot claim chat B');
await event('retry.failed',{operationId:'op-c',clicked:false});
assert.equal((await read()).phase,'not-clicked');
failWrite=true;assert.equal((await claim(await read())).claimed,false,'storage failure never grants an editor effect');failWrite=false;
assert.equal((await claim(await read())).claimed,true,'failed atomic write leaves the unclaimed backup intact');
await event('draft.saved',{operationId:'op-d',draft:'old pending draft'});
saved=await read();
const backupKey=`chatgpt-journal:event:${String(saved.savedSequence).padStart(12,'0')}`;
const original=structuredClone(data[backupKey]);data[backupKey].operationId='wrong-operation';
assert.equal(await read(),null,'the indexed event must belong to the exact saved operation');
assert.equal((await claim(saved)).claimed,false,'an invalid pointer cannot grant a restoration');data[backupKey]=original;
await event('retry.manual_reset',{operationId:null});
assert.equal((await claim(await read())).claimed,false,'a later trusted manual reset supersedes the old draft');
const oldJournal=structuredClone(data);delete data['chatgpt-journal:meta'].retryDraftSchema;
delete data['chatgpt-journal:meta'].retryDraftByChat;delete data['chatgpt-journal:meta'].retryDraftClaims;
world=boot();assert.equal(await read(),null,'legacy history without durable claims cannot invent a pending restoration');
await event('extension.started',{operationId:null});assert.equal(await read(),null);
assert.deepEqual(data['chatgpt-journal:event:000000000001'],oldJournal['chatgpt-journal:event:000000000001'],'index migration preserves immutable recovery copies');
console.log('Retry drafts: durable exact backups, reload, one claim, no resend, unknown parking, sequence/chat fences and conservative migration passed.');
