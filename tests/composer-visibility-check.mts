import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

const source=readFileSync('extension/content-script.js','utf8');
function section(from:string,to:string) {
  const start=source.indexOf(from),end=source.indexOf(to,start);
  assert.ok(start>=0&&end>start);
  return source.slice(start,end);
}
const helpers=section('  function pageRoot() {','  function turnNodes() {')+
  section('  function isElementVisible(node) {','  // Match the error component,')+
  section('  function composer() {','  function editorText(')+
  section('  function sendButton() {','  async function sleepUntilNextCheck() {');
const url='https://chatgpt.com/c/composer-visibility-fixture';
const authorized='Explicit synthetic Goal payload';
const draft='  Owner draft\nKeep exact spacing  ';
function form(id:string,text:string) {
  return `<form data-composer-body id="${id}"><div class="editor-wrap"><div contenteditable="true" data-composer-markdown>${text}</div></div><button type="submit" data-testid="send-button">Send</button></form>`;
}
function fixture(hiddenAttributes='',activeText=authorized,extra='') {
  const {document,window}=parseHTML(`<html><body>${extra}<section ${hiddenAttributes}>${form('retained',authorized)}</section>${form('active',activeText)}</body></html>`);
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{configurable:true,value(this:HTMLElement){
    return this.closest('[data-zero-size]')?[{width:0,height:0}]:[{width:240,height:32}];
  }});
  Object.defineProperty(window,'getComputedStyle',{configurable:true,value:(el:HTMLElement)=>({
    display:el.style.display||'block',
    visibility:el.closest('[data-css-hidden]')?'hidden':el.closest('[data-css-collapse]')?'collapse':'visible'
  })});
  const clicks:string[]=[];
  for(const composer of document.querySelectorAll('form')) {
    const editor=composer.querySelector('[contenteditable]');
    if(editor)(editor.parentElement as any).__reactFiber$fixture={memoizedProps:{composerController:{
      view:{dom:editor},getChatGptPrompt:()=>({prompt:editor.textContent}),getPlainText:()=>editor.textContent,
      pendingSubmit:null,submitReady:true
    }}};
    composer.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>clicks.push(composer.id+':'+button.id)));
  }
  const context=createContext({document,location:{href:url},options:{url,text:authorized,action:'send'}});
  runInContext(helpers+'\n'+readFileSync('extension/page-probe.js','utf8'),context);
  const selected=()=>runInContext('composer()',context);
  const control=()=>runInContext('controlChatComposer(options)',context);
  return {document,context,clicks,selected,control};
}

// Hidden retained shells can have normal layout boxes and remain connected.
// The inline control and both actual sender worlds must select the same editor.
for(const attributes of ['hidden','inert','aria-hidden="true"','data-app-shell-active-page="false"',
  'data-css-hidden','data-css-collapse','data-zero-size']) {
  const env=fixture(attributes);
  const active=env.document.querySelector('#active [contenteditable]');
  assert.equal(env.selected(),active,attributes+' cannot hold the content sender');
  assert.equal(env.control().clicked,true,attributes+' cannot hold the native sender');
  assert.deepEqual(env.clicks,['active:']);
  const owner=fixture(attributes,draft);
  assert.equal(owner.selected(),owner.document.querySelector('#active [contenteditable]'));
  assert.equal(owner.control().ok,false,'the visible owner draft blocks automation');
  assert.equal(owner.document.querySelector('#active [contenteditable]')!.textContent,draft);
  assert.deepEqual(owner.clicks,[],'neither retained nor active draft receives an unauthorized click');
}

{
  const env=fixture('aria-hidden="true"');
  const active=env.document.querySelector('#active')!;
  const hidden=env.document.createElement('button');
  hidden.type='submit';hidden.setAttribute('data-testid','send-button');hidden.setAttribute('aria-hidden','true');
  hidden.addEventListener('click',()=>env.clicks.push('hidden-button'));active.prepend(hidden);
  assert.equal(runInContext('sendButton()',env.context),active.querySelector('button:last-child'));
  assert.equal(env.control().clicked,true);
  assert.deepEqual(env.clicks,['active:'],'hidden buttons cannot receive an automatic click');
}

{
  const env=fixture('aria-hidden="true"',authorized,
    '<form data-composer-body id="unrelated"><button type="submit" data-testid="send-button">Unrelated native submit</button></form>');
  assert.equal(env.control().clicked,true);
  assert.deepEqual(env.clicks,['active:'],'the native button must belong to the inspected editor');
  env.document.querySelector('#active button')!.remove();
  assert.equal(env.control().ok,false,'a different form cannot supply a missing send button');
  assert.deepEqual(env.clicks,['active:']);
}

{
  const env=fixture('aria-hidden="true"');
  const active=env.document.querySelector('#active')!;
  active.removeAttribute('data-composer-body');
  active.querySelector('.editor-wrap')!.setAttribute('data-composer-body','');
  assert.equal(env.control().clicked,true,'a toolbar beside the inner composer body still belongs to the same native form');
  assert.deepEqual(env.clicks,['active:']);
}

console.log('Actual composer selection: hidden/inactive/inert/zero-size shells, owner drafts and editor-bound buttons passed.');
