import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('extension/service-worker.js','utf8');
const body=source.slice(source.indexOf('async function recoverHandoffAfterUnsentGoal('),source.indexOf('async function handleHandoffMessage('));
const url='https://chatgpt.com/c/unsent-handoff';type V=Record<string,any>;
async function fixture(options:V={}) {
 const op='old-goal-operation',handoff='handoff-operation',goalId='goal-id',tabId=7;
 const g:V={id:goalId,phase:'blocked',reason:'Отправка отменена: Нет сохранённого разрешения на эту автоматическую отправку',
   operation:{id:op,status:'intent',tabId,createdAt:100},...options.goal};
 const h:V={id:handoff,stage:'navigating',sourceUrl:url,text:'History',prompt:'History',fileName:'history.txt',asFile:true,
   draft:'',lastUserText:'Manual addition',reasoningEffort:'max',reasoningModel:'native-model',...options.handoff};
 const native:V={ok:true,isLatest:true,isReadOnly:false,generating:false,hasError:true,userId:'manual-user',userText:'Manual addition',
   userSentAtMs:200,promptKey:'/c/unsent-handoff|user',...options.native};
 const raw=[{kind:'goal.send_intent',operationId:op,tabId,sourceUrl:url},
   {kind:'goal.blocked',operationId:op,tabId,sourceUrl:url},{kind:'goal.dispatch_failed',operationId:op,tabId,sourceUrl:url},
   {kind:'request.started',operationId:null,tabId,sourceUrl:url,requestId:'manual-request',eventAt:200},
   {kind:'request.completed',operationId:null,tabId,sourceUrl:url,requestId:'manual-request'},
   {kind:'handoff.navigating',operationId:handoff,tabId,sourceUrl:url},...(options.extraEvents||[])];
 const events=raw.map((e,i)=>({...e,sequence:i+1}));let active:V|null={kind:'goal.send_intent',operationId:op,goalId,chatUrl:url,...options.active};
 let hCurrent=structuredClone(h),gCurrent=structuredClone(g),recovered=0;const appended:V[]=[],notifications:V[]=[];
 const chrome={tabs:{get:async()=>({id:tabId,url}),sendMessage:async(_id:number,m:V)=>{notifications.push(m);}},
   storage:{local:{get:async(k:string)=>({[k]:structuredClone(k==='handoff'?hCurrent:gCurrent)})}},
   scripting:{executeScript:async({func}:V)=>[{result:func.name==='inspectCompletedTurn'?native:
     func.name==='inspectChatError'?{ok:true,action:'new-chat',incomplete:false,...options.error}:
     {ok:true,matches:true,effort:'max',model:'native-model',...options.composer}}]}};
 const readJournal=async()=>({ok:true,meta:{sequence:events.length,active:active?{[tabId]:active}:{}},events:structuredClone(events)});
 const append=async(e:V)=>{appended.push(e);if(e.kind==='goal.unsent_release')active=null;};
 const controller={handoffAfterUnsent:async(args:V)=>{recovered++;assert.equal(args.witness.userText,'Manual addition');
   return {ok:true,handoff:{...hCurrent,navigationRecoveries:1}};}};
 const fn=new Function('handoffWrites','handoffKey','chrome','ChatGPTGoalPolicy','readJournal','inspectCompletedTurn','inspectChatError','controlChatComposer','appendJournal','goalController',
   body+';return recoverHandoffAfterUnsentGoal;')(new Map(),()=> 'handoff',chrome,{canonical:(x:string)=>x},readJournal,
   function inspectCompletedTurn(){},function inspectChatError(){},function controlChatComposer(){},append,controller);
 const result=await fn(tabId,h);return {result,recovered,appended,notifications};
}
{
 const x=await fixture();assert.equal(x.result.ok,true);assert.equal(x.recovered,1);
 assert.equal(x.appended.filter(e=>e.kind==='goal.unsent_release').length,1);
 assert.equal(x.notifications.length,1);
}
for(const options of [
 {active:{consumed:true}},{native:{generating:true}},{native:{userText:'Changed'}},{native:{isLatest:false}},
 {error:{action:'retry'}},{composer:{matches:false}},{goal:{stopRequested:true}},{goal:{operation:{id:'old-goal-operation',status:'clicked',tabId:7,createdAt:100}}},
 {extraEvents:[{kind:'send.authorized',operationId:'old-goal-operation',tabId:7,sourceUrl:url}]},
 {extraEvents:[{kind:'handoff.navigation_intent',operationId:'handoff-operation',tabId:7,sourceUrl:url}]},
 {extraEvents:[{kind:'request.started',tabId:8,sourceUrl:url,requestId:'later',eventAt:300}]}
]){const x=await fixture(options);assert.equal(x.result.ok,false,JSON.stringify(options));assert.equal(x.recovered,0);assert.equal(x.notifications.length,0);}
// The actual GET entry point reconnects a saved source handoff to recovery.
{
 const start=source.indexOf('async function handleHandoffMessage('),end=source.indexOf('  const previous = handoffWrites.get(tabId) || Promise.resolve();',start);
 assert.ok(end>start);
 const prefix=source.slice(start,end)+'\n}';let calls=0;
 const handoff={id:'transfer',stage:'navigating',sourceUrl:url};
 const handler=new Function('handoffKey','handoffWrites','chrome','ChatGPTGoalPolicy','recoverHandoffAfterUnsentGoal','goalController',prefix+';return handleHandoffMessage;')(
  ()=> 'handoff',new Map(),{storage:{local:{get:async()=>({handoff})}},tabs:{get:async()=>({url})}},
  {canonical:(x:string)=>x},async()=>{calls++;return {ok:false,record:handoff};},
  {handoffBegin:async()=>{},get:async()=>null});
 const result=await handler({type:'CHATGPT_HANDOFF_GET'},7);
 assert.equal(calls,1);assert.equal(result.record.id,handoff.id);
}
// A worker restart after the atomic write may replay readiness, never a click.
{
 const start=source.indexOf('async function handleHandoffMessage('),end=source.indexOf('  const previous = handoffWrites.get(tabId) || Promise.resolve();',start);
 const prefix=source.slice(start,end)+'\n}',sent:V[]=[];
 const handoff={id:'transfer',stage:'navigating',sourceUrl:url,navigationRecoveries:1,navigationRecovery:{userId:'manual-user'}};
 let journalEvents:V[]=[];
 const handler=new Function('handoffKey','handoffWrites','chrome','ChatGPTGoalPolicy','readJournal','goalController',prefix+';return handleHandoffMessage;')(
  ()=> 'handoff',new Map(),{storage:{local:{get:async()=>({handoff})}},tabs:{get:async()=>({url}),sendMessage:async(_id:number,m:V)=>{sent.push(m);}}},
  {canonical:(x:string)=>x},async()=>({ok:true,events:journalEvents}),
  {handoffBegin:async()=>{},get:async()=>({phase:'handoff',handoffId:'transfer',recoveredUnsentOperationId:'old'})});
 await handler({type:'CHATGPT_HANDOFF_GET'},7);assert.equal(sent.length,1);assert.equal(sent[0].type,'CHATGPT_HANDOFF_NAVIGATION_READY');
 journalEvents=[{operationId:'transfer',kind:'handoff.navigation_intent'}];
 await handler({type:'CHATGPT_HANDOFF_GET'},7);assert.equal(sent.length,1,'persisted click intent is never replayed');
}
console.log('Unspent Goal handoff recovery: exact manual witness, one-use grant release, no replay and race fences passed.');
