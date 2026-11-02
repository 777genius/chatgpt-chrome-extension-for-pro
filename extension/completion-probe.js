'use strict';

// Serialized into MAIN. Metadata only; never invokes React handlers or reads
// draft/answer text. The expected attempt is bound by the extension caller.
function inspectCompletedTurn(expectedUrl) {
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
  return {ok:true,url,firstUserSentAtMs,firstTurn:entryCount===1,promptKey:location.pathname+'|'+userKey,assistantKey:assistantKey||'',userId:user.messageId,
    assistantId:assistant?.messageId||'',isLatest:entry.isMostRecentTurn===true,isReadOnly:entry.isReadOnly,
    turnStatus:entry.turn.status,assistantPhase:assistant?.phase,assistantCompleted:assistant?.completed===true,
    generating,hasError};
}
if(typeof module!=='undefined')module.exports={inspectCompletedTurn};
