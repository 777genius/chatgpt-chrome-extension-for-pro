'use strict';

(() => {
  // Kept self-contained so the same read-only probe can run in MAIN when
  // automation IDs from native React props are available there.
  function inspect(options={}) {
    const document=options.document||globalThis.document;
    const url=options.url??globalThis.location?.href??'';
    const page=document.querySelector('[data-app-shell-active-page="true"]')||document;
    const root=page.querySelector('[data-thread-find-target="conversation"]')||page.querySelector('main')||page;
    const whole='[data-content-search-turn-key]';
    let turns=Array.from(root.querySelectorAll(whole));
    if(!turns.length)turns=Array.from(root.querySelectorAll('[data-testid^="conversation-turn-"]'));
    if(!turns.length)turns=Array.from(root.querySelectorAll('[data-turn-key]'));
    if(!turns.length)turns=Array.from(root.querySelectorAll('[data-chatgpt-search-unit-key*="fallback-turn-"]'));
    const key=node=>node?.closest('[data-turn-key]')?.getAttribute('data-turn-key')||node?.getAttribute('data-content-search-turn-key')||node?.getAttribute('data-testid')||node?.getAttribute('data-chatgpt-search-unit-key')||'';
    const ordinal=node=>{
      const value=node?.getAttribute('data-content-search-turn-key')||node?.getAttribute('data-testid')||node?.getAttribute('data-chatgpt-search-unit-key')||'';
      const match=/(?:fallback-turn-|conversation-turn-)(\d+)(?::|$)/.exec(value);
      return match?Number(match[1]):null;
    };
    const own=(value,name)=>value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,name)?.value:undefined;
    const metadata=button=>{
      const fiberKey=Object.keys(button).find(name=>name.startsWith('__reactFiber$'));
      let fiber=fiberKey?own(button,fiberKey):null;
      for(let depth=0;fiber&&depth<12;depth++,fiber=own(fiber,'return')) {
        const automation=own(own(fiber,'memoizedProps'),'automation');
        if(own(automation,'type')!=='chatgpt-automation')continue;
        const id=own(automation,'id'),enabled=own(automation,'isEnabled');
        return {taskId:typeof id==='string'&&id.length<=200?id:null,enabled:typeof enabled==='boolean'?enabled:null};
      }
      return {taskId:null,enabled:null};
    };
    const latest=turns.at(-1),cards=[];
    for(const node of Array.from(root.querySelectorAll('[data-automation-card="true"]')).slice(-20)) {
      if(node.closest('pre,code,[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]'))continue;
      if(typeof node.getClientRects==='function'&&!node.getClientRects().length)continue;
      const button=node.querySelector('button');
      if(!button||!Array.from(node.querySelectorAll('use')).some(use=>{
        const href=use.getAttribute('href')||use.getAttributeNS?.('http://www.w3.org/1999/xlink','href')||'';
        return href.split('#')[1]==='codex-icon-clock-light-24';
      }))continue;
      let index=turns.findIndex(turn=>turn.contains(node));
      // Standard fallback text units can be siblings of the native card.
      if(index<0)for(let i=0;i<turns.length;i++)if(turns[i].compareDocumentPosition(node)&4)index=i;
      if(index<0)continue;
      const anchor=turns[index],meta=metadata(button),anchorKey=key(anchor);
      // Identity must be identical in MAIN and the isolated world, where React
      // props are unavailable. Never include private metadata or displayed dates.
      cards.push({cardKey:JSON.stringify([anchorKey,button.getAttribute('aria-describedby')||button.getAttribute('aria-label')||'',cards.length]),
        anchorKey,ordinal:ordinal(anchor),taskId:meta.taskId,enabled:meta.enabled,current:index===turns.length-1,
        ...(options.includeRoot?{node}: {})});
    }
    const result={url,latestAnchorKey:key(latest),latestOrdinal:ordinal(latest),cards};
    const watchRoot=page===document?(root.parentElement||root):(page.parentElement||page);
    return options.includeRoot?{...result,root:watchRoot}:result;
  }

  function create({document,getUrl,onChange,readMetadata=null,isGenerating=()=>false,alive=()=>true,
    setTimeout=(callback,delay)=>document.defaultView.setTimeout(callback,delay),
    clearTimeout=timer=>document.defaultView.clearTimeout(timer),now=()=>Date.now()}) {
    let disposed=false,url='',timer=null,root=null,pending=null,initial=null,lastSnapshot=null,routeFence=null,lastEvent='';
    let revision=0,metadata=null,probe=null;
    const consumed=new Set(),firstSeen=new Map();
    const state={phase:'none',url:'',cardKey:null,anchorKey:null,taskId:null};
    const canonical=value=>{try{const u=new URL(value);return u.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(u.pathname)?u.origin+u.pathname.replace(/\/$/,''):'';}catch{return '';}};
    function cancel(){if(timer!==null)clearTimeout(timer);timer=null;}
    function dispose(){if(disposed)return;disposed=true;cancel();observer.disconnect();document.defaultView.removeEventListener('popstate',refresh);pending=null;initial=null;root=null;lastSnapshot=null;routeFence=null;lastEvent='';revision++;metadata=null;firstSeen.clear();consumed.clear();}
    function active(){try{if(!disposed&&alive())return true;}catch{}dispose();return false;}
    function emit(phase,reason,card=null) {
      Object.assign(state,{phase,url,cardKey:card?.cardKey||null,anchorKey:card?.anchorKey||null,taskId:card?.taskId||null});
      const identity=JSON.stringify(state);
      if(identity===lastEvent)return;
      lastEvent=identity;
      onChange({...state,reason});
    }
    function consume(card){if(!card)return;consumed.add(card.cardKey);if(consumed.size>32)consumed.delete(consumed.values().next().value);}
    function arm(){if(timer===null&&(pending||initial)&&!disposed)timer=setTimeout(()=>{timer=null;scan('poll');},300000);}
    function bind(nextRoot){
      if(root===nextRoot)return;
      observer.disconnect();root=nextRoot;
      observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['data-automation-card','aria-describedby','aria-label','href','data-content-search-turn-key','data-testid','data-turn-key','data-talvt-turn-state','data-app-shell-active-page']});
    }
    const signatureOf=snapshot=>JSON.stringify([snapshot.latestAnchorKey,snapshot.latestOrdinal,
      snapshot.cards.map(card=>[card.cardKey,card.anchorKey,card.ordinal,card.current])]);
    const sameNodes=(left,right)=>left.cards.length===right.cards.length&&left.cards.every((card,index)=>card.node===right.cards[index].node);
    // The injected reader returns inspect() from MAIN. Keep one in-flight read
    // and one bounded metadata snapshot; metadata reconciliation never probes.
    function probeMetadata(snapshot,signature,reason) {
      if(typeof readMetadata!=='function'||reason==='metadata'||probe||!snapshot.cards.some(card=>card.current&&!consumed.has(card.cardKey)))return;
      const request={revision,url,signature};probe=request;
      Promise.resolve().then(()=>readMetadata({url:request.url})).then(result=>{
        if(!active()||request.revision!==revision||canonical(getUrl())!==request.url||!result||canonical(result.url)!==request.url||!Array.isArray(result.cards)||result.cards.length>20)return;
        const fresh=inspect({document,url:request.url,includeRoot:true});
        if(signatureOf(fresh)!==signature||!sameNodes(snapshot,fresh)||signatureOf(result)!==signature)return;
        metadata={revision:request.revision,cards:result.cards.map(card=>({cardKey:card.cardKey,anchorKey:card.anchorKey,
          taskId:typeof card.taskId==='string'&&card.taskId.length<=200?card.taskId:null,
          enabled:typeof card.enabled==='boolean'?card.enabled:null}))};
        scan('metadata');
      }).catch(()=>{}).finally(()=>{
        if(probe!==request)return;
        probe=null;
        // A route/card replacement during the read gets a fresh read, once.
        // Unchanged failures wait for a DOM event or the five-minute fallback.
        if(active()&&request.revision!==revision)scan('probe-next');
      });
    }
    function scan(reason='dom') {
      if(!active())return;
      const current=canonical(getUrl());
      if(current!==url){
        revision++;metadata=null;routeFence=lastSnapshot?.signature||null;url=current;pending=null;initial=null;firstSeen.clear();consumed.clear();cancel();
        emit('none','route-changed');
      }
      const snapshot=inspect({document,url:current,includeRoot:true});bind(snapshot.root);
      const signature=signatureOf(snapshot);
      if(lastSnapshot&&(signature!==lastSnapshot.signature||!sameNodes(lastSnapshot,snapshot))){revision++;metadata=null;}
      if(!url){lastSnapshot={...snapshot,signature};return;}
      if(routeFence&&signature===routeFence){lastSnapshot={...snapshot,signature};return;}
      if(snapshot.latestAnchorKey||snapshot.cards.length)routeFence=null;
      if(metadata?.revision===revision)for(const card of snapshot.cards){
        const known=metadata.cards.find(item=>item.cardKey===card.cardKey&&item.anchorKey===card.anchorKey);
        if(known){card.taskId=known.taskId;card.enabled=known.enabled;}
      }
      probeMetadata(snapshot,signature,reason);
      const liveKeys=new Set(snapshot.cards.map(card=>card.cardKey));
      for(const cardKey of firstSeen.keys())if(!liveKeys.has(cardKey)&&pending?.cardKey!==cardKey&&initial?.cardKey!==cardKey)firstSeen.delete(cardKey);
      for(const card of snapshot.cards)if(!firstSeen.has(card.cardKey))firstSeen.set(card.cardKey,now());
      const candidates=snapshot.cards.filter(card=>card.current&&card.enabled!==false&&!consumed.has(card.cardKey));
      let generating=false;try{generating=isGenerating()===true;}catch{}
      if(pending&&generating){revision++;metadata=null;const previous=pending;consume(previous);pending=null;initial=null;cancel();emit('resumed','generation-started',previous);lastSnapshot={...snapshot,signature};return;}
      if(pending) {
        const anchorAdvanced=snapshot.latestOrdinal!==null&&pending.ordinal!==null&&snapshot.latestOrdinal>pending.ordinal;
        const retained=snapshot.cards.find(card=>card.cardKey===pending.cardKey);
        if(anchorAdvanced||(retained&&!retained.current)){const previous=pending;consume(previous);pending=null;initial=null;cancel();emit('resumed','newer-turn',previous);}
        else if(retained?.enabled===false){const previous=pending;pending=null;initial=null;cancel();emit('none','task-disabled',previous);}
      }
      if(candidates.length) {
        const card=candidates.at(-1);
        if(generating){initial={...card,firstObservedAt:firstSeen.get(card.cardKey)};cancel();arm();}
        else {
          pending={...card,firstObservedAt:firstSeen.get(card.cardKey)};initial=null;
          emit('pending',reason==='poll'?'poll-still-pending':'task-card',pending);arm();
        }
      } else if(pending) {emit('unknown','card-unmounted',pending);arm();}
      else if(initial) {
        const retained=snapshot.cards.find(card=>card.cardKey===initial.cardKey);
        if(retained&&retained.enabled!==false&&retained.current){arm();}
        else {initial=null;cancel();}
      } else if(state.phase!=='resumed'){const disabled=snapshot.cards.find(card=>card.current&&card.enabled===false),historical=snapshot.cards.filter(card=>!card.current).at(-1);emit('none',disabled?'task-disabled':historical?'historical-card':'no-current-task',disabled||historical);}
      lastSnapshot={...snapshot,signature};
    }
    function refresh(){scan('refresh');}
    function requestStarted(value) {
      if(!active())return;
      const current=canonical(getUrl());
      if(current!==url){scan('request-route');return;}
      const at=typeof value==='number'?value:value?.startedAt;
      const card=pending||initial;
      // A late STARTED message for the scheduler-creation answer is not its
      // future continuation. This compares request/observation timestamps,
      // never the localized date printed inside the card.
      if(card&&Number.isFinite(at)&&at<=card.firstObservedAt)return;
      revision++;metadata=null;
      const snapshot=inspect({document,url});
      for(const item of snapshot.cards)if(item.current)consume(item);
      if(!card)return;
      consume(card);pending=null;initial=null;cancel();emit('resumed','request-started',card);
    }
    const relevant=node=>node?.nodeType===1&&(node.matches('[data-automation-card],[data-content-search-turn-key],[data-turn-key],[data-testid^="conversation-turn-"]')||node.querySelector('[data-automation-card],[data-content-search-turn-key],[data-turn-key],[data-testid^="conversation-turn-"]'));
    const observer=new document.defaultView.MutationObserver(records=>{
      if(!active())return;
      if(records.some(record=>record.target?.closest?.('[data-automation-card]')||(record.type==='attributes'&&record.target?.matches?.('[data-content-search-turn-key],[data-turn-key],[data-testid^="conversation-turn-"],[data-talvt-turn-state],[data-app-shell-active-page]'))||Array.from(record.addedNodes||[]).some(relevant)||Array.from(record.removedNodes||[]).some(relevant)))scan('dom');
    });
    document.defaultView.addEventListener('popstate',refresh);
    refresh();
    return Object.freeze({refresh,requestStarted,dispose});
  }
  globalThis.ChatGPTDeferredTaskStatus=Object.freeze({inspect,create,pollIntervalMs:300000});
})();
