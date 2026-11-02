import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Exercise the real worker handoff handler, not a replica of its branches.
// This probes the storage/Goal crash boundary without navigating a live chat.
const code=readFileSync('extension/service-worker.js','utf8');
const start=code.indexOf('function handoffKey(tabId)');
const end=code.indexOf('chrome.runtime.onMessage.addListener',start);
assert.ok(start>=0&&end>start,'handoff handler is present');
const saved={};
const journals=[];
const inflight=new Map();
let failGoal=true;
let failFailedRecordWrite=false;
const storage={
  async get(names) {
    return Object.fromEntries((Array.isArray(names)?names:[names]).map(name=>[name,saved[name]]));
  },
  async set(values) {
    if(failFailedRecordWrite&&Object.values(values).some(value=>value?.stage==='failed'))
      throw Error('Synthetic failed-record storage failure');
    Object.assign(saved,structuredClone(values));
  },
  async remove(name){delete saved[name];}
};
const handler=new Function('chrome','ChatGPTHandoffTitle','goalController','appendJournal','handoffWrites',
  code.slice(start,end)+'\nreturn handleHandoffMessage;')(
  {storage:{local:storage}},
  {chatUrl:url=>typeof url==='string'&&url.startsWith('https://chatgpt.com/c/')?url:null,
    planNext:()=>({title:'Handoff fixture'})},
  {handoffBegin:async()=>{if(failGoal)throw Error('Original Goal transition refused');},
    handoffConfirm:async()=>{}},
  async event=>{journals.push(event);return {ok:true};},
  inflight
);
const sourceUrl='https://chatgpt.com/c/goal-handoff-crash';
const marker=tab=>`chatgpt-handoff:${tab}:source:${sourceUrl}`;
const record=id=>({id,sourceUrl,sourceTitle:'Goal fixture',text:'handoff text',prompt:'handoff prompt',asFile:false});

await assert.rejects(()=>handler({type:'CHATGPT_HANDOFF_BEGIN',record:record('first')},7),
  /Original Goal transition refused/);
assert.equal(saved[marker(7)],undefined,'pre-navigation failure clears its handoff marker');
assert.equal(saved['chatgpt-handoff:7'].stage,'failed','handoff failure is visible');

failGoal=false;
const retry=await handler({type:'CHATGPT_HANDOFF_BEGIN',record:record('second')},7);
assert.equal(retry.ok,true,'same chat can retry after a failed preparation');
assert.equal(saved[marker(7)],'second');

failGoal=true;
failFailedRecordWrite=true;
await assert.rejects(()=>handler({type:'CHATGPT_HANDOFF_BEGIN',record:record('third')},8),
  /Original Goal transition refused/,
  'cleanup write failure must not replace the original Goal error');
assert.equal(saved[marker(8)],undefined,'marker removal is still attempted if failed-record write fails');
assert.equal(journals.length,3);
console.log('Goal handoff: fail-closed preparation, marker cleanup, safe retry, preserved original error passed.');
