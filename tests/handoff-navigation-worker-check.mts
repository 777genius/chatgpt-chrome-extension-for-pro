import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('extension/service-worker.js','utf8');
const body=source.slice(source.indexOf('async function recoverHandoffNavigation('),source.indexOf('async function handleHandoffMessage('));
const url='https://chatgpt.com/c/navigation-worker-fixture';
type V=Record<string,any>;
async function fixture(o:V={}){
 const record:V={id:'saved-navigation',stage:'failed',reason:'Кнопка нового чата недоступна',sourceUrl:url,createdAt:100,
  draft:'Owner draft',lastUserText:'Exact sent user',reasoningEffort:'pro',reasoningModel:'native-test-model',...o.record};
 let current=structuredClone(record),calls=0,writes=0,goalCalls=0;const notices:V[]=[],goalArgs:V[]=[],locks=new Map();
 const native:V={ok:true,isLatest:true,isReadOnly:false,generating:false,hasError:true,userId:'native-user',userText:'Exact sent user',promptKey:'/c/navigation-worker-fixture|user',userSentAtMs:50,...o.native};
 const request:V={requestId:'original-request',startedAt:50};let liveUrl=o.url||url;
 const events:V[]=[{kind:'handoff.navigating',sourceUrl:url,operationId:record.id,tabId:7,recordedAt:100},
  {kind:'handoff.failed',sourceUrl:url,operationId:record.id,tabId:7,recordedAt:101,reason:record.reason},...(o.events||[])];
 const chrome={storage:{local:{get:async()=>({key:structuredClone(current)}),set:async(v:V)=>{writes++;current=structuredClone(v.key);}}},
  tabs:{get:async()=>({id:7,url:liveUrl,status:o.status||'complete'}),sendMessage:async(_id:number,m:V)=>{notices.push(m);return {ok:true};}},
  scripting:{executeScript:async(v:V)=>{calls++;let result:V;
   if(v.func.name==='inspectCompletedTurn')result={...native,...(calls===4?o.fresh||{}:{})};
   else if(v.func.name==='inspectChatError')result={ok:true,action:'new-chat',incomplete:false,...o.error};
   else result={ok:true,matches:true,effort:'pro',model:'native-test-model',...o.composer};
   if(calls===4){if(o.race==='request')request.requestId='new-request';if(o.race==='route')liveUrl='https://chatgpt.com/c/other';if(o.race==='record')current.reason='Changed by owner';}
   return [{result}];}}};
 const recover=new Function('handoffWrites','handoffKey','chrome','readJournal','latestRequestReceipt','inspectCompletedTurn','inspectChatError','controlChatComposer','goalController','appendJournal','ChatGPTGoalPolicy',body+';return recoverHandoffNavigation;')(
  locks,()=> 'key',chrome,async()=>({ok:true,storageError:o.storageError||'',events,meta:{active:o.grant?{7:{operationId:'unknown-operation',consumed:true}}:o.otherGrant?{8:{operationId:'other-operation',chatUrl:url,consumed:true}}:{},retryPreparingByChat:o.retryPreparing?{[url]:{operationId:'preparing-retry'}}:{}}}),async()=>structuredClone(request),
  function inspectCompletedTurn(){},function inspectChatError(){},function controlChatComposer(){},
  {handoffPreparationReady:async(a:V)=>{goalCalls++;goalArgs.push(a);return {ok:o.goalOk!==false};}},async(e:V)=>{events.push(e);return {ok:true};},
  {canonical:(u:string)=>u.startsWith('https://chatgpt.com/c/')?u:''});
 const result=await recover(7,record);
 return {result,current,record,writes,calls,goalCalls,goalArgs,events,notices,recover};
}
{
 const h=await fixture();assert.equal(h.result.ok,true);assert.equal(h.current.id,h.record.id);assert.equal(h.current.stage,'navigating');
 assert.equal(h.current.navigationRecoveries,1);assert.equal(h.goalCalls,1);assert.equal(h.goalArgs[0].reason,'Кнопка нового чата недоступна');
 assert.deepEqual(h.notices,[{type:'CHATGPT_HANDOFF_NAVIGATION_READY',id:h.record.id,url}]);
 assert.equal((await h.recover(7,h.record)).ok,false);assert.equal(h.notices.length,1);assert.equal(h.events.filter(e=>e.kind==='handoff.navigation_recovered').length,1);
}
for(const options of [
 {record:{sendReceipt:{clickedAt:101}}},{record:{navigationRecoveries:1}},{record:{reason:'Unknown failure'}},
 {events:[{kind:'handoff.navigation_intent',operationId:'saved-navigation'}]},
 {events:[{kind:'handoff.navigation_clicked',operationId:'saved-navigation'}]},
 {events:[{kind:'handoff.sending',operationId:'saved-navigation'}]},
 {events:[{kind:'send.authorized',operationId:'saved-navigation'}]},
 {events:[{kind:'request.started',tabId:7,operationId:'other',recordedAt:102}]},
 {grant:true},{otherGrant:true},{retryPreparing:true},{url:'https://chatgpt.com/c/other'},{status:'loading'},
 {native:{generating:true}},{native:{hasError:false}},{native:{isReadOnly:true}},{native:{userText:'Changed sent message'}},
 {error:{action:'retry'}},{error:{incomplete:true}},{composer:{matches:false}},{composer:{effort:'medium'}},{composer:{model:'other'}},
 {goalOk:false},{storageError:'Read failed'},{race:'request'},{race:'route'},{race:'record'},
 {fresh:{isReadOnly:true}},{fresh:{isLatest:false}},{fresh:{userText:'Changed while inspecting'}}
]){
 const h=await fixture(options);assert.equal(h.result.ok,false,JSON.stringify(options));assert.equal(h.writes,0,JSON.stringify(options));assert.equal(h.notices.length,0,JSON.stringify(options));
}
// The navigation click grant is durable and unique, independent of content
// script cache or reload. An operation/tab/source mismatch cannot acquire it.
{
 const data:V={};const storage={get:async(keys:string|string[]|null)=>structuredClone(Object.fromEntries((keys===null?Object.keys(data):Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]))),set:async(v:V)=>Object.assign(data,structuredClone(v))};
 const chrome={storage:{local:storage},runtime:{getManifest:()=>({version:'synthetic'})}};
 const create=()=>new Function('chrome','URL','console',readFileSync('extension/journal-store.js','utf8')+';return {appendJournal,readJournal};')(chrome,URL,console);
 const journal=create();await journal.appendJournal({kind:'handoff.navigating',operationId:'nav-op',sourceUrl:url},{id:7});
 for(const [id,op,sourceUrl] of [[8,'nav-op',url],[7,'other-op',url],[7,'nav-op','https://chatgpt.com/c/other']] as [number,string,string][])
  await assert.rejects(()=>journal.appendJournal({kind:'handoff.navigation_intent',operationId:op,sourceUrl},{id}),/Переход/);
 for(const id of [7,8]) {
  await journal.appendJournal({kind:'goal.send_intent',operationId:'competing-goal-'+id,sourceUrl:url},{id,url});
  await assert.rejects(()=>journal.appendJournal({kind:'handoff.navigation_intent',operationId:'nav-op',sourceUrl:url},{id:7}),/Переход/,'a grant acquired after worker inspection atomically fences navigation');
  assert.equal((await journal.readJournal()).meta.handoffNavigationClaims?.['nav-op'],undefined,'refused grant does not consume navigation claim');
  await journal.appendJournal({kind:'goal.confirmed',operationId:'competing-goal-'+id,sourceUrl:url},{id,url});
 }
 await journal.appendJournal({kind:'handoff.navigation_intent',operationId:'nav-op',sourceUrl:url},{id:7});
 assert.equal((await journal.readJournal()).meta.handoffNavigationClaims['nav-op'].tabId,7);
 await assert.rejects(()=>create().appendJournal({kind:'handoff.navigation_intent',operationId:'nav-op',sourceUrl:url},{id:7}),/Переход/);
}
console.log('Worker no-navigation recovery: exact saved operation, draft/mode/request/native/Goal fences and durable once-only navigation claim passed.');
