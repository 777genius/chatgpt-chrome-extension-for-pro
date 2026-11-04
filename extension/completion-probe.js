'use strict';

// Serialized into MAIN. Metadata by default; an armed Goal may explicitly
// request already-sent message text. Never reads drafts or invokes handlers.
// The expected attempt is bound by the extension caller.
function inspectCompletedTurn(expectedUrl, includeGoalText = false, failedPromptKey = null, sentAt = null, conversationBinding = null) {
  function plainGoalMarkerDOM(rendered,sourceMessageId='') {
    if(!rendered||rendered.textContent!=='GOAL_COMPLETE')return false;
    const plain=node=>node?.tagName==='P'&&!node.children.length&&node.childNodes.length===1&&
      node.firstChild.nodeType===3&&node.firstChild.textContent==='GOAL_COMPLETE';
    let paragraph=rendered;
    while(paragraph.tagName==='DIV'&&paragraph.matches('[data-markdown-text-style="assistant-message"], .markdown, [class*="prose"], [data-message-content]')&&paragraph.children.length===1)paragraph=paragraph.firstElementChild;
    if(plain(paragraph))return true;
    const sources=Array.from(rendered.querySelectorAll('[data-dil-source-message-id]'));
    if(sources.length!==1||!sourceMessageId||sources[0].getAttribute('data-dil-source-message-id')!==sourceMessageId)return false;
    const source=sources[0],roots=Array.from(source.querySelectorAll('[data-dil-message-id]'));
    if(roots.length!==1||roots[0].getAttribute('data-dil-message-id')!==sourceMessageId)return false;
    const dil=roots[0],p=dil.firstElementChild,run=p?.firstElementChild;
    const neutral=node=>!Array.from(node.attributes).some(a=>/^(?:role|href|contenteditable|aria-hidden|hidden)$/i.test(a.name));
    const streamed=p?.children.length===1&&p.childNodes.length===1&&run?.tagName==='SPAN'&&
      run.hasAttribute('data-d-stream-run')&&run.getAttribute('data-d-text-flow')==='run'&&
      !run.children.length&&run.childNodes.length===1&&run.firstChild.nodeType===3&&
      run.firstChild.textContent==='GOAL_COMPLETE'&&neutral(run)&&
      Array.from(run.attributes).every(a=>['data-d-stream-run','data-d-text-flow'].includes(a.name));
    // Completed DIL paragraphs can retain a stream run or flatten it to text.
    if(dil.tagName!=='DIV'||dil.children.length!==1||dil.childNodes.length!==1||p?.tagName!=='P'||
        p.getAttribute('data-d-component')!=='text'||!p.hasAttribute('data-d-text-flow')||!neutral(p)||
        (!plain(p)&&!streamed))return false;
    // Only native DIV layout wrappers and truly empty hidden placeholders may
    // surround the one DIL paragraph; no hidden/interactive meaning is ignored.
    for(const node of rendered.querySelectorAll('*')) {
      const style=node.ownerDocument?.defaultView?.getComputedStyle?.(node);
      if(node.textContent&&(node.style?.display==='none'||['hidden','collapse'].includes(node.style?.visibility)||
          style?.display==='none'||['hidden','collapse'].includes(style?.visibility)))return false;
      if(node===p||node===run)continue;
      if(node.tagName!=='DIV'||node.querySelector('button,a,input,textarea,pre,code,h1,h2,h3,h4,h5,h6,strong,em,del,s')||
          node.hasAttribute('role')||node.hasAttribute('aria-hidden')||node.hasAttribute('contenteditable')||
          node.hasAttribute('hidden')&&(node.childNodes.length||node===dil||node.contains(dil)))return false;
      if(Array.from(node.childNodes).some(child=>child.nodeType!==1&&(child.nodeType!==3||child.textContent!=='')))return false;
    }
    return true;
  }
  const url=location.origin+location.pathname.replace(/\/$/,'');
  if(url!==expectedUrl)return {ok:false,reason:'route-changed'};
  const root=document.querySelector('[data-app-shell-active-page="true"]')||document;
  const turns=Array.from(root.querySelectorAll('[data-content-search-turn-key],[data-testid^="conversation-turn-"]'));
  let element=turns.at(-1);
  if(!element)return {ok:false,reason:'turn-missing'};
  const fiberKey=Object.keys(element).find(key=>key.startsWith('__reactFiber$'));
  let fiber=fiberKey&&element[fiberKey],entry=null,entryCount=0,nativeEntries=null;
  for(let i=0;fiber&&i<20;i++,fiber=fiber.return){
    const entries=fiber.memoizedProps?.entries;
    if(!Array.isArray(entries)||!entries.length)continue;
    const latest=entries.at(-1);
    const domKey=element.getAttribute('data-content-search-turn-key')||element.getAttribute('data-testid');
    if(latest?.id===domKey&&latest.isMostRecentTurn===true){entry=latest;entryCount=entries.length;nativeEntries=entries;break;}
  }
  if(!entry)return {ok:false,reason:'native-turn-missing'};
  let historicalUserIndex=null;
  if(Number.isFinite(sentAt)&&includeGoalText===true) {
    const candidates=(nativeEntries||[]).flatMap(candidate=>
      (candidate.timestampTurns||[]).filter(item=>item.role==='user').map((time,index)=>({candidate,index,at:time.sentAtMs})))
      .filter(item=>Number.isFinite(item.at)&&Math.abs(item.at-sentAt)<=10000);
    if(candidates.length!==1)return {ok:false,reason:'historical-user-ambiguous'};
    entry=candidates[0].candidate;
    historicalUserIndex=candidates[0].index;
    element=turns.find(node=>(node.getAttribute('data-content-search-turn-key')||node.getAttribute('data-testid'))===entry.id);
    if(!element)return {ok:false,reason:'historical-user-not-rendered'};
  }
  let recoveryTimeline=null;
  if(historicalUserIndex!==null) {
    const timeline=[];
    let complete=true;
    for(const candidate of nativeEntries) {
      const items=(candidate.turn?.items||[]).filter(item=>item.type==='user-message');
      const times=(candidate.timestampTurns||[]).filter(item=>item.role==='user');
      if(items.length!==times.length||candidate.isReadOnly!==false||typeof entry.conversationId!=='string'||
          !entry.conversationId||candidate.conversationId!==entry.conversationId){complete=false;break;}
      const row=turns.find(node=>(node.getAttribute('data-content-search-turn-key')||node.getAttribute('data-testid'))===candidate.id);
      const dom=Array.from(row?.querySelectorAll('[data-chatgpt-search-unit-key$=":user"],[data-message-author-role="user"],[data-turn="user"]')||[]);
      for(let i=0;i<items.length;i++) {
        const key=dom[i]?.getAttribute('data-testid')||dom[i]?.getAttribute('data-chatgpt-search-unit-key');
        if(!key||!items[i].messageId||typeof items[i].message!=='string'||!Number.isFinite(times[i]?.sentAtMs)) {complete=false;break;}
        timeline.push({userId:items[i].messageId,userText:items[i].message,userSentAtMs:times[i].sentAtMs,
          promptKey:location.pathname+'|'+key});
      }
      if(!complete)break;
    }
    if(complete)recoveryTimeline=timeline;
  }
  const users=(entry.turn?.items||[]).filter(item=>item.type==='user-message');
  const assistants=(entry.turn?.items||[]).filter(item=>item.type==='assistant-message'&&item.phase==='final_answer');
  const user=historicalUserIndex===null?users.at(-1):users[historicalUserIndex],assistant=assistants.at(-1);
  const domUsers=Array.from(element.querySelectorAll('[data-chatgpt-search-unit-key$=":user"],[data-message-author-role="user"],[data-turn="user"]'));
  const domUser=historicalUserIndex===null?domUsers.at(-1):domUsers[historicalUserIndex];
  const domAssistant=Array.from(element.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"],[data-message-author-role="assistant"],[data-turn="assistant"]')).at(-1);
  const userKey=domUser?.getAttribute('data-testid')||domUser?.getAttribute('data-chatgpt-search-unit-key');
  const assistantKey=domAssistant?.getAttribute('data-testid')||domAssistant?.getAttribute('data-chatgpt-search-unit-key');
  if(!user?.messageId||!userKey)return {ok:false,reason:'bound-messages-missing'};
  const visible=node=>!!node.getClientRects().length;
  const generating=Array.from(root.querySelectorAll('button[data-testid="stop-button"],button[data-testid="fruitjuice-stop-button"],[data-composer-body] button:has(svg.icon-primary-action path[d^="M4.5 5.75C4.5"])')).some(visible);
  const hasError=Boolean(entry.errorMessage)||Array.from(element.querySelectorAll('aside[role="alert"].text-danger,[role="status"]:has(.text-chatgpt-recovery)')).some(visible);
  const userTimes=(entry.timestampTurns||[]).filter(item=>item.role==='user');
  const firstUserSentAtMs=entryCount===1&&users.length===1&&userTimes.length===1?userTimes[0].sentAtMs:null;
  // Native turn aggregation can remain in_progress after an aborted stream,
  // even though the conversation controller has positively become inactive.
  // Bind that controller to this exact latest entry, never another retained page.
  const aliasBindingVerified=conversationBinding?.url===expectedUrl&&
    /^local-chatgpt:[a-z0-9-]+$/.test(conversationBinding.alias||'')&&entry.conversationId===conversationBinding.alias&&
    user.messageId===conversationBinding.userId&&user.message===conversationBinding.userText&&
    userTimes.at(-1)?.sentAtMs===conversationBinding.userSentAtMs;
  let nativeConversationInactive=false;
  for(let current=fiberKey&&element[fiberKey],depth=0;current&&depth<64;depth++,current=current.return) {
    const props=current.memoizedProps;
    if(!(props?.conversationId===location.pathname.split('/').at(-1)||aliasBindingVerified&&props?.conversationId===conversationBinding.alias)||
        props.composerConversationId!==props.conversationId||props.entries!==nativeEntries||
        props.entries?.at(-1)!==entry)continue;
    nativeConversationInactive=props.isTurnActive===false&&props.awaitingGptContinuation===false&&
      props.showPendingLoadingMessage===false&&props.isConversationFetching===false&&props.isConversationLoading===false&&
      props.hasLoadError===false&&props.isComposerDisabled===false&&props.isSubmitDisabled===false&&
      props.isWorkConversation===false&&props.isSharedConversation===false;
    break;
  }
  const boundUnit=(node,item,role)=>{
    if(!node||!item?.messageId)return false;
    const unit=node.closest(`[data-chatgpt-search-unit-key$=":${role}"]`);
    if(!unit)return false;
    const ids=new Set((unit.getAttribute('data-chatgpt-search-message-ids')||'').split(/\s+/).filter(Boolean));
    const index=(entry.turn?.items||[]).lastIndexOf(item);
    return unit.getAttribute('data-chatgpt-search-unit-key')===`${entry.id}:${index}:${role}`&&
      ids.size===1&&ids.has(item.messageId);
  };
  const latestRow=element.closest('[data-turn-key]')||element;
  const currentTask=Boolean(entry.turn.automation)||Array.from(latestRow.querySelectorAll('[data-automation-card="true"]'))
    .some(node=>visible(node)&&!node.closest('[hidden],[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]'));
  const inactiveFinalCandidate=entry.turn.status==='in_progress'&&nativeConversationInactive&&
    entry.isMostRecentTurn===true&&entry.isReadOnly===false&&!generating&&!hasError&&!currentTask&&
    assistant?.phase==='final_answer'&&assistant.completed===true&&
    boundUnit(domUser,user,'user')&&boundUnit(domAssistant,assistant,'assistant');
  let goalText={};
  if(includeGoalText===true) {
    let userVisibleText=null;
    const unit=domUser?.closest('[data-chatgpt-search-unit-key$=":user"]');
    const userIndex=(entry.turn?.items||[]).lastIndexOf(user);
    const unitBound=unit?.getAttribute('data-chatgpt-search-unit-key')===`${entry.id}:${userIndex}:user`;
    const messageIds=unit?.getAttribute('data-chatgpt-search-message-ids');
    const ids=new Set((messageIds||'').split(/\s+/).filter(Boolean));
    const idsBound=ids.size===1&&ids.has(user.messageId);
    if((unitBound||idsBound)&&(messageIds==null||idsBound)) {
      // Read only a concrete sent-message body after binding its unit or native
      // message ID. A whole turn also contains speaker, file and toolbar text.
      const candidates=Array.from(domUser.querySelectorAll('[data-user-message-bubble="true"] [data-search-result-target] div.whitespace-pre-wrap'))
        .filter(node=>node.isConnected&&visible(node)&&!node.closest('[aria-hidden="true"],[hidden],[inert],[data-app-shell-active-page="false"]'));
      const body=candidates.find(node=>!candidates.some(parent=>parent!==node&&parent.contains(node)));
      if(body&&candidates.every(node=>body.contains(node))) {
        const textBody=body.querySelector('[data-markdown-text-tone="user-message"]')||body;
        const copy=textBody.cloneNode(true);
        // Computed visibility belongs to mounted originals, not detached
        // clones. Do not use child rects: display:contents wrappers have none.
        const originals=Array.from(textBody.querySelectorAll('*')),clones=Array.from(copy.querySelectorAll('*'));
        for(let index=0;index<originals.length;index++) {
          const style=document.defaultView?.getComputedStyle?.(originals[index]);
          if(style?.display==='none'||['hidden','collapse'].includes(style?.visibility))clones[index].remove();
        }
        copy.querySelectorAll('button,[role="button"],svg,[aria-hidden="true"],[hidden],.ProseMirror-widget,[data-composer-attachments],[data-testid*="attachment"],h4.sr-only[data-conversation-role="user"]').forEach(node=>node.remove());
        function text(node) {
          if(node.nodeType===3)return node.textContent||'';
          if(node.nodeType!==1)return '';
          if(node.tagName==='BR')return node.classList.contains('ProseMirror-trailingBreak')?'':'\n';
          return Array.from(node.childNodes).map(text).join(['UL','OL'].includes(node.tagName)?'\n':'');
        }
        userVisibleText=copy.querySelector('p, div, br, li')?Array.from(copy.childNodes).map(text).join('\n'):text(copy);
      }
    }
    let goalResponse=typeof assistant?.content==='string'?assistant.content:'';
    // Native DIL answers may store only a content reference. Resolve complete
    // fallback Markdown only when that reference is the entire native body;
    // surrounding prose/code and missing fallback parts must remain non-exact.
    const references=assistant?.contentReferences;
    if(/^::chatgpt-content-reference\{[^{}]+\}/.exec(goalResponse)?.[0]===goalResponse&&
        Array.isArray(references)&&references.length&&
        references.every(ref=>typeof ref?.model_dil_v2?.fallbackMarkdown==='string')) {
      goalResponse=references.map(ref=>ref.model_dil_v2.fallbackMarkdown).join('\n\n');
      // Native DIL serialization escapes this literal underscore. This single
      // representation still needs the independent plain rendered check below.
      if(goalResponse==='GOAL\\_COMPLETE')goalResponse='GOAL_COMPLETE';
    }
    const rendered=domAssistant?.querySelector('[data-markdown-text-style="assistant-message"], .markdown, [class*="prose"], [data-message-content]');
    let goalRawExact=false;
    const assistantUnit=domAssistant?.closest('[data-chatgpt-search-unit-key$=":assistant"]');
    const assistantIndex=(entry.turn?.items||[]).lastIndexOf(assistant);
    const assistantIds=new Set((assistantUnit?.getAttribute('data-chatgpt-search-message-ids')||'').split(/\s+/).filter(Boolean));
    const unitMatches=assistantUnit?.getAttribute('data-chatgpt-search-unit-key')===`${entry.id}:${assistantIndex}:assistant`;
    const boundDIL=assistant?.messageId&&(unitMatches||assistantIds.size===1&&assistantIds.has(assistant.messageId))&&
      (!assistantIds.size||assistantIds.size===1&&assistantIds.has(assistant.messageId))&&
      references?.some(ref=>ref.source_message_id===assistant.messageId)?assistant.messageId:'';
    if(goalResponse==='GOAL_COMPLETE'&&plainGoalMarkerDOM(rendered,boundDIL)) {
      const semantic=domAssistant.cloneNode(true);
      semantic.querySelectorAll('button,[role="button"],svg,[aria-hidden="true"],h4.sr-only[data-conversation-role="assistant"]').forEach(node=>node.remove());
      goalRawExact=semantic.textContent.trim()==='GOAL_COMPLETE';
    }
    // Require the exact native completion envelope and corroborate its marker
    // in the rendered answer. Preserve the existing marker-only protocol.
    const summaryBody=goalResponse.replace(/\\([_:\-])/g,'$1');
    // The marker declares completion. Summary length, links, wrapping and
    // paragraph spacing do not change that declaration.
    const summary = /^GOAL_COMPLETE\r?\n\r?\nИтог:\r?\n(?:\r?\n)?- \S[\s\S]*$/.test(summaryBody);
    if(summary&&rendered) {
      const marker = Array.from(rendered.querySelectorAll('p')).find(node=>
        node.textContent==='GOAL_COMPLETE'&&!node.closest('[hidden],[aria-hidden="true"],blockquote,li,pre'));
      const run=marker?.firstElementChild;
      const plainSpan=marker?.childNodes.length===1&&run?.tagName==='SPAN'&&run.attributes.length===0&&
        run.childNodes.length===1&&run.firstChild.nodeType===3&&run.firstChild.textContent==='GOAL_COMPLETE';
      if(marker&&(plainGoalMarkerDOM(marker)||plainSpan||boundDIL&&marker.closest('[data-dil-message-id]')?.getAttribute('data-dil-message-id')===boundDIL&&
          marker.children.length===1&&marker.firstElementChild?.matches('span[data-d-stream-run]')&&
          marker.firstElementChild.children.length===0&&
          !marker.closest('[hidden],[aria-hidden="true"],[style*="display: none"]'))) {
        goalResponse='GOAL_COMPLETE';
        goalRawExact=true;
      }
    }
    const sentAtMs=(historicalUserIndex===null?userTimes.at(-1):userTimes[historicalUserIndex])?.sentAtMs;
    goalText={userText:typeof user.message==='string'?user.message:'',userVisibleText,userSentAtMs:Number.isFinite(sentAtMs)?sentAtMs:null,
      ...(historicalUserIndex!==null?{recoveryTimeline}:{}),
      goalResponse,goalRawExact};
  }
  // Failure rollback is separate from completion. Require the real idle
  // voice control AND its native editor controller; absence of Stop is unsafe.
  let composerIdle=false,nativeControllerIdle=false,absentPromptKey=null;
  if(nativeConversationInactive||typeof failedPromptKey==='string'&&failedPromptKey.startsWith(location.pathname+'|')) {
    const key=typeof failedPromptKey==='string'?failedPromptKey.slice(location.pathname.length+1):'',match=/^(.*):(\d+):user$/.exec(key);
    if(match&&nativeEntries&&!nativeEntries.some(item=>item.id===match[1]))absentPromptKey=failedPromptKey;
    const visibleIdle=node=>Boolean(node?.isConnected&&visible(node)&&!node.closest('[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]'));
    const voice=Array.from(root.querySelectorAll('[data-composer-body] button')).find(node=>visibleIdle(node)&&!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&node.getAttribute('aria-busy')!=='true'&&node.querySelector('use[href$="#codex-icon-voice-regular-20"]'));
    let nativeVoiceIdle=false;
    const voiceKey=voice&&Object.keys(voice).find(key=>key.startsWith('__reactFiber$'));
    for(let current=voiceKey&&voice[voiceKey],i=0;current&&i<16;i++,current=current.return) {
      if(current.memoizedProps?.isLoading===false&&current.memoizedProps.isStartButtonAllowed===true)nativeVoiceIdle=true;
    }
    const editor=Array.from(root.querySelectorAll('#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,[data-composer-markdown][contenteditable="true"]')).find(visibleIdle);
    for(let node=editor;node&&!composerIdle;node=node.parentElement) {
      const key=Object.keys(node).find(name=>name.startsWith('__reactFiber$'));
      for(let current=key&&node[key],i=0;current&&i<16;i++,current=current.return) {
        const controller=current.memoizedProps?.composerController;
        if(controller?.view?.dom===editor&&typeof controller.getChatGptPrompt==='function'&&typeof controller.submitReady==='boolean') {
          if(controller.pendingSubmit===null&&controller.pendingBrowserAutocompleteSubmission===null)nativeControllerIdle=true;
          if(controller.pendingSubmit==null&&controller.pendingBrowserAutocompleteSubmission==null)composerIdle=Boolean(voice&&nativeVoiceIdle);
        }
      }
    }
  }
  const inactiveProof=nativeConversationInactive&&nativeControllerIdle&&!currentTask&&entry.isMostRecentTurn===true&&
    entry.isReadOnly===false&&boundUnit(domUser,user,'user');
  const terminalEmptyResponse=entry.turn.status==='complete'&&inactiveProof&&!generating&&!hasError&&!domAssistant&&users.length>0&&
    entry.turn.items.every(item=>['user-message','chatgpt-reasoning-group'].includes(item.type));
  return {ok:true,url,firstUserSentAtMs,lastUserSentAtMs:userTimes.at(-1)?.sentAtMs,firstTurn:entryCount===1,promptKey:location.pathname+'|'+userKey,assistantKey:assistantKey||'',userId:user.messageId,
    assistantId:assistant?.messageId||'',isLatest:entry.isMostRecentTurn===true,isReadOnly:entry.isReadOnly,
    reasoningFailed:entry.turn.status==='cancelled'&&
      entry.turn.items.some(item=>item.type==='chatgpt-reasoning-group')&&
      !entry.turn.items.some(item=>item.type==='assistant-message'),
    nativeTurnStatus:entry.turn.status,
    nativeConversationInactive:inactiveProof,nativeConversationId:entry.conversationId||null,terminalEmptyResponse,
    turnStatus:inactiveFinalCandidate&&composerIdle&&nativeControllerIdle?'complete':entry.turn.status,
    completionProof:inactiveFinalCandidate&&composerIdle&&nativeControllerIdle?'native-inactive-final':null,
    assistantPhase:assistant?.phase,assistantCompleted:assistant?.completed===true,
    generating,hasError,...(failedPromptKey?{composerIdle,absentPromptKey}:{}),...goalText};
}
if(typeof module!=='undefined')module.exports={inspectCompletedTurn};
