import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createContext,runInContext}from'node:vm';import{parseHTML}from'linkedom';
const source=readFileSync('extension/content-script.js','utf8'),from=source.indexOf('  function handoffNavigationButton('),until=source.indexOf('  async function beginHandoff(',from),visibleFrom=source.indexOf('  function isElementVisible('),visibleUntil=source.indexOf('  // Match the error component',visibleFrom);
assert.ok(from>0&&until>from&&visibleFrom>0);
function fixture(path='M8.16675 2.50115C8.53391 remainder',local=''){
 const {document,window}=parseHTML(`<html><body><section data-app-shell-active-page="false"><button id="cached" class="button-toolbar"><svg><path d="${path}"></path></svg></button></section><section data-app-shell-active-page="true"><aside role="alert" class="text-danger">最大長${local}</aside></section><button id="global" class="button-toolbar"><svg><path d="${path}"></path></svg></button></body></html>`);
 Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{width:30,height:30}],configurable:true});
 const ctx=createContext({document});runInContext('function pageRoot(){return document.querySelector(\'[data-app-shell-active-page="true"]\')||document;}'+source.slice(visibleFrom,visibleUntil)+source.slice(from,until),ctx);
 return {document,ctx,choose:(action='new-chat',escalated=false)=>runInContext(`handoffNavigationButton(document.querySelector('[data-app-shell-active-page="true"] aside'),{action:${JSON.stringify(action)}},${escalated})`,ctx)};
}
for(const path of ['M8.16675 2.50115C8.53391 remainder','M8.16675 2.50127C8.53391 remainder']){const f=fixture(path);assert.equal(f.choose()?.id,'global','native global New-chat icon tolerates the observed path precision change');assert.equal(f.choose('unknown'),null);assert.equal(f.choose('retry',true)?.id,'global','escalation shares the same navigation selector');}
{
 const f=fixture(undefined,'<button id="local">新しいチャット</button>');assert.equal(f.choose()?.id,'local');assert.equal(f.choose('unknown'),null);assert.equal(f.choose('retry',true)?.id,'global','escalation never clicks enabled Retry-like local control');
 for(const attribute of ['disabled','aria-disabled','aria-busy']){const local=f.document.querySelector('#local')!;local.setAttribute(attribute,attribute==='disabled'?'':'true');assert.equal(f.choose(),null,'disabled local control cannot be bypassed');assert.equal(f.choose('retry',true),null);local.removeAttribute(attribute);}
}
for(const attribute of ['hidden','inert','aria-hidden']){const f=fixture(),global=f.document.querySelector('#global')!;global.setAttribute(attribute,attribute==='aria-hidden'?'true':'');assert.equal(f.choose(),null,attribute);}
{
 const f=fixture();f.document.querySelector('#global')!.remove();assert.equal(f.choose(),null,'cached inactive page cannot supply navigation');
 const a=f.document.createElement('a');a.setAttribute('href','/');a.id='new-link';f.document.body.append(a);assert.equal(f.choose()?.id,'new-link','existing root-link fallback remains supported');
 f.document.querySelector('[data-app-shell-active-page="true"] aside')!.setAttribute('hidden','');assert.equal(f.choose(),null,'hidden terminal banner never authorizes navigation');
}
assert.ok(source.includes('button=handoffNavigationButton(alert,info,escalated);'));assert.ok(source.includes('await navigateHandoffSource(handoffRecord,alert,info,'));
console.log('Native new-chat navigation: absent alert control, icon precision, shared escalation, disabled-control refusal and retained/inert-page fences passed.');
