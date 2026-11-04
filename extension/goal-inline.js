'use strict';

// Presentation only: the worker and existing guarded sender own authorization.
(function(root) {
  let instance=0;
  function create({document,getUrl,request,subscribe=()=>()=>{},alive=()=>true}) {
    const policy=root.ChatGPTGoalPolicy;
    if(!policy)throw Error('Goal policy is not loaded');
    const win=document.defaultView||root;
    const prefix='chatgpt-goal-inline-'+(++instance);
    const ownerToken=prefix+'-'+Math.random().toString(36).slice(2);
    const ownerAttribute='data-chatgpt-goal-inline-owner';
    let ownsDOM=false;
    let disposed=false,route=null,epoch=0,sequence=0,record=null,composer=null,loaded=false,loading=false;
    let busy=false,pendingRefresh=false,error='',open=false,anchor=null,editor=null,layoutItem=null,hydrated=null;
    const cleanups=[];
    let observer=null,binding=null,bindTimer=null,bindGeneration=0,failedBinding=null;
    const ROOT_URL='https://chatgpt.com/';
    const BIND_WINDOW=30000;
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
    const valid=()=>!disposed&&alive()&&(!ownsDOM||document.documentElement?.getAttribute(ownerAttribute)===ownerToken);
    const current=()=>policy.pageUrl(getUrl());
    const armed=()=>['armed','intent'].includes(composer?.phase);
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
    const objective=node('p',{'data-goal-objective':'',class:'cggi-status'});
    objective.hidden=true;panel.append(objective);
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
    panel.append(node('p',{class:'cggi-note'},'Write the goal in the message box and send it yourself. Goal checks completion after the first answer. GOAL_COMPLETE declares completion; GOAL_BLOCKED stops a blocked goal.'));
    const actions=node('div',{class:'cggi-actions'}),buttons={};
    for(const [action,title] of [['restore','Restore saved goal'],['pause','Pause'],['resume','Resume'],['stop','Stop Goal']]) {
      const button=node('button',{type:'button','data-goal-action':action},title);
      buttons[action]=button;actions.append(button);
      // Shared page DOM is not authority to change durable Goal state.
      listen(button,'click',event=>{if(consent(event,button))void act(action);});
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
.cggi-panel[hidden]{display:none!important}.cggi-header{display:flex;justify-content:space-between;align-items:center;font-size:16px}.cggi-panel button{font:inherit;cursor:pointer;border:1px solid #ccc;border-radius:8px;padding:7px 10px;background:transparent;color:inherit}.cggi-close{border:0!important;font-size:22px!important;padding:0 5px!important}.cggi-panel label{display:block;font-weight:500;margin-top:10px}.cggi-panel textarea,.cggi-panel input{display:block;box-sizing:border-box;width:100%;margin-top:4px;border:1px solid #b6b6b6;border-radius:8px;padding:8px;background:transparent;color:inherit;font:inherit}.cggi-panel textarea{resize:vertical;min-height:50px;max-height:25vh}.cggi-panel :disabled{opacity:.55;cursor:default}.cggi-limits{display:flex;gap:12px}.cggi-limits>div{flex:1;min-width:0}.cggi-status{overflow-wrap:anywhere;margin:10px 0}.cggi-note{font-size:11px;opacity:.7}.cggi-actions{display:flex;flex-wrap:wrap;gap:8px}
html.dark .cggi-panel,[data-theme=dark] .cggi-panel{background:#242424;color:#ececec;border-color:#555;color-scheme:dark}
@media(prefers-color-scheme:dark){html:not(.light):not([data-theme=light]) .cggi-panel{background:#242424;color:#ececec;border-color:#555;color-scheme:dark}}
`;
    function resetFields() {
      fields.rules.value='';
      fields.maxContinuations.value=String(policy.DEFAULTS.maxContinuations);fields.maxMinutes.value=String(policy.DEFAULTS.maxMinutes);
      hydrated=null;
    }
    resetFields();
    const phases={preparing:'Preparing message',sending:'Sending authorized message',clicked:'Awaiting send confirmation',waiting:'Waiting for full answer',recovering:'Recovering request',handoff:'Moving to a new chat',paused:'Paused',completed:'Model declared GOAL_COMPLETE',blocked:'Blocked',stopped:'Stopped',moved:'Moved to a new chat'};
    function render() {
      if(!valid())return;
      const on=(active()&&!record.stopRequested)||armed();
      toggle.setAttribute('aria-checked',String(on));
      toggle.disabled=!route||loading||busy||(!loaded&&!error)||(!on&&(!!record?.operation||record?.phase==='blocked'));
      toggle.title=!route?'Goal is available on ChatGPT chat pages':!loaded&&error?'Retry loading Goal':active()?'Stop Goal automatic continuations':armed()?'Turn Goal off':'Turn Goal on for the message you send';
      details.setAttribute('aria-expanded',String(open));
      const editable=!!route&&loaded&&!loading&&!busy&&!active()&&!armed();
      const paused=record?.phase==='paused'||record?.phase==='handoff'&&record.preHandoffPhase==='paused'||
        record?.phase==='blocked'&&!record.operation&&record.reason==='Восстановление запроса завершилось ошибкой';
      for(const input of Object.values(fields))input.disabled=!editable;
      const restorable=!record&&composer?.phase==='intent'&&Boolean(policy.canonical(route));
      buttons.restore.hidden=!restorable;
      buttons.restore.disabled=busy||loading||!loaded;
      buttons.pause.hidden=!active()||paused;
      buttons.resume.hidden=!paused;
      buttons.stop.hidden=!active()&&record?.phase!=='blocked';
      buttons.pause.disabled=busy||loading||!loaded||!!record?.pauseRequested||!!record?.stopRequested;
      buttons.resume.disabled=busy||loading||!loaded||!!record?.operation;
      buttons.stop.disabled=busy||loading||!loaded||!!record?.stopRequested;
      objective.hidden=!record?.goal&&!(restorable&&composer.intent?.text);
      objective.textContent=restorable?'Saved objective: '+(composer.intent?.text||''):record?.goal?'Objective: '+record.goal+(record.supplements||[]).map((item,index)=>'\n\nFollow-up '+(index+1)+': '+item.userText).join(''):'';
      let message=!route?'Open a ChatGPT chat to use Goal.':!loaded?'Loading Goal…':'Off. Turn Goal on, then write the goal in the message box and send it yourself.';
      if(record) {
        message=(phases[record.phase]||record.phase)+' · '+record.continuations+' / '+record.maxContinuations+' continuations';
        if(record.deadlineAt)message+=' · deadline '+new Date(record.deadlineAt).toLocaleTimeString();
        if(record.reason)message+=' · '+record.reason;
        if(record.operation&&['blocked','stopped'].includes(record.phase))message+=record.operation.status==='reserved'
          ?' · Message was not sent. Stop Goal before starting again.'
          :' · Previous send is unconfirmed. Review the activity log before a new Goal.';
        if(record.phase==='blocked')message+=' · Review the activity log, then explicitly stop Goal.';
      }
      if(composer?.phase==='armed')message='On. Write the goal in the message box and send it yourself. Turn Goal off to change settings.';
      if(composer?.phase==='intent')message='Waiting to confirm your sent message. If ChatGPT no longer shows it, Restore saved goal keeps the objective and sent follow-ups without sending the original message again.';
      status.textContent=error||(busy?'Saving Goal…':message);
      toggle.setAttribute('aria-description',status.textContent);
      if(open)position();
    }
    function hydrate() {
      const source=active()?record:armed()?composer.config:record;
      const key=active()?'goal:'+record.id:armed()?'composer:'+composer.id:record?'goal:'+record.id:null;
      if(source&&key!==hydrated) {
        fields.rules.value=source.rules||'';
        fields.maxContinuations.value=String(source.maxContinuations);
        fields.maxMinutes.value=String(source.maxMinutes);hydrated=key;
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
    function show(value,focus=true) {
      if(!valid()||(value&&!document.body))return;
      open=value;
      if(open) {
        if(!panel.isConnected)document.body.append(panel);
        panel.hidden=false;render();
        if(focus)(active()||armed()?close:route&&loaded?fields.rules:close).focus();
      } else {
        panel.hidden=true;render();
        if(details.isConnected)details.focus();
      }
    }
    function bindingFailure(message) {
      binding.stopped=true;error=message;
      failedBinding={id:binding.id,message};
    }
    function stopBinding() {
      bindGeneration++;
      if(bindTimer!==null)win.clearTimeout(bindTimer);
      bindTimer=null;binding=null;
    }
    function syncRoute() {
      const next=current();
      if(next===route)return false;
      const allocation=binding&&binding.origin===ROOT_URL&&route===ROOT_URL&&!!policy.canonical(next)&&
        (!binding.allocated||binding.allocated===next);
      route=next;epoch++;sequence++;
      if(allocation) {
        binding.allocated=next;
        if(record&&policy.canonical(record.url)!==next)record=null;
        return true;
      }
      stopBinding();record=null;composer=null;loaded=false;loading=false;busy=false;pendingRefresh=false;error='';failedBinding=null;
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
    function consent(event,control) {
      return event.isTrusted===true&&!control.disabled&&!control.hidden&&visible(control);
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
      // Extension reloads can replace the isolated world while leaving its DOM.
      // Acquire one shared UI slot before removing only extension-owned nodes.
      target.setAttribute(ownerAttribute,ownerToken);ownsDOM=true;
      for(const stale of document.querySelectorAll('[data-chatgpt-goal-inline]'))stale.remove();
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
    function contextMatches(token) {
      if(!valid()||!binding||binding.token!==token)return false;
      syncRoute();
      return !!binding&&binding.token===token&&current()===route&&
        (route===binding.origin||route===binding.allocated);
    }
    function validateResult(result,url) {
      if(result?.url&&policy.pageUrl(result.url)!==url)throw Error('Goal response belongs to another chat');
      if(result?.record&&policy.canonical(result.record.url)!==policy.canonical(url))throw Error('Goal response belongs to another chat');
    }
    function apply(result) {
      record=result.record||null;
      composer=result.composer||null;
      if(composer) {
        const source=policy.pageUrl(composer.url);
        const bound=policy.canonical(composer.binding?.url);
        const matches=composer.phase==='bound'?bound===policy.canonical(route):source===route||
          (composer.phase==='intent'&&source===ROOT_URL&&!!policy.canonical(route));
        if(!matches)composer=null;
      }
      loaded=true;hydrate();
    }
    function scheduleBind() {
      if(!binding||binding.stopped||!binding.persisted||binding.inFlight||bindTimer!==null||!valid())return;
      if(Date.now()>=binding.deadline) {
        bindingFailure('Message confirmation timed out. The saved objective is preserved. Open Goal settings to restore it without resending the original message.');
        render();return;
      }
      const token=binding.token;
      bindTimer=win.setTimeout(()=>{bindTimer=null;void pollBind(token);},Math.min(250,binding.deadline-Date.now()));
    }
    function resumeBinding() {
      if(composer?.phase!=='intent') {if(binding?.persisted)stopBinding();return;}
      if(!binding||binding.id!==composer.id) {
        stopBinding();
        const origin=policy.pageUrl(composer.url);
        binding={id:composer.id,origin,allocated:origin===ROOT_URL&&policy.canonical(route)?route:'',
          token:bindGeneration,persisted:true,inFlight:false,stopped:false,
          deadline:Number(composer.intent?.eventAt??composer.eventAt)+BIND_WINDOW};
      } else binding.persisted=true;
      if(!Number.isFinite(binding.deadline)||binding.deadline<=BIND_WINDOW) {
        bindingFailure('Goal intent has no valid confirmation time. Turn Goal off and check this chat.');render();return;
      }
      scheduleBind();
    }
    function deferAllocation(result) {
      if(!binding||binding.origin!==ROOT_URL||route!==ROOT_URL||result?.composer?.id!==binding.id)return false;
      const allocated=policy.canonical(result.url)||policy.canonical(result.composer.binding?.url);
      if(!allocated||binding.allocated&&binding.allocated!==allocated)return false;
      // The worker can confirm a new chat before this page observes its route.
      // Keep polling within the original deadline; never paint that chat here.
      binding.allocated=allocated;binding.inFlight=false;scheduleBind();return true;
    }
    async function pollBind(token) {
      if(!contextMatches(token))return;
      if(Date.now()>=binding.deadline){scheduleBind();return;}
      binding.inFlight=true;
      const url=route,id=binding.id;
      try {
        const result=await request({type:'CHATGPT_GOAL_INLINE',action:'bind',armId:id,url});
        if(!contextMatches(token))return;
        if(!result?.ok)throw Error(result?.error||result?.reason||'Goal message confirmation failed');
        // Re-read the real page URL in contextMatches before accepting a result.
        if(deferAllocation(result))return;
        if(result?.url&&![url,route].includes(policy.pageUrl(result.url)))throw Error('Goal confirmation belongs to another chat');
        if(result.pending===true) {
          if(result.composer&&result.composer.id!==id)throw Error('Goal intent changed');
          binding.inFlight=false;scheduleBind();return;
        }
        validateResult({...result,url:route},route);
        if(!result.record||result.composer?.phase!=='bound'||result.composer.id!==id)throw Error('Goal message confirmation was not acknowledged');
        apply(result);
        if(!record||composer?.phase!=='bound')throw Error('Goal message confirmation belongs to another chat');
        stopBinding();error='';failedBinding=null;render();
      } catch(cause) {
        if(!contextMatches(token))return;
        binding.inFlight=false;bindingFailure('Goal: '+String(cause?.message||cause));render();
      }
    }
    async function refresh() {
      if(!valid()||!mount())return;
      syncRoute();attach();
      if(!route){loaded=true;render();return;}
      if(busy){pendingRefresh=true;return;}
      const url=route,revision=epoch,serial=++sequence;
      loading=true;render();
      try {
        const result=await request({type:'CHATGPT_GOAL_INLINE',action:'get',url});
        if(!accepts(url,revision,serial))return;
        if(!result?.ok)throw Error(result?.error||result?.reason||'Could not load Goal');
        if(deferAllocation(result)){render();return;}
        validateResult(result,url);
        const keepError=!!binding?.stopped||failedBinding&&error===failedBinding.message;
        apply(result);
        const adopted=failedBinding&&(!binding||binding.id===failedBinding.id)&&composer?.phase==='bound'&&
          composer.id===failedBinding.id&&record?.id===failedBinding.id;
        if(adopted&&error===failedBinding.message){error='';failedBinding=null;}
        else if(!keepError)error='';
        resumeBinding();render();
      } catch(cause) {
        if(!accepts(url,revision,serial))return;
        loaded=false;error='Goal: '+String(cause?.message||cause);
      } finally {
        if(accepts(url,revision,serial)){loading=false;render();}
      }
    }
    async function act(action) {
      if(!valid())return;
      if(syncRoute()){void refresh();return;}
      if(!route||!loaded||loading||busy)return;
      // Hidden/disabled actions fence stale events as well as duplicate clicks.
      if(buttons[action]&&(buttons[action].disabled||buttons[action].hidden))return;
      if(!buttons[action]&&!['arm','disarm'].includes(action))return;
      let input={};
      if(action==='arm') {
        if(active()||armed()||record?.operation||record?.phase==='blocked')return;
        try {
          input=policy.composerSettings({rules:fields.rules.value,
            maxContinuations:Number(fields.maxContinuations.value),maxMinutes:Number(fields.maxMinutes.value)});
        } catch(cause){error=String(cause?.message||cause);render();return;}
      }
      if(action==='restore'){if(record||composer?.phase!=='intent')return;input={armId:composer.id};stopBinding();}
      if(action==='disarm') {
        if(!composer?.id)return;
        input={armId:composer.id};
        stopBinding();
      }
      const url=route,revision=epoch,serial=++sequence;
      busy=true;error='';failedBinding=null;render();
      try {
        const result=await request({type:'CHATGPT_GOAL_INLINE',action,url,...input});
        if(!accepts(url,revision,serial))return;
        validateResult(result,url);
        if(!result?.ok)throw Error(result?.error||result?.reason||'Goal action was not confirmed');
        apply(result);resumeBinding();
      } catch(cause) {
        if(!accepts(url,revision,serial))return;
        error='Goal: '+String(cause?.message||cause);
        if(controls.isConnected)show(true,false);
      } finally {
        if(accepts(url,revision,serial)) {
          busy=false;render();
          if(pendingRefresh){pendingRefresh=false;void refresh();}
        }
      }
    }
    async function manualIntent({text,baselineKey,eventAt}) {
      if(!valid())return {ok:false};
      if(syncRoute()){void refresh();return {ok:false};}
      if(!route||!loaded||busy||composer?.phase!=='armed'||typeof text!=='string'||!text.trim()||
          typeof baselineKey!=='string'||!Number.isFinite(eventAt))return {ok:false};
      const url=route,id=composer.id;
      stopBinding();
      binding={id,origin:url,allocated:'',token:bindGeneration,persisted:false,inFlight:false,stopped:false,deadline:eventAt+BIND_WINDOW};
      const token=binding.token;
      busy=true;loading=false;error='';failedBinding=null;sequence++;render();
      try {
        const result=await request({type:'CHATGPT_GOAL_INLINE',action:'intent',armId:id,url,text,baselineKey,eventAt});
        if(!contextMatches(token))return {ok:false};
        if(result?.url&&![url,route].includes(policy.pageUrl(result.url)))throw Error('Goal intent belongs to another chat');
        if(!result?.ok)throw Error(result?.error||result?.reason||'Goal intent was not saved');
        if(result.composer?.id!==id||result.composer.phase!=='intent')throw Error('Goal intent was not acknowledged');
        // A persisted intent may follow a new chat from / to its allocated URL.
        composer=result.composer;record=null;loaded=true;hydrate();resumeBinding();
        return {ok:true};
      } catch(cause) {
        if(contextMatches(token)) {
          bindingFailure('Goal: '+String(cause?.message||cause));
        }
        return {ok:false};
      } finally {
        if(contextMatches(token)) {
          busy=false;render();
          if(pendingRefresh){pendingRefresh=false;void refresh();}
        }
      }
    }
    listen(toggle,'click',event=>{
      if(!consent(event,toggle))return;
      if(syncRoute()){void refresh();return;}
      if(toggle.disabled)return;
      // A click after a failed read retries that read only. Unknown state is
      // never permission to arm, disarm or stop an existing Goal.
      if(!loaded){void refresh();return;}
      void act(active()&&!record.stopRequested?'stop':armed()?'disarm':'arm');
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
      stopBinding();
      if(typeof unsubscribe==='function')unsubscribe();
      for(const cleanup of cleanups)cleanup();
      controls.remove();panel.remove();style.remove();
      if(document.documentElement?.getAttribute(ownerAttribute)===ownerToken)document.documentElement.removeAttribute(ownerAttribute);
    }
    return Object.freeze({refresh,dispose,manualIntent});
  }
  const api=Object.freeze({create});
  root.ChatGPTGoalInline=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
