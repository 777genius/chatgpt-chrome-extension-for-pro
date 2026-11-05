import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const policy:any=require('../extension/goal-policy.js');
const {create}:any=require('../extension/goal-store.js');
const expected='Review PR #7';
const accepted='Review PR [#7](https://repo.example/pull/7)';
const replaced='Review PR [#7](https://other.example/pull/7)';

assert.equal(policy.submittedTextMatches(expected,accepted,expected,['https://repo.example/pull/7']),true);
assert.equal(policy.submittedTextMatches(expected,replaced,expected,['https://repo.example/pull/7']),false,
  'identical visible label must not authorize a changed URL');
assert.equal(policy.submittedTextMatches(expected,accepted,expected,[]),false,
  'a previously unlinked editor cannot approve a newly inserted rich link');
assert.equal(policy.submittedTextMatches(expected,expected,null,[]),true,
  'literal user text remains valid without generated links');
assert.equal(policy.submittedTextMatches(expected,accepted,expected,['https://other.example']),false);

const url='https://chatgpt.com/c/link-proof-fixture';
const path='/c/link-proof-fixture';
const data:Record<string,any>={};
const storage={
  get:async(key:string)=>({[key]:structuredClone(data[key])}),
  set:async(values:Record<string,any>)=>Object.assign(data,structuredClone(values))
};
const tabs={get:async(tabId:number)=>({id:tabId,url}),sendMessage:async()=>({ok:true,idle:true})};
const store=create({storage,tabs,appendJournal:async()=>({ok:true}),now:()=>1000000,uuid:()=> 'goal-link-proof'});
const arm=await store.composerArm({tabId:7,url,rules:''});
const intent={tabId:7,armId:arm.record.id,url,eventAt:1000000,text:expected,
  baselineKey:path+'|prior',linkTargets:['https://repo.example/pull/7']};
await store.composerIntent(intent);
await assert.rejects(()=>store.composerIntent({...intent,linkTargets:['https://other.example/pull/7']}),
  'the same click intent cannot replace the captured URL on replay');
const proof={tabId:7,armId:arm.record.id,url,requestId:'req-7',startedAt:1000100,
  promptKey:path+'|user-7',userId:'user-7',userSentAtMs:1000100,
  userVisibleText:expected,firstTurn:false,nativeVerified:true};
await assert.rejects(()=>store.composerBind({...proof,userText:replaced}),
  'a native rich-link target changed after the trusted click');
const good=await store.composerBind({...proof,userText:accepted});
assert.equal(good.ok,true);
assert.equal(good.goal.goal,accepted,'preserve the exact native Markdown that the user actually sent');
const followup={url,tabId:7,requestId:'req-8',startedAt:1000200,eventAt:1000199,
  baselineKey:path+'|user-7',text:'Follow #8',linkTargets:['https://repo.example/pull/8']};
assert.equal((await store.manual(followup)).ok,true);
const bind={url,tabId:7,id:arm.record.id,requestId:'req-8',startedAt:1000200,
  promptKey:path+'|user-8',userId:'user-8',userVisibleText:'Follow #8',
  userSentAtMs:1000200,nativeVerified:true};
assert.equal((await store.manualBind({...bind,userText:'Follow [#8](https://other.example/pull/8)'})).ok,false);
assert.equal((await store.get(url)).manualPending.requestId,'req-8','unsafe follow-up remains pending for review');
assert.equal((await store.manualBind({...bind,userText:'Follow [#8](https://repo.example/pull/8)'})).ok,true);
assert.equal((await store.get(url)).supplements.length,1);
console.log('Goal rich-link consent: captured href preserved through start and follow-up, changed targets refused.');
