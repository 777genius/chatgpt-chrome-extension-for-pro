import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createContext,runInContext}from'node:vm';import{parseHTML}from'linkedom';
const ctx=createContext({});runInContext(readFileSync('extension/handoff-history.js','utf8'),ctx);const select=(m:any[],e:any[])=>JSON.parse(JSON.stringify(ctx.ChatGPTHandoffHistory.select(m,e,'https://chatgpt.com/c/source')));
const sourceUrl='https://chatgpt.com/c/source',op='automatic',tabId=1,events=[{kind:'retry.send_intent',operationId:op,sourceUrl,tabId},{kind:'send.authorized',operationId:op,sourceUrl,tabId},{kind:'send.dispatched',operationId:op,sourceUrl,tabId,text:'доделай е2е'},{kind:'request.started',operationId:op,sourceUrl,tabId,eventAt:100000}];
const messages=[{role:'user',id:'manual',text:'доделай е2е',sentAtMs:50000},{role:'assistant',id:'a',text:'Detailed progress'}, {role:'user',id:'auto',text:'доделай е2е',sentAtMs:100050},{role:'assistant',id:'blocked',text:'GOAL_BLOCKED'}, {role:'assistant',id:'quoted',text:'The marker GOAL_BLOCKED appears in this explanation.'},{role:'user',id:'new',text:'Why?',sentAtMs:150000}];
assert.deepEqual(select(messages,events).map((x:any)=>x.id),['manual','a','quoted','new'],'exclude only positively matched automatic send and exact marker');
const markdownMarkers=[{role:'assistant',id:'complete',text:'GOAL\\_COMPLETE'},
 {role:'assistant',id:'blocked',text:'GOAL\\_BLOCKED'},
 {role:'assistant',id:'explanation',text:'Explanation: GOAL\\_BLOCKED'}];
assert.deepEqual(select(markdownMarkers,[]).map((x:any)=>x.id),['explanation'],'escaped standalone Markdown markers are excluded without removing explanations');
assert.ok(select(messages,[]).some((x:any)=>x.id==='auto'),'missing journal evidence preserves matching text');
assert.ok(select(messages,events.filter(e=>e.kind!=='retry.send_intent')).some((x:any)=>x.id==='auto'),'a handoff payload without a retry or Goal intent is retained');
const initialEvents=events.map(e=>e.kind==='retry.send_intent'?{...e,kind:'goal.send_intent'}:e);
assert.ok(select(messages,[...initialEvents,{kind:'goal.started',operationId:op,sourceUrl,tabId}]).some((x:any)=>x.id==='auto'),
 'a user-authored initial Goal is retained even when the extension sent it');
assert.ok(select(messages,[...events,{kind:'request.started',operationId:null,sourceUrl,tabId,eventAt:100001}]).some((x:any)=>x.id==='auto'),'ambiguous nearby manual send preserves text');
const noTime=messages.map(x=>x.id==='auto'?{...x,sentAtMs:undefined,promptKey:'/c/source|native:0:user'}:x);
assert.ok(!select(noTime,[...events,{kind:'retry.confirmed',operationId:op,sourceUrl,tabId,promptKey:'/c/source|native:0:user'}]).some((x:any)=>x.id==='auto'),'exact confirmed native prompt identity works without a timestamp');
assert.ok(select(noTime,[...events,{kind:'retry.confirmed',operationId:op,sourceUrl,tabId,promptKey:'/c/source|other:0:user'}]).some((x:any)=>x.id==='auto'),'a different prompt identity never suppresses a user message');
const many=Array.from({length:30},(_,i)=>[{role:'user',id:'u'+i,text:'User '+i},{role:'assistant',id:'a'+i,text:'Answer '+i}]).flat();const result=select(many,[]);assert.equal(result.length,40);assert.equal(result[0].id,'u10');assert.equal(result.at(-1).id,'a29');
// Exercise the boundary from the native error's React history to the worker
// filter, including a user-authored Goal sent by the extension itself.
const dom=parseHTML('<aside role="alert" class="text-danger"><button>New chat</button></aside>');
const entries=Array.from({length:25},(_,i)=>({id:'turn-'+i,turn:{items:[
 {type:'user-message',messageId:'native-u'+i,message:'User '+i},
 {type:'assistant-message',messageId:'native-a'+i,phase:'final_answer',content:'Answer '+i}]} }));
entries.push({id:'turn-auto',turn:{items:[{type:'user-message',messageId:'native-auto',message:'доделай е2е'},
 {type:'assistant-message',messageId:'native-marker',phase:'final_answer',content:'GOAL\\_BLOCKED'}]}} as any);
const button=dom.document.querySelector('button')! as any;
button.__reactFiber$test={memoizedProps:{children:{props:{id:'chatgptConversations.responseError.startNewChat'}}},return:{memoizedProps:{entries,isChatConversation:true,conversationId:'source',isConversationFetching:false,isConversationLoading:false,hasLoadError:false},return:null}};
const nativeCtx=createContext({document:dom.document,URL,location:{pathname:'/c/source'}});
runInContext(readFileSync('extension/page-probe.js','utf8'),nativeCtx);
const captured=JSON.parse(JSON.stringify(runInContext('inspectChatError(0,true)',nativeCtx)));
assert.equal(captured.action,'new-chat');assert.equal(captured.incomplete,false);
const autoEvents=[...events,{kind:'retry.confirmed',operationId:op,sourceUrl,tabId,userId:'native-auto'}];
const initialOp='initial-goal',initialEvents2=[{kind:'goal.started',operationId:initialOp,sourceUrl,tabId},
 {kind:'goal.send_intent',operationId:initialOp,sourceUrl,tabId},{kind:'send.authorized',operationId:initialOp,sourceUrl,tabId},
 {kind:'send.dispatched',operationId:initialOp,sourceUrl,tabId,text:'User 10'},
 {kind:'request.started',operationId:initialOp,sourceUrl,tabId,eventAt:300000},
 {kind:'goal.confirmed',operationId:initialOp,sourceUrl,tabId,userId:'native-u10'}];
const filtered=select(captured.messages,[...autoEvents,...initialEvents2]);
assert.equal(filtered.length,40);assert.ok(filtered.some((x:any)=>x.id==='native-u10'),'initial Goal survives native capture');
assert.ok(!filtered.some((x:any)=>['native-auto','native-marker'].includes(x.id)),'automatic retry and escaped marker are removed');
assert.equal(filtered[0].id,'native-u5');assert.equal(filtered.at(-1).id,'native-a24');
console.log('Handoff history: 20 chronological messages per role; automatic retries need exact durable provenance; standalone terminal markers omitted.');
