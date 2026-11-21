import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
const {document,window}=parseHTML('<html><body><main data-app-shell-active-page="true"><div data-chatgpt-search-unit-key="turn-uuid:0:user">actual user</div><div data-chatgpt-search-unit-key="turn-uuid:2:assistant">actual answer</div><div hidden data-chatgpt-search-unit-key="fallback-turn-99:0:user">stale</div></main></body></html>');
Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value(){return this.hidden?[]:[{width:10,height:10}]},configurable:true});
if(document.defaultView!==window)Object.defineProperty(document,'defaultView',{value:window,configurable:true});
Object.defineProperty(window,'getComputedStyle',{value:(node:any)=>({display:node.style?.display||'block',visibility:node.style?.visibility||'visible'}),configurable:true});
const source=readFileSync('extension/content-script.js','utf8');
const start=source.indexOf('  function pageRoot() {'),end=source.indexOf('  function answerBoundToLatestPrompt()',start);
assert.ok(start>0&&end>start);
const c=createContext({document,location:{pathname:'/c/test'},normalize:(value:any)=>String(value||'').replace(/\s+/g,' ').trim()});
runInContext(source.slice(start,end),c);
const cssHidden=document.createElement('div');cssHidden.setAttribute('data-chatgpt-search-unit-key','turn-hidden:0:user');
cssHidden.style.visibility='hidden';cssHidden.textContent='invisible newer message';document.querySelector('main')!.append(cssHidden);
let result=runInContext('latestPromptSnapshot()',c);
assert.equal(result.promptKey,'/c/test|turn-uuid:0:user','CSS-hidden retained rows cannot replace the visible prompt');
assert.equal(result.assistantKey,'turn-uuid:2:assistant');assert.equal(result.response,'actual answer');
cssHidden.remove();
document.querySelector('[data-chatgpt-search-unit-key="turn-uuid:0:user"]')!.setAttribute('data-chatgpt-search-unit-key','fallback-turn-0:0:user');
result=runInContext('latestPromptSnapshot()',c);assert.equal(result.promptKey,'/c/test|fallback-turn-0:0:user');
document.querySelector('[data-chatgpt-search-unit-key="fallback-turn-0:0:user"]')!.setAttribute('inert','');
assert.equal(runInContext('latestPromptSnapshot()',c),null,'hidden or inert history cannot identify a current prompt');
console.log('Prompt identity: visible server and fallback units, hidden and inert history passed.');
// Exercise the real selector and error routing together: the exact native
// turn key, rather than the bare route, reaches the existing retry machinery.
const unit=document.querySelector('[data-chatgpt-search-unit-key="fallback-turn-0:0:user"]')!;
unit.removeAttribute('inert');unit.setAttribute('data-chatgpt-search-unit-key','turn-uuid:0:user');
const alert=document.createElement('div');alert.id='test-recovery-alert';document.querySelector('main')!.append(alert);
let handledKey='',scheduled=0,audits=0;
Object.assign(c,{ERROR_SELECTOR:'#test-recovery-alert',recoveryFirstSeen:new Map(),visibleErrors:new Set(['test-error']),
 runtimeMessage:async()=>({ok:true,action:'retry',recoveryBinding:{kind:'user',entryId:'turn-uuid',userId:'native-user'}}),
 scheduleErrorCheck:()=>scheduled++,audit:async()=>{audits++},retryState:()=>({}),handleError:(_error:any,key:string)=>{handledKey=key}});
runInContext('globalThis.__chatgptNotifierAttemptId="attempt"; globalThis.__chatgptNotifierRequestId="request"',c);
const routeStart=source.indexOf('  async function routeError('),routeEnd=source.indexOf('  function currentErrors()',routeStart);
assert.ok(routeStart>0&&routeEnd>routeStart);runInContext(source.slice(routeStart,routeEnd),c);
await runInContext('routeError({recovery:true,fingerprint:"test-error"},latestPromptSnapshot().promptKey,document.querySelector("#test-recovery-alert"))',c);
assert.equal(handledKey,'/c/test|turn-uuid:0:user');assert.equal(audits,1);assert.equal(scheduled,0);
console.log('Prompt identity integration: current server turn reaches the protected retry router.');
