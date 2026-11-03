import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Real journal + real worker handoff handler: the source claim is durable,
// and only a proven pre-navigation failure can release its exact owner.
const data:Record<string,any>={};
let goalFails=true,failedRecordWriteFails=false;
const local={
  async get(names:string|string[]|null) {
    return structuredClone(Object.fromEntries((names===null?Object.keys(data):Array.isArray(names)?names:[names]).map(n=>[n,data[n]])));
  },
  async set(values:Record<string,any>) {
    if(failedRecordWriteFails&&Object.values(values).some(v=>v?.stage==='failed'))
      throw Error('Synthetic failed-record write');
    Object.assign(data,structuredClone(values));
  },
  async remove(name:string){delete data[name];}
};
const chrome={storage:{local},runtime:{getManifest:()=>({version:'1.7.0'})}};
const journal=new Function('chrome','URL','console',
  readFileSync('extension/journal-store.js','utf8')+'\nreturn {appendJournal,readJournal}')(chrome,URL,console) as {
    appendJournal:(event:Record<string,unknown>,tab:Record<string,unknown>)=>Promise<any>;
    readJournal:()=>Promise<any>;
  };
const worker=readFileSync('extension/service-worker.js','utf8');
const first=worker.indexOf('function handoffKey(tabId)');
const last=worker.indexOf('chrome.runtime.onMessage.addListener',first);
assert.ok(first>=0&&last>first,'worker handoff handler');
const handler=new Function('chrome','ChatGPTHandoffTitle','goalController','appendJournal','handoffWrites',
  worker.slice(first,last)+'\nreturn handleHandoffMessage')(
  chrome,
  {chatUrl:(url:unknown)=>typeof url==='string'&&url.startsWith('https://chatgpt.com/c/')?url:null,
    planNext:()=>({title:'Source (1)'})},
  {handoffBegin:async()=>{if(goalFails)throw Error('Goal cannot prepare');},handoffConfirm:async()=>{}},
  journal.appendJournal,new Map()
) as (message:Record<string,unknown>,tabId:number)=>Promise<any>;

const url='https://chatgpt.com/c/proven-source';
const entry=(id:string,sourceUrl=url)=>({type:'CHATGPT_HANDOFF_BEGIN',
  record:{reasoningEffort:'max',id,sourceUrl,sourceTitle:'Source',text:'Full history',prompt:'Full history'}});
const meta=()=>data['chatgpt-journal:meta'];

await assert.rejects(()=>handler(entry('failed-first'),7),/Goal cannot prepare/);
assert.equal(data['chatgpt-handoff:7'].stage,'failed');
assert.equal(meta().handoffSourceClaims[url],undefined,
  'confirmed no-click failure releases only its own source claim');
goalFails=false;
assert.equal((await handler(entry('retry-same-source'),7)).ok,true);
assert.equal(meta().handoffSourceClaims[url].operationId,'retry-same-source');
await assert.rejects(()=>handler(entry('duplicate-another-tab'),8),/Передача этого чата уже запускалась/);
await assert.rejects(()=>journal.appendJournal({
  kind:'handoff.pre_navigation_cancelled',operationId:'failed-first',sourceUrl:url
},{id:7,url}),/Нельзя снять запрет/);
assert.equal(meta().handoffSourceClaims[url].operationId,'retry-same-source');

const unknown='https://chatgpt.com/c/uncertain-failed-record';
goalFails=true;failedRecordWriteFails=true;
await assert.rejects(()=>handler(entry('uncertain',unknown),9),/Goal cannot prepare/);
assert.equal(meta().handoffSourceClaims[unknown].operationId,'uncertain',
  'missing durable failed record cannot authorize another handoff');
failedRecordWriteFails=false;
await assert.rejects(()=>handler(entry('forbidden-retry',unknown),10),/Передача этого чата уже запускалась/);
assert.equal((await journal.readJournal()).events.filter((e:any)=>
  e.kind==='handoff.pre_navigation_cancelled').length,1);
console.log('Goal source claims: confirmed no-click cleanup, exact owner, retry, cross-tab duplicate, uncertain write fence passed.');
