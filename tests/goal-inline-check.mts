import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

type GoalRecord={id:string;url:string;goal:string;rules:string;phase:string;continuations:number;maxContinuations:number;maxMinutes:number;deadlineAt:number;operation?:unknown};
type Request={type:string;action:string;url:string;goal?:string;rules?:string;maxContinuations?:number;maxMinutes?:number};
type Result={ok:boolean;record?:GoalRecord|null;url?:string;error?:string};
type Instance={refresh:()=>Promise<void>;dispose:()=>void};
const chat='https://chatgpt.com/c/synthetic-goal-a',other='https://chatgpt.com/c/synthetic-goal-b';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const source=readFileSync('extension/goal-inline.js','utf8');
const policy=readFileSync('extension/goal-policy.js','utf8');
function goal(url=chat,phase='waiting'):GoalRecord {
  return {id:url+'-goal',url,goal:'Complete synthetic objective',rules:'Synthetic criteria',phase,
    continuations:1,maxContinuations:5,maxMinutes:30,deadlineAt:Date.now()+1800000};
}
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
function fixture(initial=chat,beforeRoot=false,hiddenComposer=false,nestedReasoning=false) {
  const {window,document}=parseHTML('<html><head></head><body><main></main></body></html>');
  const calls:Request[]=[];
  let url=initial,record:GoalRecord|null=null,live=true,subscription:(()=>void)|null=null,unsubscribed=0;
  let responder:((value:Request)=>Result|Promise<Result>)|null=null;
  const state={nativeSends:0,draftReads:0};
  let nativeDraft='  untouched draft\nwith spacing  ';
  let editor:HTMLElement;
  const proto=window.HTMLElement.prototype;
  Object.defineProperty(proto,'getBoundingClientRect',{value(){return {left:240,top:600,width:100,height:30,right:340,bottom:630};},configurable:true});
  Object.defineProperty(proto,'getClientRects',{value(this:HTMLElement){const rect=this.getBoundingClientRect();return rect.width&&rect.height?[rect]:[];},configurable:true});
  function composer() {
    const form=document.createElement('form');
    form.innerHTML='<div data-composer-body><div id="prompt-textarea" contenteditable="true"></div><div class="toolbar"><button type="button" data-composer-navigation-target="reasoning">Thinking</button><button type="submit" data-testid="send-button">Send</button></div></div>';
    if(nestedReasoning) {
      const reasoning=form.querySelector('[data-composer-navigation-target=reasoning]')!;
      const outer=document.createElement('div');outer.className='flex min-w-0 flex-1 justify-end';
      outer.innerHTML='<div class="flex min-w-0 items-center" data-native-effort-row><div class="min-w-0"><span class="max-w-full"></span></div></div>';
      reasoning.before(outer);outer.querySelector('span')!.append(reasoning);
    }
    editor=form.querySelector('#prompt-textarea')! as unknown as HTMLElement;
    // Reading the user's actual draft is a regression, even if no send follows.
    Object.defineProperty(editor,'textContent',{get(){state.draftReads++;return nativeDraft;},set(value){nativeDraft=String(value);},configurable:true});
    form.addEventListener('submit',event=>{event.preventDefault();state.nativeSends++;});
    document.querySelector('main')!.append(form);
    return form;
  }
  if(nestedReasoning)Object.defineProperty(window,'getComputedStyle',{value:(el:HTMLElement)=>({
    display:el.classList.contains('flex')?'flex':el.localName==='span'?'inline':el.localName==='button'?'flex':'block',
    flexDirection:'row',visibility:'visible'
  }),configurable:true});
  let form=composer();
  let hiddenForm:typeof form|null=null;
  if(hiddenComposer) {
    hiddenForm=form;
    const hiddenShell=document.createElement('section');
    hiddenForm.before(hiddenShell);hiddenShell.append(hiddenForm);
    hiddenShell.setAttribute('data-app-shell-active-page','false');
    // Hidden ancestors can leave each descendant's own computed display intact.
    for(const el of hiddenForm.querySelectorAll('#prompt-textarea,button'))
      Object.defineProperty(el,'getBoundingClientRect',{value:()=>({left:0,top:0,width:0,height:0,right:0,bottom:0}),configurable:true});
    form=composer();
    const activeShell=document.createElement('section');
    form.before(activeShell);activeShell.append(form);activeShell.setAttribute('data-app-shell-active-page','true');
  }
  const html=document.documentElement;
  if(beforeRoot)html.remove();
  const context=createContext({document,console,URL,Date});
  runInContext(policy,context);runInContext(source,context);
  const instance:Instance=runInContext('ChatGPTGoalInline',context).create({document,getUrl:()=>url,alive:()=>live,
    request:async(value:Request)=>{
      calls.push(value);
      if(responder)return responder(value);
      if(value.action==='start')record={...goal(value.url),goal:value.goal!,rules:value.rules!,maxContinuations:value.maxContinuations!,maxMinutes:value.maxMinutes!};
      if(value.action==='pause'&&record)record={...record,phase:'paused'};
      if(value.action==='resume'&&record)record={...record,phase:'waiting'};
      if(value.action==='stop'&&record)record={...record,phase:'stopped'};
      return {ok:true,url:value.url,record};
    },subscribe:(fn:()=>void)=>{subscription=fn;return ()=>{subscription=null;unsubscribed++;};}});
  function element<T=HTMLButtonElement>(selector:string):T {
    const result=document.querySelector(selector);assert.ok(result,selector);return result as unknown as T;
  }
  return {document,window,calls,state,instance,element,
    toggle:()=>element('[role=switch]'),details:()=>element('[aria-label="Goal settings"]'),panel:()=>element<HTMLElement>('[data-chatgpt-goal-inline=panel]'),
    field:(name:string)=>element<HTMLInputElement|HTMLTextAreaElement>('[data-goal-field='+name+']'),
    action:(name:string)=>element('[data-goal-action='+name+']'),
    setUrl:(value:string)=>{url=value;},setRecord:(value:GoalRecord|null)=>{record=value;},
    respond:(fn:typeof responder)=>{responder=fn;},notify:()=>subscription?.(),
    remount:()=>{form.remove();form=composer();},
    ready:()=>{document.append(html);document.dispatchEvent(new window.Event('readystatechange'));document.dispatchEvent(new window.Event('DOMContentLoaded'));},
    hiddenForm:()=>hiddenForm,nativeForm:()=>form,draft:()=>nativeDraft,unsubscribed:()=>unsubscribed,setLive:(value:boolean)=>{live=value;}};
}

// This turns red if setup captures a native draft, a Goal click submits its
// enclosing native form, or an explicit click can authorize more than one action.
{
  const f=fixture();await tick();
  assert.equal(f.toggle().getAttribute('aria-checked'),'false');
  assert.equal(f.toggle().parentElement?.previousElementSibling?.getAttribute('data-composer-navigation-target'),'reasoning');
  assert.deepEqual(f.calls.map(call=>call.action),['get']);
  f.toggle().click();
  assert.equal(f.panel().parentElement,f.document.body,'setup is a portal outside native form');
  assert.equal(f.panel().hidden,false);
  assert.equal(f.field('goal').value,'','objective is never captured from draft');
  assert.equal(f.field('maxContinuations').value,'5');assert.equal(f.field('maxMinutes').value,'30');
  let nativeKeydowns=0;
  f.document.addEventListener('keydown',()=>nativeKeydowns++);
  f.field('goal').dispatchEvent(new f.window.Event('keydown',{bubbles:true,cancelable:true}));
  assert.equal(nativeKeydowns,0,'typing is not delegated to native ChatGPT');
  f.field('goal').value='  Explicit objective  ';
  f.field('rules').value='Complete the checks';
  f.action('start').click();f.action('start').click();
  await tick();
  assert.equal(f.calls.filter(call=>call.action==='start').length,1);
  const start=f.calls.find(call=>call.action==='start')!;
  assert.equal(start.goal,'Explicit objective');assert.equal(start.rules,'Complete the checks');
  assert.equal(start.maxContinuations,5);assert.equal(start.maxMinutes,30);
  assert.equal(f.toggle().getAttribute('aria-checked'),'true');
  assert.equal(f.field('goal').disabled,true);
  f.action('pause').click();await tick();
  assert.equal(f.action('resume').hidden,false);
  assert.equal(f.toggle().getAttribute('aria-checked'),'true','paused Goal remains armed');
  f.action('resume').click();await tick();
  assert.equal(f.action('pause').hidden,false);
  f.toggle().click();await tick();
  assert.equal(f.calls.at(-1)!.action,'stop','Off explicitly stops Goal via coordinator');
  assert.equal(f.toggle().getAttribute('aria-checked'),'false');
  assert.equal(f.state.draftReads,0);assert.equal(f.draft(),'  untouched draft\nwith spacing  ');assert.equal(f.state.nativeSends,0);
  const escape=new f.window.Event('keydown',{bubbles:true,cancelable:true});
  Object.defineProperty(escape,'key',{value:'Escape'});f.field('goal').dispatchEvent(escape);
  assert.equal(f.panel().hidden,true);assert.equal(escape.defaultPrevented,true);
  f.instance.dispose();assert.equal(f.unsubscribed(),1);
  assert.equal(f.document.querySelector('[data-chatgpt-goal-inline]'),null);
  assert.equal(f.nativeForm().isConnected,true,'dispose never removes native React-owned DOM');
}

// Failed starts/stops leave the durable state visible; pending requests disable
// all actions, and a subscription notification cannot resurrect a stale result.
{
  const f=fixture();await tick();f.toggle().click();f.field('goal').value='Explicit';
  const pending=deferred<Result>();f.respond(()=>pending.promise);
  f.action('start').click();assert.equal(f.toggle().disabled,true);assert.equal(f.action('start').disabled,true);
  f.notify();assert.equal(f.calls.length,2,'storage refresh waits for in-flight control');
  f.respond(null);pending.resolve({ok:false,error:'Storage unavailable'});await tick();
  assert.equal(f.toggle().getAttribute('aria-checked'),'false');
  assert.equal(f.calls.filter(value=>value.action==='start').length,1,'failure is never automatically retried');
  f.respond(()=>({ok:false,error:'Storage unavailable'}));f.action('start').click();await tick();
  assert.match(f.panel().textContent!,/Storage unavailable/);
  assert.equal(f.field('goal').value,'Explicit','error preserves setup for this chat');
  f.respond(null);f.setRecord(goal());await f.instance.refresh();
  f.respond(()=>{throw Error('Control disconnected');});f.toggle().click();await tick();
  assert.equal(f.toggle().getAttribute('aria-checked'),'true','failed stop never pretends Goal is off');
  assert.match(f.panel().textContent!,/Control disconnected/);f.instance.dispose();
}

// Route fences reject a late Start/Get and do not leak objectives or state into
// a different conversation. New chats remain off and require a first message.
{
  const f=fixture();await tick();f.toggle().click();f.field('goal').value='Chat A only';
  const pending=deferred<Result>();f.respond(()=>pending.promise);f.action('start').click();
  f.setUrl(other);f.respond(()=>({ok:true,url:other,record:null}));await f.instance.refresh();
  assert.equal(f.field('goal').value,'');assert.equal(f.panel().hidden,true);
  pending.resolve({ok:true,url:chat,record:goal()});await tick();
  assert.equal(f.toggle().getAttribute('aria-checked'),'false');assert.equal(f.field('goal').value,'');
  f.respond(()=>({ok:true,url:chat,record:goal()}));await f.instance.refresh();
  f.details().click();assert.match(f.panel().textContent!,/another chat/);
  assert.equal(f.toggle().disabled,true,'wrong-chat response cannot authorize actions');
  f.setUrl('https://chatgpt.com/');await f.instance.refresh();
  assert.equal(f.toggle().disabled,true);assert.equal(f.toggle().getAttribute('aria-checked'),'false');
  f.details().click();assert.match(f.panel().textContent!,/first message/);assert.equal(f.action('start').disabled,true);
  f.respond(null);f.setUrl(other);await f.instance.refresh();assert.equal(f.toggle().disabled,false);f.instance.dispose();
}

// Remount and disposal exercise the production MutationObserver, including
// pending responses arriving after disposal. No timers/browser are required.
{
  const f=fixture();await tick();f.setRecord(goal());f.notify();await tick();
  const oldToggle=f.toggle();f.remount();await tick();
  assert.equal(f.document.querySelectorAll('[role=switch]').length,1);
  assert.equal(f.toggle(),oldToggle,'only extension-owned controls move');
  assert.equal(f.toggle().parentElement?.previousElementSibling?.getAttribute('data-composer-navigation-target'),'reasoning');
  const count=f.calls.length;
  for(let i=0;i<8;i++)f.document.querySelector('main')!.append(f.document.createElement('p'));
  await tick();assert.equal(f.calls.length,count,'streaming does not refetch or schedule requests');
  f.details().click();const pending=deferred<Result>();f.respond(()=>pending.promise);
  f.action('pause').click();f.instance.dispose();f.instance.dispose();
  pending.resolve({ok:true,url:chat,record:goal(chat,'paused')});await tick();
  f.remount();await tick();assert.equal(f.document.querySelector('[data-chatgpt-goal-inline]'),null);
  assert.equal(f.unsubscribed(),1);assert.equal(f.state.draftReads,0);assert.equal(f.state.nativeSends,0);
}

// A reserved operation is a known pre-click refusal, not an unknown send.
{
  const f=fixture();await tick();
  f.setRecord({...goal(chat,'blocked'),operation:{status:'reserved'}});await f.instance.refresh();f.details().click();
  assert.match(f.panel().textContent!,/Message was not sent/);assert.doesNotMatch(f.panel().textContent!,/Previous send is unconfirmed/);
  assert.equal(f.action('start').disabled,true);
  f.setRecord({...goal(chat,'blocked'),operation:{status:'intent'}});await f.instance.refresh();
  assert.match(f.panel().textContent!,/Previous send is unconfirmed/);f.instance.dispose();
}

// The real effort button is display:flex inside an inline span and a block
// wrapper. Controls join its existing row without restyling native wrappers.
{
  const f=fixture(chat,false,false,true);await tick();
  const row=f.document.querySelector('[data-native-effort-row]')!;
  const nativeItem=row.firstElementChild!;
  assert.equal(f.toggle().parentElement!.parentElement,row,'Goal is a peer in the effort row');
  assert.equal(f.toggle().parentElement!.previousElementSibling,nativeItem);
  assert.equal(nativeItem.localName,'div');
  const wrapper=nativeItem.firstElementChild!;
  assert.equal(wrapper.localName,'span');assert.equal(wrapper.children.length,1,'native effort span keeps one button');
  assert.equal(wrapper.firstElementChild!.getAttribute('data-composer-navigation-target'),'reasoning');
  assert.equal(nativeItem.getAttribute('style'),null);assert.equal(wrapper.getAttribute('style'),null);
  assert.equal(nativeItem.className,'min-w-0');assert.equal(wrapper.className,'max-w-full');
  f.instance.dispose();assert.equal(row.children.length,1);assert.equal(nativeItem.isConnected,true);
}

// ChatGPT preserves hidden composers across SPA navigation. The controls must
// follow the active visible composer even while the previous anchor stays live.
{
  const f=fixture(chat,false,true);await tick();
  assert.equal(f.hiddenForm()!.isConnected,true);
  assert.equal(f.toggle().closest('form'),f.nativeForm(),'initial mounting skips retained inactive composer');
  assert.equal(f.hiddenForm()!.querySelector('[role=switch]'),null);
  const oldForm=f.nativeForm(),oldToggle=f.toggle();
  const activeShell=oldForm.parentElement!;
  activeShell.setAttribute('data-app-shell-active-page','false');
  const next=f.document.createElement('section');next.setAttribute('data-app-shell-active-page','true');
  next.innerHTML='<form><div id="prompt-textarea" contenteditable="true"></div><button type="button" data-composer-navigation-target="reasoning">Thinking</button></form>';
  f.document.querySelector('main')!.append(next);await tick();
  assert.equal(oldForm.isConnected,true);
  assert.equal(f.toggle(),oldToggle);assert.equal(f.toggle().closest('form'),next.querySelector('form'));
  assert.equal(oldForm.querySelector('[role=switch]'),null);
  assert.equal(f.document.querySelectorAll('[role=switch]').length,1);
  // Visibility can also change without adding/removing any native nodes.
  const retained=next.querySelector('form')!;
  activeShell.setAttribute('data-app-shell-active-page','true');next.setAttribute('data-app-shell-active-page','false');
  await tick();assert.equal(f.toggle().closest('form'),oldForm,'attribute-only page activation reattaches controls');
  assert.equal(retained.isConnected,true);f.instance.dispose();
}

// Even without app-shell markers, zero-size native controls are not active.
{
  const f=fixture(chat,false,true);await tick();
  for(const shell of f.document.querySelectorAll('[data-app-shell-active-page]'))shell.removeAttribute('data-app-shell-active-page');
  await f.instance.refresh();
  assert.equal(f.toggle().closest('form'),f.nativeForm());
  // Remove the active controls to force candidate selection with the hidden
  // composer first in document order, rather than merely exercising fast-path.
  f.toggle().parentElement!.remove();await tick();
  assert.equal(f.toggle().closest('form'),f.nativeForm());
  assert.equal(f.hiddenForm()!.querySelector('[role=switch]'),null);
  const oldForm=f.nativeForm();
  const next=oldForm.cloneNode(true) as unknown as HTMLElement;
  next.querySelector('[data-chatgpt-goal-inline]')?.remove();f.document.querySelector('main')!.append(next);await tick();
  assert.equal(f.toggle().closest('form'),oldForm);
  for(const el of oldForm.querySelectorAll('#prompt-textarea,button'))
    Object.defineProperty(el,'getBoundingClientRect',{value:()=>({left:0,top:0,width:0,height:0,right:0,bottom:0}),configurable:true});
  oldForm.setAttribute('style','display:none');await tick();
  assert.equal(oldForm.isConnected,true);assert.equal(f.toggle().closest('form'),next,'hidden connected anchor does not hold the fast-path');
  f.instance.dispose();
}

// A document_start script must survive a missing root/head, initialize once
// when parsing reaches readiness, and stay disposed if readiness arrives later.
{
  const f=fixture(chat,true);
  assert.equal(f.document.documentElement,null);assert.equal(f.calls.length,0);
  await f.instance.refresh();assert.equal(f.calls.length,0);
  f.ready();await tick();
  assert.equal(f.calls.length,1,'multiple readiness events initialize only once');
  assert.equal(f.document.querySelectorAll('[data-chatgpt-goal-inline=style]').length,1);
  assert.equal(f.toggle().getAttribute('aria-checked'),'false');
  f.remount();await tick();assert.equal(f.document.querySelectorAll('[role=switch]').length,1);
  f.instance.dispose();assert.equal(f.document.querySelector('[data-chatgpt-goal-inline]'),null);
  const disposed=fixture(chat,true);disposed.instance.dispose();disposed.ready();
  await tick();await disposed.instance.refresh();
  assert.equal(disposed.calls.length,0,'readiness cannot revive a disposed instance');
  assert.equal(disposed.document.querySelector('[data-chatgpt-goal-inline]'),null);
  assert.equal(disposed.unsubscribed(),1);
}

console.log('Inline Goal explicit authorization, state controls, draft isolation, route fences, remount and disposal passed.');
