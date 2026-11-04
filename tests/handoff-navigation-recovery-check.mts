import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createContext,runInContext}from'node:vm';
const source=readFileSync('extension/content-script.js','utf8'),from=source.indexOf('  const handoffNavigationClaims='),until=source.indexOf('  async function beginHandoff(',from);assert.ok(from>0&&until>from);
async function fixture(change='',recover=false){
 const url='https://chatgpt.com/c/source-fixture',record={id:'saved-transfer',sourceUrl:url,stage:'navigating',draft:'Owner draft',reasoningEffort:'pro',reasoningModel:'gpt-test',navigationRecoveries:1},editor={text:'Owner draft'},location={href:url,pathname:'/c/source-fixture'};
 let clicks=0,sends=0,gets=0,failures=0,afterIntent=false;const events:string[]=[];
 const button={disabled:false,click(){clicks++;events.push('click');location.href='https://chatgpt.com/';}},alert={isConnected:true,matches:()=>true};
 const ctx=createContext({Set,location,handoffRecord:record,runtimeAvailable:()=>true,isGenerating:()=>change==='generation-after'&&afterIntent,composer:()=>editor,rawEditorText:(e:any)=>e.text,composerHasAttachments:()=>change==='attachment',reasoningMode:async()=>({value:change==='mode'||change==='mode-after'&&afterIntent?'medium':'pro',model:'gpt-test'}),handoffNavigationButton:()=>change==='missing-button'||change==='button-after'&&afterIntent?null:button,
  audit:async(kind:string,_d:any,required:boolean)=>{assert.equal(required,true);events.push(kind);if(kind==='handoff.navigation_intent'){afterIntent=true;if(change==='route-after')location.href='https://chatgpt.com/c/other';if(change==='journal')throw Error('Journal refused');if(change==='journal-duplicate')throw Object.assign(Error('Already claimed'),{code:'RETRY_DUPLICATE'});if(change==='draft')editor.text='New owner draft';}},
  updateHandoff:async()=>{failures++;record.stage='failed';},waitHandoff:async(check:()=>boolean)=>assert.equal(check(),true),submitHandoff:async()=>{sends++;},
  runtimeMessage:async(m:any)=>{if(m.type==='CHATGPT_HANDOFF_GET'){gets++;return {ok:true,record};}if(m.type==='CHATGPT_INSPECT_ERROR')return {ok:true,action:'new-chat',messages:[{role:'user',text:'sent'}],incomplete:false};throw Error('Unexpected runtime message');},
  latestPromptSnapshot:()=>({promptKey:'source-user'}),currentErrors:()=>[alert],document:{querySelectorAll:()=>[alert]},ERROR_SELECTOR:'fixture'});
 ctx.args={sourceEditor:editor,draft:record.draft,sourceEffort:'pro',sourceModel:'gpt-test',sameSource:()=>location.href===url};ctx.record=record;ctx.alert=alert;
 runInContext(source.slice(from,until),ctx);
 if(recover){await Promise.all([runInContext(`resumeHandoffSourceNavigation({id:'saved-transfer',url:${JSON.stringify(url)}})`,ctx),runInContext(`resumeHandoffSourceNavigation({id:'saved-transfer',url:${JSON.stringify(url)}})`,ctx)]);}else{
  try{await runInContext(`navigateHandoffSource(record,alert,{action:'new-chat'},args)`,ctx);}catch{}
  await runInContext(`navigateHandoffSource(record,alert,{action:'new-chat'},args)`,ctx).catch(()=>{});
 }
 return {clicks,sends,gets,failures,events,editor};
}
const regular=await fixture();assert.equal(regular.clicks,1);assert.equal(regular.sends,1);assert.equal(regular.failures,0);assert.deepEqual(regular.events,['handoff.navigation_intent','click','handoff.navigation_clicked']);
const recovered=await fixture('',true);assert.equal(recovered.clicks,1);assert.equal(recovered.gets,1,'duplicate recovery messages claim one local observation');assert.equal(recovered.sends,1);
const duplicate=await fixture('journal-duplicate');assert.equal(duplicate.clicks,0);assert.equal(duplicate.failures,0,'a rejected duplicate context must not overwrite the active navigation record');
for(const change of ['mode','mode-after','attachment','missing-button','button-after','generation-after','route-after','draft','journal']){const f=await fixture(change);assert.equal(f.clicks,0,change);assert.equal(f.sends,0,change);if(change==='draft')assert.equal(f.editor.text,'New owner draft');}
assert.ok(source.includes("if(message?.type==='CHATGPT_HANDOFF_NAVIGATION_READY')"));
console.log('Saved pre-click handoff navigation: shared exact-once click, required durable intent, duplicate recovery, journal refusal and post-journal draft/mode fences passed.');
