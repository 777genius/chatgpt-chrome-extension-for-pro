import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('extension/service-worker.js','utf8');
const code=source.slice(source.indexOf('async function recoverCompletionSenderIdentity('),source.indexOf('// Notification-only recovery.'));
const url='https://chatgpt.com/c/identity-fixture';
async function fixture(extra:any={}){
 const record={state:'active',url,startedAt:1000,requestId:'request',promptKey:'/c/identity-fixture|fallback-turn-3:0:user',baselineKey:'/c/identity-fixture|fallback-turn-2:0:user'};
 const native={ok:true,isLatest:true,isReadOnly:false,userId:'stable-user',promptKey:record.baselineKey,lastUserSentAtMs:1001};
 const events=[{kind:'request.started',operationId:'op',tabId:7,sourceUrl:url,requestId:'request',eventAt:1000,sequence:1},
  {kind:'send.dispatched',operationId:'op',tabId:7,sourceUrl:url,text:'retry-text',sequence:2},...(extra.events||[])];
 function inspectCompletedTurn(){}
 const fn=new Function('readJournal','chrome','inspectCompletedTurn','completionCheckpointRead',code+';return recoverCompletionSenderIdentity;')(
  async()=>({ok:true,events:extra.noSend?events.filter(e=>e.kind!=='send.dispatched'):events}),
  {tabs:{get:async()=>({url:extra.url||url})},scripting:{executeScript:async(o:any)=>{
    assert.equal(o.args[3],record.startedAt,'use unique native historical-user selection for this request');
    return [{result:{...native,userText:'retry-text',userSentAtMs:1001,...extra.native}}];}}},inspectCompletedTurn,
  async()=>extra.race?{...record,requestId:'new'}:record);
 return fn(7,url,record,native);
}
assert.equal((await fixture()).nativeUserId,'stable-user');
for(const extra of [{noSend:true},{native:{userText:'different'}},{native:{ok:false}},
 {native:{userId:'old-user'}},{native:{isLatest:false}},{native:{userSentAtMs:1002}},{race:true},
 {url:'https://chatgpt.com/c/other'},{events:[{kind:'request.started',operationId:'new',tabId:7,sourceUrl:url,requestId:'new',eventAt:1100,sequence:3}]}])
 assert.equal(await fixture(extra),null,JSON.stringify(extra));
console.log('Checkpoint identity: unique native request user plus exact accepted sender payload; missing sends, stale users, races and newer requests fail closed.');
