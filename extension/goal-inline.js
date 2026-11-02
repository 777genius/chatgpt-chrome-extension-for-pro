'use strict';

// Presentation only: the worker and existing guarded sender own authorization.
(function(root) {
  let instance=0;
  function create({document,getUrl,request,subscribe=()=>()=>{},alive=()=>true}) {
    const policy=root.ChatGPTGoalPolicy;
    if(!policy)throw Error('Goal policy is not loaded');
    const win=document.defaultView||root;
    const prefix='chatgpt-goal-inline-'+(++instance);
    let disposed=false,route=null,epoch=0,sequence=0,record=null,loaded=false;
    let busy=false,pendingRefresh=false,error='',open=false,anchor=null,editor=null,layoutItem=null,hydrated=null;
    const cleanups=[];
    let observer=null;
    const node=(tag,attrs={},text='')=>{
      const el=document.createElement(tag);
      for(const [name,value] of Object.entries(attrs))el.setAttribute(name,value);
      if(text)el.textContent=text;
      return el;
    };
    const listen=(target,type,fn,options)=>{
      target.addEventListener(type,fn,options);
      cleanups.push(()=>target.removeEventListener(type,fn,options));
    };
    const valid=()=>!disposed&&alive();
    const current=()=>policy.canonical(getUrl());
    const active=()=>!!record&&!['completed','blocked','stopped','moved'].includes(record.phase);
    const controls=node('span',{'data-chatgpt-goal-inline':'controls',class:'cggi-controls'});
    const toggle=node('button',{type:'button',role:'switch','aria-label':'Goal','aria-checked':'false',class:'cggi-switch'},'Goal');
    const track=node('span',{'aria-hidden':'true',class:'cggi-track'});
    toggle.append(track);
    const details=node('button',{type:'button','aria-label':'Goal settings','aria-haspopup':'dialog','aria-controls':prefix,class:'cggi-details'},'⋯');
    controls.append(toggle,details);
    const panel=node('section',{id:prefix,role:'dialog','aria-modal':'false','aria-labelledby':prefix+'-title','data-chatgpt-goal-inline':'panel',class:'cggi-panel'});
    panel.hidden=true;
    const header=node('div',{class:'cggi-header'});
    header.append(node('strong',{id:prefix+'-title'},'Goal'));
    const close=node('button',{type:'button','aria-label':'Close Goal settings',class:'cggi-close'},'×');
    header.append(close);
    panel.append(header);
    const status=node('p',{role:'status','aria-live':'polite',class:'cggi-status'});
    panel.append(status);
    const fields={};
    function field(name,title,tag,attrs={}) {
      const label=node('label',{for:prefix+'-'+name},title);
      const input=node(tag,{id:prefix+'-'+name,'data-goal-field':name,...attrs});
      panel.append(label,input);
      fields[name]=input;
      return input;
    }
    field('goal','Objective','textarea',{rows:'3',maxlength:'10000',placeholder:'What should be completed?'});
    field('rules','Completion criteria (optional)','textarea',{rows:'2',maxlength:'5000'});
    const limits=node('div',{class:'cggi-limits'});
    for(const [name,title,max] of [['maxContinuations','Continuations',100],['maxMinutes','Minutes',1440]]) {
      const group=node('div');
      const label=node('label',{for:prefix+'-'+name},title);
      const input=node('input',{id:prefix+'-'+name,'data-goal-field':name,type:'number',min:'1',max:String(max),step:'1'});
      fields[name]=input;
      group.append(label,input);limits.append(group);
    }
    panel.append(limits);
    panel.append(node('p',{class:'cggi-note'},'Start authorizes the objective and automatic continuations within these limits. GOAL_COMPLETE is the model’s declaration of completion.'));
    const actions=node('div',{class:'cggi-actions'}),buttons={};
    for(const [action,title] of [['start','Start Goal'],['pause','Pause'],['resume','Resume'],['stop','Stop Goal']]) {
      const button=node('button',{type:'button','data-goal-action':action},title);
      buttons[action]=button;actions.append(button);
      listen(button,'click',()=>void act(action));
    }
    panel.append(actions);
    const style=node('style',{'data-chatgpt-goal-inline':'style'});
    style.textContent=`
.cggi-controls{display:inline-flex;align-items:center;gap:1px;flex-shrink:0;margin-inline-start:6px;color:inherit;font:500 12px/1.2 system-ui,sans-serif}
.cggi-controls button{box-sizing:border-box;color:inherit;font:inherit;cursor:pointer;background:transparent;border:0}
.cggi-switch{display:inline-flex;align-items:center;gap:6px;min-height:30px;border-radius:16px!important;padding:4px 6px!important}
.cggi-switch:hover,.cggi-details:hover{background:rgba(127,127,127,.15)}
.cggi-track{width:25px;height:15px;border-radius:12px;background:#8b8b8b;display:inline-block;position:relative}
.cggi-track:after{content:'';position:absolute;width:11px;height:11px;left:2px;top:2px;border-radius:50%;background:white}
.cggi-switch[aria-checked=true] .cggi-track{background:#16895a}.cggi-switch[aria-checked=true] .cggi-track:after{left:12px}
.cggi-details{padding:4px!important;min-width:24px;min-height:30px;border-radius:12px;font-size:18px!important}
.cggi-controls button:disabled{opacity:.5;cursor:default}.cggi-controls button:focus-visible,.cggi-panel button:focus-visible{outline:2px solid #358af0;outline-offset:2px}
.cggi-panel{box-sizing:border-box;position:fixed;z-index:2147483646;width:360px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;overscroll-behavior:contain;padding:16px;border:1px solid #d3d3d3;border-radius:16px;background:#fff;color:#202123;box-shadow:0 8px 36px #0003;font:13px/1.45 system-ui,sans-serif;color-scheme:light}
.cggi-panel[hidden]{display:none!important}.cggi-header{display:flex;justify-content:space-between;align-items:center;font-size:16px}.cggi-panel button{font:inherit;cursor:pointer;border:1px solid #ccc;border-radius:8px;padding:7px 10px;background:transparent;color:inherit}.cggi-close{border:0!important;font-size:22px!important;padding:0 5px!important}.cggi-panel label{display:block;font-weight:500;margin-top:10px}.cggi-panel textarea,.cggi-panel input{display:block;box-sizing:border-box;width:100%;margin-top:4px;border:1px solid #b6b6b6;border-radius:8px;padding:8px;background:transparent;color:inherit;font:inherit}.cggi-panel textarea{resize:vertical;min-height:50px;max-height:25vh}.cggi-panel :disabled{opacity:.55;cursor:default}.cggi-limits{display:flex;gap:12px}.cggi-limits>div{flex:1;min-width:0}.cggi-status{overflow-wrap:anywhere;margin:10px 0}.cggi-note{font-size:11px;opacity:.7}.cggi-actions{display:flex;flex-wrap:wrap;gap:8px}.cggi-actions button[data-goal-action=start]{background:#177a52;color:white;border-color:#177a52}
html.dark .cggi-panel,[data-theme=dark] .cggi-panel{background:#242424;color:#ececec;border-color:#555;color-scheme:dark}
@media(prefers-color-scheme:dark){html:not(.light):not([data-theme=light]) .cggi-panel{background:#242424;color:#ececec;border-color:#555;color-scheme:dark}}
`;
    function resetFields() {
      fields.goal.value='';fields.rules.value='';
      fields.maxContinuations.value='5';fields.maxMinutes.value='30';
      hydrated=null;
    }
    resetFields();
    const phases={preparing:'Preparing message',sending:'Sending authorized message',clicked:'Awaiting send confirmation',waiting:'Waiting for full answer',recovering:'Recovering request',handoff:'Moving to a new chat',paused:'Paused',completed:'Model declared GOAL_COMPLETE',blocked:'Blocked for safety',stopped:'Stopped',moved:'Moved to a new chat'};
    function render() {
      if(!valid())return;
      const on=active()&&!record.stopRequested;
      toggle.setAttribute('aria-checked',String(on));
      toggle.disabled=!route||!loaded||busy;
      toggle.title=!route?'Send the first message to save this chat before starting Goal':on?'Stop Goal automatic continuations':'Set up Goal';
      details.setAttribute('aria-expanded',String(open));
      const editable=!!route&&loaded&&!busy&&!active();
      for(const input of Object.values(fields))input.disabled=!editable;
      buttons.start.hidden=active();
      buttons.pause.hidden=!active()||record.phase==='paused';
      buttons.resume.hidden=record?.phase!=='paused';
      buttons.stop.hidden=!active()&&record?.phase!=='blocked';
      buttons.start.disabled=!editable||!!record?.operation||record?.phase==='blocked';
      buttons.pause.disabled=busy||!loaded||record?.phase==='handoff'||!!record?.pauseRequested||!!record?.stopRequested;
      buttons.resume.disabled=busy||!loaded||!!record?.operation;
      buttons.stop.disabled=busy||!loaded||!!record?.stopRequested;
      let message=!route?'Send the first message to save this chat. Then you can start a Goal.':!loaded?'Loading Goal…':'Off. Set an objective and choose Start Goal.';
      if(record) {
        message=(phases[record.phase]||record.phase)+' · '+record.continuations+' / '+record.maxContinuations+' continuations';
        if(record.deadlineAt)message+=' · deadline '+new Date(record.deadlineAt).toLocaleTimeString();
        if(record.reason)message+=' · '+record.reason;
        if(record.operation&&['blocked','stopped'].includes(record.phase))message+=record.operation.status==='reserved'
          ?' · Message was not sent. Stop Goal before starting again.'
          :' · Previous send is unconfirmed. Review the activity log before a new Goal.';
        if(record.phase==='blocked')message+=' · Review the activity log, then explicitly stop Goal.';
      }
      status.textContent=error|| (busy?'Saving Goal…':message);
      if(open)position();
    }
    function hydrate() {
      if(record&&record.id!==hydrated) {
        fields.goal.value=record.goal||'';fields.rules.value=record.rules||'';
        fields.maxContinuations.value=String(record.maxContinuations);
        fields.maxMinutes.value=String(record.maxMinutes);hydrated=record.id;
      }
    }
    function position() {
      if(!open||!controls.isConnected)return;
      const rect=controls.getBoundingClientRect();
      const width=win.innerWidth||1024,height=win.innerHeight||768;
      const box=panel.getBoundingClientRect();
      panel.style.left=Math.max(12,Math.min(rect.left,width-(box.width||360)-12))+'px';
      panel.style.top=Math.max(12,Math.min(rect.top-(box.height||400)-8,height-(box.height||400)-12))+'px';
    }
    function show(value) {
      if(!valid()||(value&&!document.body))return;
      open=value;
      if(open) {
        if(!panel.isConnected)document.body.append(panel);
        panel.hidden=false;render();
        (active()?close:route&&loaded?fields.goal:close).focus();
      } else {
        panel.hidden=true;render();
        if(details.isConnected)details.focus();
      }
    }
    function syncRoute() {
      const next=current();
      if(next===route)return false;
      route=next;epoch++;sequence++;record=null;loaded=false;busy=false;pendingRefresh=false;error='';
      open=false;panel.hidden=true;resetFields();render();
      return true;
    }
    function visible(el) {
      if(!el.isConnected||el.closest('[hidden],[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]'))return false;
      const computed=win.getComputedStyle?.(el);
      if(computed?.display==='none'||['hidden','collapse'].includes(computed?.visibility))return false;
      const rects=typeof el.getClientRects==='function'?Array.from(el.getClientRects()):[el.getBoundingClientRect()];
      return rects.some(rect=>rect.width>0&&rect.height>0);
    }
    function inlineItem(reasoning,composer) {
      // The native effort button can be block-level inside inline/block wrappers.
      // Join the nearest existing horizontal row as its own layout item.
      let item=reasoning,parent=item.parentElement;
      while(parent&&parent!==composer) {
        const computed=win.getComputedStyle?.(parent);
        if(['flex','inline-flex'].includes(computed?.display)&&
            !['column','column-reverse'].includes(computed?.flexDirection))return item;
        item=parent;parent=item.parentElement;
      }
      return reasoning;
    }
    function attach() {
      // Streaming mutations do not rescan the conversation while our anchor lives.
      if(anchor?.isConnected&&editor?.isConnected&&controls.isConnected&&controls.previousElementSibling===layoutItem&&visible(anchor)&&visible(editor))return;
      controls.remove();anchor=null;editor=null;layoutItem=null;
      const page=document.querySelector('[data-app-shell-active-page="true"]')||document;
      for(const candidate of page.querySelectorAll('#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,[data-composer-markdown][contenteditable="true"]')) {
        if(!visible(candidate))continue;
        const composer=candidate.closest('form')||candidate.closest('[data-composer-body]')||candidate.parentElement;
        const reasoning=composer?.querySelector('[data-composer-navigation-target="reasoning"]');
        if(!reasoning||!visible(reasoning))continue;
        editor=candidate;anchor=reasoning;
        layoutItem=inlineItem(reasoning,composer);
        layoutItem.after(controls);break;
      }
      if(open)position();
    }
    function accepts(url,revision,serial) {
      return valid()&&current()===url&&route===url&&epoch===revision&&sequence===serial;
    }
    function mount() {
      if(observer)return true;
      const target=document.documentElement;
      if(!target)return false;
      (document.head||target).append(style);
      observer=new win.MutationObserver(()=>{
        if(!valid())return;
        const changed=syncRoute();attach();
        if(changed)void refresh();
      });
      observer.observe(target,{childList:true,subtree:true,attributes:true,
        attributeFilter:['hidden','inert','aria-hidden','data-app-shell-active-page','style','class']});
      return true;
    }
    async function refresh() {
      if(!valid()||!mount())return;
      syncRoute();attach();
      if(!route){loaded=true;render();return;}
      if(busy){pendingRefresh=true;return;}
      const url=route,revision=epoch,serial=++sequence;
      try {
        const result=await request({type:'CHATGPT_GOAL_INLINE',action:'get',url});
        if(!accepts(url,revision,serial))return;
        if((result?.url&&policy.canonical(result.url)!==url)||(result?.record&&policy.canonical(result.record.url)!==url))throw Error('Goal response belongs to another chat');
        if(!result?.ok)throw Error(result?.error||result?.reason||'Could not load Goal');
        record=result.record||null;loaded=true;error='';hydrate();render();
      } catch(cause) {
        if(!accepts(url,revision,serial))return;
        loaded=false;error='Goal: '+String(cause?.message||cause);render();
      }
    }
    async function act(action) {
      if(!valid())return;
      if(syncRoute()){void refresh();return;}
      if(!route||!loaded||busy)return;
      // Disabled controls also fence programmatic and queued duplicate clicks.
      if(buttons[action]?.disabled)return;
      let input={};
      if(action==='start') {
        try {
          input=policy.settings({goal:fields.goal.value,rules:fields.rules.value,
            maxContinuations:Number(fields.maxContinuations.value),maxMinutes:Number(fields.maxMinutes.value)});
        } catch(cause){error=String(cause?.message||cause);render();return;}
      }
      const url=route,revision=epoch,serial=++sequence;
      busy=true;error='';render();
      try {
        const result=await request({type:'CHATGPT_GOAL_INLINE',action,url,...input});
        if(!accepts(url,revision,serial))return;
        if((result?.url&&policy.canonical(result.url)!==url)||(result?.record&&policy.canonical(result.record.url)!==url))throw Error('Goal response belongs to another chat');
        if(!result?.ok)throw Error(result?.error||result?.reason||'Goal action was not confirmed');
        record=result.record||null;hydrate();
      } catch(cause) {
        if(!accepts(url,revision,serial))return;
        error='Goal: '+String(cause?.message||cause);
      } finally {
        if(valid()&&current()===url&&epoch===revision&&sequence===serial) {
          busy=false;render();
          if(pendingRefresh){pendingRefresh=false;void refresh();}
        }
      }
    }
    listen(toggle,'click',()=>{
      if(syncRoute()){void refresh();return;}
      if(toggle.disabled)return;
      if(active()&&!record.stopRequested)void act('stop');else show(true);
    });
    listen(details,'click',()=>{if(syncRoute()||!loaded)void refresh();show(!open);});
    listen(close,'click',()=>show(false));
    for(const target of [controls,panel]) {
      for(const type of ['click','pointerdown','mousedown','input','change','keyup','keypress'])listen(target,type,event=>event.stopPropagation());
      listen(target,'keydown',event=>{
        event.stopPropagation();
        if(event.key==='Escape'){event.preventDefault();show(false);}
      });
    }
    listen(document,'keydown',event=>{if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();show(false);}});
    listen(document,'pointerdown',event=>{if(open&&!panel.contains(event.target)&&!controls.contains(event.target)){open=false;panel.hidden=true;render();}});
    listen(win,'resize',position);
    listen(win,'scroll',position,true);
    listen(win,'popstate',()=>void refresh());
    // document_start may run before <html> exists. Readiness events defer all
    // mounting and observation; dispose removes them even before initialization.
    const ready=()=>{if(!observer&&document.documentElement)void refresh();};
    listen(document,'DOMContentLoaded',ready);
    listen(document,'readystatechange',ready);
    const unsubscribe=subscribe(()=>void refresh());
    void refresh();
    function dispose() {
      if(disposed)return;
      disposed=true;epoch++;sequence++;
      observer?.disconnect();
      if(typeof unsubscribe==='function')unsubscribe();
      for(const cleanup of cleanups)cleanup();
      controls.remove();panel.remove();style.remove();
    }
    return Object.freeze({refresh,dispose});
  }
  const api=Object.freeze({create});
  root.ChatGPTGoalInline=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
