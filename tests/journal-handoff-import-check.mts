import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/journal-store.js','utf8');
const data:Record<string,any>={'chatgpt-handoff:1':{id:'a',sourceUrl:'https://chatgpt.com/c/a'},'chatgpt-handoff:2':{id:'b',sourceUrl:'https://chatgpt.com/c/b'}};
let fail=true;
const chrome={runtime:{getManifest:()=>({version:'test'})},storage:{local:{
 get:async(k:any)=>structuredClone(k===null?data:Array.isArray(k)?Object.fromEntries(k.map((x:string)=>[x,data[x]])):{[k]:data[k]}),
 set:async(v:any)=>{if(fail&&Object.values(v).some((x:any)=>x?.kind==='handoff.imported'&&x.operationId==='b')){fail=false;throw Error('synthetic import failure');}Object.assign(data,structuredClone(v));}
}}};
let ctx=createContext({URL,console,chrome});runInContext(source,ctx);
await assert.rejects(()=>runInContext("initializeJournal('test')",ctx),/synthetic import failure/);
assert.notEqual(data['chatgpt-journal:meta'].handoffImportComplete,true);
// Simulate a first import interrupted in the older implementation, before a pending marker existed.
delete data['chatgpt-journal:meta'].handoffImportPending;
ctx=createContext({URL,console,chrome});runInContext(source,ctx);
await runInContext("initializeJournal('retry')",ctx);
let entries=Object.values(data).filter((v:any)=>v?.kind==='handoff.imported') as any[];
assert.deepEqual(entries.map(e=>e.operationId).sort(),['a','b']);
assert.equal(data['chatgpt-journal:meta'].handoffImportComplete,true);
await runInContext("initializeJournal('again')",ctx);
entries=Object.values(data).filter((v:any)=>v?.kind==='handoff.imported') as any[];
assert.equal(entries.length,2,'restart never imports a completed handoff twice');
assert.equal(data['chatgpt-journal:meta'].handoffSourceClaims['https://chatgpt.com/c/a'].operationId,'a');
assert.equal(data['chatgpt-journal:meta'].handoffSourceClaims['https://chatgpt.com/c/b'].operationId,'b');
// Simulate a crash after one imported handoff was cancelled but before the
// completion marker; retry must retain that cancellation.
await runInContext("appendJournal({kind:'handoff.pre_navigation_cancelled',operationId:'a',sourceUrl:'https://chatgpt.com/c/a'},{id:1})",ctx);
delete data['chatgpt-journal:meta'].handoffImportComplete;
ctx=createContext({URL,console,chrome});runInContext(source,ctx);
await runInContext("initializeJournal('interrupted-again')",ctx);
assert.equal(data['chatgpt-journal:meta'].handoffSourceClaims['https://chatgpt.com/c/a'],undefined,'an imported then cancelled handoff stays cancelled after restart');
assert.equal(Object.values(data).filter((v:any)=>v?.kind==='handoff.imported'&&v.operationId==='a').length,1);
// An existing journal may already have observed and released a handoff. It
// must not import its still-present saved record as a new source claim.
{
 const more:Record<string,any>={};const chrome2={runtime:{getManifest:()=>({version:'test'})},storage:{local:{
  get:async(k:any)=>structuredClone(k===null?more:Array.isArray(k)?Object.fromEntries(k.map((x:string)=>[x,more[x]])):{[k]:more[k]}),
  set:async(v:any)=>Object.assign(more,structuredClone(v))
 }}};
 const worker=createContext({URL,console,chrome:chrome2});runInContext(source,worker);
 await runInContext("initializeJournal('existing')",worker);
 await runInContext("appendJournal({kind:'handoff.navigating',operationId:'cancelled',sourceUrl:'https://chatgpt.com/c/cancelled'},{id:9})",worker);
 await runInContext("appendJournal({kind:'handoff.pre_navigation_cancelled',operationId:'cancelled',sourceUrl:'https://chatgpt.com/c/cancelled'},{id:9})",worker);
 delete more['chatgpt-journal:meta'].handoffImportComplete;
 more['chatgpt-handoff:9']={id:'cancelled',sourceUrl:'https://chatgpt.com/c/cancelled',stage:'failed'};
 await runInContext("initializeJournal('upgrade')",worker);
 assert.equal(more['chatgpt-journal:meta'].handoffSourceClaims['https://chatgpt.com/c/cancelled'],undefined,'released claim is not recreated');
 assert.equal(Object.values(more).filter((e:any)=>e?.kind==='handoff.imported'&&e.operationId==='cancelled').length,0);
}
{
 const existing:Record<string,any>={'chatgpt-journal:meta':{sequence:1},
  'chatgpt-journal:event:000000000001':{kind:'notification.requested',sequence:1}};
 const chrome3={runtime:{getManifest:()=>({version:'test'})},storage:{local:{
  get:async(k:any)=>{assert.notEqual(k,null,'initializing an established journal must not read all storage');
   return structuredClone(Array.isArray(k)?Object.fromEntries(k.map((x:string)=>[x,existing[x]])):{[k]:existing[k]});},
  set:async(v:any)=>Object.assign(existing,structuredClone(v))
 }}};
 const worker=createContext({URL,console,chrome:chrome3});runInContext(source,worker);
 await runInContext("initializeJournal('established')",worker);
 assert.equal(existing['chatgpt-journal:meta'].handoffImportComplete,true,'startup really completed without a swallowed get(null) failure');
 assert.equal(Object.values(existing).filter((v:any)=>v?.kind==='extension.started').length,1);
}
console.log('Handoff import resumes after failure without duplicate claims.');
