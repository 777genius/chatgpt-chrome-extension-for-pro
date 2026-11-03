'use strict';

// Serialized into MAIN. Metadata by default; an armed Goal may explicitly
// request already-sent message text. Never reads drafts or invokes handlers.
// The expected attempt is bound by the extension caller.
function inspectCompletedTurn(expectedUrl, includeGoalText = false) {
  const url=location.origin+location.pathname.replace(/\/$/,'');
  if(url!==expectedUrl)return {ok:false,reason:'route-changed'};
  const root=document.querySelector('[data-app-shell-active-page="true"]')||document;
  const turns=Array.from(root.querySelectorAll('[data-content-search-turn-key],[data-testid^="conversation-turn-"]'));
  const element=turns.at(-1);
  if(!element)return {ok:false,reason:'turn-missing'};
  const fiberKey=Object.keys(element).find(key=>key.startsWith('__reactFiber$'));
  let fiber=fiberKey&&element[fiberKey],entry=null,entryCount=0;
  for(let i=0;fiber&&i<20;i++,fiber=fiber.return){
    const entries=fiber.memoizedProps?.entries;
    if(!Array.isArray(entries)||!entries.length)continue;
    const latest=entries.at(-1);
    const domKey=element.getAttribute('data-content-search-turn-key')||element.getAttribute('data-testid');
    if(latest?.id===domKey&&latest.isMostRecentTurn===true){entry=latest;entryCount=entries.length;break;}
  }
  if(!entry)return {ok:false,reason:'native-turn-missing'};
  const users=(entry.turn?.items||[]).filter(item=>item.type==='user-message');
  const assistants=(entry.turn?.items||[]).filter(item=>item.type==='assistant-message'&&item.phase==='final_answer');
  const user=users.at(-1),assistant=assistants.at(-1);
  const domUser=Array.from(element.querySelectorAll('[data-chatgpt-search-unit-key$=":user"],[data-message-author-role="user"],[data-turn="user"]')).at(-1);
  const domAssistant=Array.from(element.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"],[data-message-author-role="assistant"],[data-turn="assistant"]')).at(-1);
  const userKey=domUser?.getAttribute('data-testid')||domUser?.getAttribute('data-chatgpt-search-unit-key');
  const assistantKey=domAssistant?.getAttribute('data-testid')||domAssistant?.getAttribute('data-chatgpt-search-unit-key');
  if(!user?.messageId||!userKey)return {ok:false,reason:'bound-messages-missing'};
  const visible=node=>!!node.getClientRects().length;
  const generating=Array.from(root.querySelectorAll('button[data-testid="stop-button"],button[data-testid="fruitjuice-stop-button"],[data-composer-body] button:has(svg.icon-primary-action path[d^="M4.5 5.75C4.5"])')).some(visible);
  const hasError=Boolean(entry.errorMessage)||Array.from(root.querySelectorAll('aside[role="alert"].text-danger,[role="status"]:has(.text-chatgpt-recovery)')).some(visible);
  const userTimes=(entry.timestampTurns||[]).filter(item=>item.role==='user');
  const firstUserSentAtMs=entryCount===1&&users.length===1&&userTimes.length===1?userTimes[0].sentAtMs:null;
  let goalText={};
  if(includeGoalText===true) {
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
    if(goalResponse==='GOAL_COMPLETE'&&rendered?.textContent==='GOAL_COMPLETE') {
      // Match the content reader's positive plain-answer structure: one
      // text-only paragraph, reached only through known native Markdown DIVs.
      let paragraph=rendered;
      while(paragraph.tagName==='DIV'&&paragraph.matches('[data-markdown-text-style="assistant-message"], .markdown, [class*="prose"], [data-message-content]')&&
          paragraph.children.length===1)paragraph=paragraph.firstElementChild;
      if(paragraph.tagName==='P'&&!paragraph.children.length&&paragraph.childNodes.length===1&&
          paragraph.firstChild.nodeType===3&&paragraph.firstChild.textContent==='GOAL_COMPLETE') {
        const semantic=domAssistant.cloneNode(true);
        semantic.querySelectorAll('button,[role="button"],svg,[aria-hidden="true"],h4.sr-only[data-conversation-role="assistant"]').forEach(node=>node.remove());
        goalRawExact=semantic.textContent.trim()==='GOAL_COMPLETE';
      }
    }
    const sentAtMs=userTimes.at(-1)?.sentAtMs;
    goalText={userText:typeof user.message==='string'?user.message:'',userSentAtMs:Number.isFinite(sentAtMs)?sentAtMs:null,
      goalResponse,goalRawExact};
  }
  return {ok:true,url,firstUserSentAtMs,firstTurn:entryCount===1,promptKey:location.pathname+'|'+userKey,assistantKey:assistantKey||'',userId:user.messageId,
    assistantId:assistant?.messageId||'',isLatest:entry.isMostRecentTurn===true,isReadOnly:entry.isReadOnly,
    turnStatus:entry.turn.status,assistantPhase:assistant?.phase,assistantCompleted:assistant?.completed===true,
    generating,hasError,...goalText};
}
if(typeof module!=='undefined')module.exports={inspectCompletedTurn};
