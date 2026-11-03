import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

type GoalRecord={id:string;url:string;goal:string;rules:string;phase:string;continuations:number;maxContinuations:number;maxMinutes:number;deadlineAt:number;operation?:unknown};
type Config={rules:string;maxContinuations:number;maxMinutes:number};
type Composer={id:string;phase:'armed'|'intent'|'bound'|'disabled';url:string;config:Config;eventAt?:number;intent?:{text:string;baselineKey:string;eventAt:number};binding?:{url:string}};
type Request={type:string;action:string;url:string;armId?:string;text?:string;baselineKey?:string;eventAt?:number;rules?:string;maxContinuations?:number;maxMinutes?:number};
type Result={ok:boolean;record?:GoalRecord|null;composer?:Composer|null;url?:string;error?:string;pending?:boolean};
type Instance={refresh:()=>Promise<void>;dispose:()=>void;manualIntent:(value:{text:string;baselineKey:string;eventAt:number})=>Promise<{ok:boolean}>};
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
  let url=initial,record:GoalRecord|null=null,composerState:Composer|null=null,bindable=false,armCounter=0,nativeText='',live=true,subscription:(()=>void)|null=null,unsubscribed=0;
  let responder:((value:Request)=>Result|Promise<Result>)|null=null;
  const state={nativeSends:0,draftReads:0};
  let clock=1800000000000,timerId=0;
  const timers=new Map<number,{at:number;run:()=>void}>();
  Object.defineProperty(window,'setTimeout',{value:(run:()=>void,delay:number)=>{const id=++timerId;timers.set(id,{at:clock+delay,run});return id;},configurable:true});
  Object.defineProperty(window,'clearTimeout',{value:(id:number)=>timers.delete(id),configurable:true});
  class ClockDate extends Date {static override now(){return clock;}}
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
  const context=createContext({document,console,URL,Date:ClockDate});
  runInContext(policy,context);runInContext(source,context);
  const instance:Instance=runInContext('ChatGPTGoalInline',context).create({document,getUrl:()=>url,alive:()=>live,
    request:async(value:Request)=>{
      calls.push(value);
      if(responder)return responder(value);
      if(value.action==='arm')composerState={id:'synthetic-arm-'+(++armCounter),phase:'armed',url:value.url,
        config:{rules:value.rules!,maxContinuations:value.maxContinuations!,maxMinutes:value.maxMinutes!}};
      if(value.action==='disarm'&&composerState)composerState={...composerState,phase:'disabled'};
      if(value.action==='intent'&&composerState) {
        nativeText=value.text!;composerState={...composerState,phase:'intent',intent:{text:value.text!,baselineKey:value.baselineKey!,eventAt:value.eventAt!}};
      }
      if(value.action==='bind'&&composerState) {
        if(!bindable)return {ok:true,pending:true,url:value.url,composer:composerState,record};
        record={...goal(value.url),goal:nativeText};
        composerState={...composerState,phase:'bound',binding:{url:value.url}};
      }
      if(value.action==='pause'&&record)record={...record,phase:'paused'};
      if(value.action==='resume'&&record)record={...record,phase:'waiting'};
      if(value.action==='stop'&&record)record={...record,phase:'stopped'};
      return {ok:true,url:value.url,record,composer:composerState};
    },subscribe:(fn:()=>void)=>{subscription=fn;return ()=>{subscription=null;unsubscribed++;};}});
  function element<T=HTMLButtonElement>(selector:string):T {
    const result=document.querySelector(selector);assert.ok(result,selector);return result as unknown as T;
  }
  return {document,window,calls,state,instance,element,
    now:()=>clock,timers:()=>timers.size,advance:async(ms:number)=>{clock+=ms;for(const [id,timer] of Array.from(timers))if(timer.at<=clock){timers.delete(id);timer.run();}await tick();},
    composerState:()=>composerState,setComposer:(value:Composer|null)=>{composerState=value;},bindable:(value=true)=>{bindable=value;},
    toggle:()=>element('[role=switch]'),details:()=>element('[aria-label="Goal settings"]'),panel:()=>element<HTMLElement>('[data-chatgpt-goal-inline=panel]'),
    field:(name:string)=>element<HTMLInputElement|HTMLTextAreaElement>('[data-goal-field='+name+']'),
    action:(name:string)=>element('[data-goal-action='+name+']'),
    setUrl:(value:string)=>{url=value;},setRecord:(value:GoalRecord|null)=>{record=value;},
    respond:(fn:typeof responder)=>{responder=fn;},notify:()=>subscription?.(),
    remount:()=>{form.remove();form=composer();},
    ready:()=>{document.append(html);document.dispatchEvent(new window.Event('readystatechange'));document.dispatchEvent(new window.Event('DOMContentLoaded'));},
    hiddenForm:()=>hiddenForm,nativeForm:()=>form,draft:()=>nativeDraft,unsubscribed:()=>unsubscribed,setLive:(value:boolean)=>{live=value;}};
}

// Arming saves only criteria and finite limits. The native draft is neither
// read nor sent, and a fresh root chat is supported before its first message.
{
  const f=fixture('https://chatgpt.com/');await tick();
  assert.equal(f.toggle().disabled,false);assert.equal(f.toggle().getAttribute('aria-checked'),'false');
  assert.deepEqual(f.calls.map(value=>value.action),['get']);
  f.details().click();assert.equal(f.panel().parentElement,f.document.body);
  assert.equal(f.document.querySelector('[data-goal-field=goal]'),null);
  assert.equal(f.document.querySelector('[data-goal-action=start]'),null);
  assert.equal(f.field('maxContinuations').value,'10');assert.equal(f.field('maxMinutes').value,'1440');
  f.field('rules').value='Synthetic criteria';f.toggle().click();f.toggle().click();await tick();
  assert.equal(f.calls.filter(value=>value.action==='arm').length,1);
  const armed=f.calls.find(value=>value.action==='arm')!;
  assert.equal(armed.rules,'Synthetic criteria');assert.equal(armed.maxContinuations,10);assert.equal(armed.maxMinutes,1440);
  assert.equal('text' in armed,false);assert.equal('goal' in armed,false);
  assert.equal(f.toggle().getAttribute('aria-checked'),'true');assert.equal(f.field('rules').disabled,true);
  assert.match(f.panel().textContent!,/Write the goal in the message box and send it yourself/);
  assert.equal(f.timers(),0,'arming never starts polling or sending');
  const armedId=f.composerState()!.id;f.toggle().click();await tick();assert.equal(f.calls.at(-1)!.action,'disarm');
  assert.equal(f.calls.at(-1)!.armId,armedId,'Off is fenced to the exact acknowledged arming');
  assert.equal(f.toggle().getAttribute('aria-checked'),'false');assert.equal(f.field('rules').disabled,false);
  assert.equal(f.state.draftReads,0);assert.equal(f.state.nativeSends,0);assert.equal(f.draft(),'  untouched draft\nwith spacing  ');
  let nativeKeys=0;f.document.addEventListener('keydown',()=>nativeKeys++);
  f.field('rules').dispatchEvent(new f.window.Event('keydown',{bubbles:true,cancelable:true}));assert.equal(nativeKeys,0);
  const escape=new f.window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(escape,'key',{value:'Escape'});
  f.field('rules').dispatchEvent(escape);assert.equal(f.panel().hidden,true);assert.equal(escape.defaultPrevented,true);
  f.instance.dispose();assert.equal(f.nativeForm().isConnected,true);assert.equal(f.unsubscribed(),1);
}

// Only an explicit root adapter call captures the trusted native-send intent.
// Pending confirmation is idempotent and follows / to a permanent route.
{
  const f=fixture('https://chatgpt.com/');await tick();f.toggle().click();await tick();
  const eventAt=f.now();
  const first=f.instance.manualIntent({text:'  User sent this exact goal  ',baselineKey:'',eventAt});
  const duplicate=await f.instance.manualIntent({text:'Must not replace',baselineKey:'',eventAt});
  assert.equal(duplicate.ok,false);assert.equal((await first).ok,true);
  assert.equal(f.calls.filter(value=>value.action==='intent').length,1);
  assert.equal(f.calls.at(-1)!.text,'  User sent this exact goal  ');assert.equal(f.timers(),1);
  await f.advance(250);assert.equal(f.calls.at(-1)!.action,'bind');assert.equal(f.timers(),1);
  f.setUrl(chat);await f.instance.refresh();
  assert.equal(f.toggle().getAttribute('aria-checked'),'true');
  f.bindable();await f.advance(250);
  assert.equal(f.calls.at(-1)!.action,'bind');assert.equal(f.calls.at(-1)!.url,chat);assert.equal(f.timers(),0);
  f.details().click();assert.match(f.panel().textContent!,/User sent this exact goal/);
  assert.equal(f.document.querySelector('[data-goal-objective]')!.localName,'p','bound objective is read-only');
  f.action('pause').click();await tick();assert.equal(f.action('resume').hidden,false);
  f.action('resume').click();await tick();assert.equal(f.action('pause').hidden,false);
  f.toggle().click();await tick();assert.equal(f.calls.at(-1)!.action,'stop');assert.equal(f.toggle().getAttribute('aria-checked'),'false');
  assert.equal(f.state.draftReads,0);assert.equal(f.state.nativeSends,0);
  assert.ok(f.calls.every(value=>value.action!=='start'),'inline never authorizes a separate initial send');f.instance.dispose();
}

// Allocation can occur while the intent acknowledgement is in flight. A real
// cross-chat navigation invalidates callbacks and cancels pending confirmation.
{
  const f=fixture('https://chatgpt.com/');await tick();f.toggle().click();await tick();
  const arm=f.composerState()!,pending=deferred<Result>();f.respond(()=>pending.promise);
  const intent=f.instance.manualIntent({text:'Exact native goal',baselineKey:'',eventAt:f.now()});
  f.setUrl(chat);await f.instance.refresh();
  f.respond(null);const saved={...arm,phase:'intent' as const,eventAt:f.now()};f.setComposer(saved);
  pending.resolve({ok:true,url:'https://chatgpt.com/',composer:saved});assert.equal((await intent).ok,true);await tick();
  assert.equal(f.toggle().getAttribute('aria-checked'),'true');assert.equal(f.timers(),1);
  f.setUrl(other);f.setComposer(null);await f.instance.refresh();
  assert.equal(f.toggle().getAttribute('aria-checked'),'false');assert.equal(f.timers(),0);f.details().click();assert.equal(f.field('rules').value,'');
  const count=f.calls.length;await f.advance(1000);assert.equal(f.calls.length,count);f.instance.dispose();
}

// The worker can confirm allocation before this page's route event arrives.
// Keep the first-message intent pending and paint a Goal only on its real URL.
{
  const f=fixture('https://chatgpt.com/');await tick();f.toggle().click();await tick();
  await f.instance.manualIntent({text:'Root native goal',baselineKey:'',eventAt:f.now()});
  const bound={...f.composerState()!,phase:'bound' as const,binding:{url:chat}};
  const record={...goal(chat),goal:'Root native goal'};
  f.respond(()=>({ok:true,url:chat,record,composer:bound}));await f.advance(250);
  assert.equal(f.timers(),1,'a worker-first allocation stays within the existing confirmation window');
  f.details().click();assert.doesNotMatch(f.panel().textContent!,/another chat/);
  assert.equal(f.document.querySelector('[data-goal-objective]')!.textContent,'','allocated record is not painted at root');
  // A storage-triggered GET may also see bound state before location changes.
  f.respond(()=>({ok:true,url:'https://chatgpt.com/',record:null,composer:bound}));await f.instance.refresh();
  assert.equal(f.timers(),1);assert.equal(f.toggle().getAttribute('aria-checked'),'true');
  f.setUrl(chat);f.setRecord(record);f.setComposer(bound);f.respond(null);await f.instance.refresh();
  assert.equal(f.timers(),0);f.details().click();assert.match(f.panel().textContent!,/Root native goal/);f.instance.dispose();
  const g=fixture('https://chatgpt.com/');await tick();g.toggle().click();await tick();
  await g.instance.manualIntent({text:'Root native goal',baselineKey:'',eventAt:g.now()});
  g.respond(()=>({ok:true,url:chat,record,composer:{...g.composerState()!,phase:'bound',binding:{url:chat}}}));
  await g.advance(250);g.setUrl(other);g.respond(()=>({ok:true,url:other,record:null,composer:null}));await g.instance.refresh();
  assert.equal(g.timers(),0);assert.equal(g.toggle().getAttribute('aria-checked'),'false','allocation evidence cannot follow a different chat');g.instance.dispose();
}

// Persistence failures never turn the switch on, failed disarm/Stop never
// pretend it is off, and confirmation errors stop all polling in this instance.
{
  const f=fixture();await tick();f.details().click();
  f.respond(()=>({ok:false,error:'Storage unavailable'}));f.toggle().click();await tick();
  assert.equal(f.toggle().getAttribute('aria-checked'),'false');assert.match(f.panel().textContent!,/Storage unavailable/);
  f.respond(null);f.toggle().click();await tick();
  f.respond(()=>({ok:false,error:'Disarm refused'}));f.toggle().click();await tick();
  assert.equal(f.toggle().getAttribute('aria-checked'),'true');assert.match(f.panel().textContent!,/Disarm refused/);
  f.respond(null);await f.instance.manualIntent({text:'Native goal',baselineKey:'/c/synthetic-goal-a|before',eventAt:f.now()});
  f.respond(()=>({ok:false,error:'Native outcome unknown'}));await f.advance(250);
  assert.equal(f.timers(),0);assert.match(f.panel().textContent!,/Native outcome unknown/);
  const count=f.calls.length;await f.advance(1000);assert.equal(f.calls.length,count);
  f.respond(null);f.notify();await tick();assert.match(f.panel().textContent!,/Native outcome unknown/);assert.equal(f.timers(),0);
  f.toggle().click();await tick();assert.equal(f.calls.at(-1)!.action,'disarm');assert.equal(f.toggle().getAttribute('aria-checked'),'false');f.instance.dispose();
}

// Reload resumes a persisted intent only for its original 30-second window.
// Disposal clears timers, subscriptions and listeners and rejects late results.
{
  const f=fixture();await tick();
  f.setComposer({id:'saved-arm',phase:'intent',url:chat,intent:{text:'Saved native goal',baselineKey:'before',eventAt:f.now()-29500},
    config:{rules:'Saved criteria',maxContinuations:10,maxMinutes:1440}});await f.instance.refresh();
  assert.equal(f.timers(),1);await f.advance(250);assert.equal(f.timers(),1);await f.advance(250);
  assert.equal(f.timers(),0);f.details().click();assert.match(f.panel().textContent!,/timed out/);
  const count=f.calls.length;await f.advance(1000);assert.equal(f.calls.length,count);f.instance.dispose();
  const g=fixture();await tick();g.toggle().click();await tick();
  await g.instance.manualIntent({text:'Native goal',baselineKey:'before',eventAt:g.now()});
  const pending=deferred<Result>();g.respond(()=>pending.promise);await g.advance(250);g.instance.dispose();g.instance.dispose();
  pending.resolve({ok:true,record:goal(),composer:{...g.composerState()!,phase:'bound',binding:{url:chat}}});await tick();
  assert.equal(g.timers(),0);assert.equal(g.unsubscribed(),1);assert.equal(g.document.querySelector('[data-chatgpt-goal-inline]'),null);
  g.remount();await tick();assert.equal(g.document.querySelector('[role=switch]'),null);assert.equal(g.nativeForm().isConnected,true);
}

// A stale arm/Get response cannot expose another chat's settings or state.
{
  const f=fixture();await tick();f.details().click();f.field('rules').value='Only for chat A';
  const pending=deferred<Result>();f.respond(()=>pending.promise);f.toggle().click();
  f.setUrl(other);f.respond(()=>({ok:true,url:other,record:null,composer:null}));await f.instance.refresh();
  pending.resolve({ok:true,url:chat,composer:{id:'stale-arm',phase:'armed',url:chat,
    config:{rules:'Only for chat A',maxContinuations:10,maxMinutes:1440}}});await tick();
  f.details().click();assert.equal(f.field('rules').value,'');assert.equal(f.toggle().getAttribute('aria-checked'),'false');
  f.respond(()=>({ok:true,url:chat,record:goal()}));await f.instance.refresh();
  assert.equal(f.toggle().disabled,true);assert.match(f.panel().textContent!,/another chat/);f.instance.dispose();
}

// A reserved operation is a known pre-click refusal, not an unknown send.
{
  const f=fixture();await tick();f.setRecord({...goal(chat,'blocked'),operation:{status:'reserved'}});
  await f.instance.refresh();f.details().click();assert.match(f.panel().textContent!,/Message was not sent/);
  assert.doesNotMatch(f.panel().textContent!,/Previous send is unconfirmed/);
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

console.log('Inline Goal native arming, explicit intent, bounded confirmation, draft isolation, route fences, layout and disposal passed.');
