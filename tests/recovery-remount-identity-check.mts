import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/content-script.js','utf8');
const fn=source.slice(source.indexOf('  async function routeError('),source.indexOf('  function currentErrors()',source.indexOf('  async function routeError(')));
async function check(initial:string,rendered:string,binding:any,recovery=true,remountDuringAudit=false){
 let audits=0,handled=0,scheduled=0;const alert:any={},fingerprint='f',seen=new Map([[alert,{}]]),visible=new Set([fingerprint]);
 const c=createContext({location:{pathname:'/c/test'},globalThis:{__chatgptNotifierAttemptId:'1',__chatgptNotifierRequestId:'req'},document:{querySelectorAll:()=>[alert]},ERROR_SELECTOR:'x',runtimeMessage:async()=>({ok:true,action:'retry',recoveryBinding:binding}),latestPromptSnapshot:()=>rendered?{promptKey:rendered}:null,recoveryFirstSeen:seen,visibleErrors:visible,scheduleErrorCheck:()=>scheduled++,audit:async()=>{audits++;if(remountDuringAudit)rendered='/c/test|new-user'},retryState:()=>({}),normalize:(s:string)=>s,handleError:()=>handled++});
 runInContext(fn,c);await c.routeError({recovery,fingerprint},initial,alert);return {audits,handled,scheduled,visible:visible.has(fingerprint)};
}
assert.deepEqual(await check('/c/test','/c/test|user',null),{audits:0,handled:0,scheduled:1,visible:false});
assert.deepEqual(await check('/c/test','',null),{audits:0,handled:0,scheduled:1,visible:false});
assert.deepEqual(await check('/c/test|user','/c/test|user',null),{audits:1,handled:1,scheduled:0,visible:true});
assert.deepEqual(await check('/c/test','',{kind:'assistant-only'}),{audits:1,handled:1,scheduled:0,visible:true});
assert.deepEqual(await check('/c/test|user','/c/test|user',null,true,true),{audits:1,handled:0,scheduled:1,visible:false});
console.log('Recovery remount: unstable and unbound route-only prompts defer without consuming a retry; bound turns retain normal behavior.');
