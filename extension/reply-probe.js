'use strict';
// Observation only: a native reply may outlive its user-message item. This
// witness never confirms a missing user payload or authorizes another click.
function inspectDetachedUserReply(expectedUrl,startedAt) {
function plainGoalMarkerDOM(rendered,sourceMessageId='',marker='GOAL_COMPLETE') {
  if(!rendered||rendered.textContent!==marker)return false;
  const plain=node=>{
    if(node?.tagName!=='P'||node.childNodes.length!==1)return false;
    const text=node.firstChild;
    if(text.nodeType===3)return text.textContent===marker;
    // ChatGPT's ordinary renderer wraps unformatted text in an attribute-free span.
    return text.tagName==='SPAN'&&text.attributes.length===0&&text.childNodes.length===1&&
      text.firstChild.nodeType===3&&text.firstChild.textContent===marker;
  };
  let paragraph=rendered;
  while(paragraph.tagName==='DIV'&&paragraph.matches('[data-markdown-text-style="assistant-message"], .markdown, [class*="prose"], [data-message-content]')&&paragraph.children.length===1)paragraph=paragraph.firstElementChild;
  if(plain(paragraph))return true;
  const sources=Array.from(rendered.querySelectorAll('[data-dil-source-message-id]'));
  if(sources.length!==1||!sourceMessageId||sources[0].getAttribute('data-dil-source-message-id')!==sourceMessageId)return false;
  const source=sources[0],roots=Array.from(source.querySelectorAll('[data-dil-message-id]'));
  if(roots.length!==1||roots[0].getAttribute('data-dil-message-id')!==sourceMessageId)return false;
  const dil=roots[0],p=dil.firstElementChild,run=p?.firstElementChild;
  const neutral=node=>!Array.from(node.attributes).some(a=>/^(?:role|href|contenteditable|aria-hidden|hidden)$/i.test(a.name));
  const ink=run?.getAttribute('style'),color=ink?.trim().match(/^--d-stream-ink:\s*rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)\s*;?$/);
  const inkOnly=!run?.hasAttribute('style')||Boolean(color&&color.slice(1).every(v=>Number(v)<=255));
  const streamed=p?.children.length===1&&p.childNodes.length===1&&run?.tagName==='SPAN'&&
    run.hasAttribute('data-d-stream-run')&&run.getAttribute('data-d-text-flow')==='run'&&
    !run.children.length&&run.childNodes.length===1&&run.firstChild.nodeType===3&&
    run.firstChild.textContent===marker&&neutral(run)&&
    inkOnly&&Array.from(run.attributes).every(a=>['data-d-stream-run','data-d-text-flow','style'].includes(a.name));
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
  if(url!==expectedUrl||!Number.isFinite(startedAt))return {ok:false};
  const root=document.querySelector('[data-app-shell-active-page="true"]')||document;
  const rows=Array.from(root.querySelectorAll('[data-content-search-turn-key]'));
  if(rows.length!==1)return {ok:false};
  const row=rows[0],key=row.getAttribute('data-content-search-turn-key'),fiberKey=Object.keys(row).find(k=>k.startsWith('__reactFiber$'));
  let entries=null,entry=null,controller=null,routeBound=false;
  for(let f=fiberKey&&row[fiberKey],i=0;f&&i<80;i++,f=f.return) {
    const p=f.memoizedProps;
    if(!entry&&Array.isArray(p?.entries)&&p.entries.length===1&&p.entries[0]?.id===key&&p.entries[0].isMostRecentTurn===true){entries=p.entries;entry=entries[0];}
    if(entry&&p?.entries===entries&&p.composerConversationId===entry.conversationId&&p.conversationId===entry.conversationId)controller=p;
    if(controller&&p?.conversationId===location.pathname.split('/').at(-1))routeBound=true;
  }
  if(!entry||!controller||!routeBound||entry.isReadOnly!==false||entry.turn?.status!=='complete'||entry.errorMessage||
      controller.isTurnActive!==false||controller.awaitingGptContinuation!==false||controller.showPendingLoadingMessage!==false||
      controller.isConversationFetching!==false||controller.isConversationLoading!==false||controller.hasLoadError!==false||
      controller.isWorkConversation!==false||controller.isSharedConversation!==false)return {ok:false};
  const items=entry.turn.items||[],times=entry.timestampTurns||[],answers=items.filter(x=>x.type==='assistant-message'&&x.phase==='final_answer');
  if(items.some(x=>x.type==='user-message')||answers.length!==1||times.length!==1||times[0].role!=='assistant'||
      !Number.isFinite(times[0].sentAtMs)||times[0].sentAtMs<startedAt||times[0].sentAtMs-startedAt>10000||entry.turn.automation)return {ok:false};
  const answer=answers[0];
  if(!answer.messageId||answer.completed!==true)return {ok:false};
  const visible=n=>n.isConnected&&n.getClientRects().length>0&&!n.closest('[hidden],[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]');
  if(Array.from(root.querySelectorAll('button[data-testid="stop-button"],button[data-testid="fruitjuice-stop-button"],[data-composer-body] button:has(svg.icon-primary-action path[d^="M4.5 5.75C4.5"])')).some(visible)||
      Array.from(row.querySelectorAll('aside[role="alert"],[role="status"]:has(.text-chatgpt-recovery),[data-automation-card="true"]')).some(visible))return {ok:false};
  const units=Array.from(row.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"]'));
  const index=items.indexOf(answer),unit=units.find(n=>n.getAttribute('data-chatgpt-search-unit-key')===`${entry.id}:${index}:assistant`);
  const ids=new Set((unit?.getAttribute('data-chatgpt-search-message-ids')||'').split(/\s+/).filter(Boolean));
  if(!unit||!visible(unit)||ids.size!==1||!ids.has(answer.messageId)||
      entry.turn.logicalAnswerMessageId&&entry.turn.logicalAnswerMessageId!==answer.messageId||!entry.turn.firstServerMessageId)return {ok:false};
  const rendered=unit.querySelector('[data-markdown-text-style="assistant-message"],.markdown,[class*="prose"],[data-message-content]');
  if(!rendered||!visible(rendered))return {ok:false};
  let body=typeof answer.content==='string'?answer.content:'';
  const wholeReference=/^::chatgpt-content-reference\{[^{}]+\}$/.test(body),rawCandidate=/^GOAL(?:\\+)?_(?:COMPLETE|BLOCKED)$/.test(body);
  if(/^::chatgpt-content-reference\{[^{}]+\}$/.test(body)&&Array.isArray(answer.contentReferences)&&answer.contentReferences.length&&answer.contentReferences.every(r=>typeof r?.model_dil_v2?.fallbackMarkdown==='string')) {
    body=answer.contentReferences.map(r=>r.model_dil_v2.fallbackMarkdown).join('\n\n');
    if(['GOAL\\_COMPLETE','GOAL\\_BLOCKED'].includes(body))body=body.replace('\\_','_');
  }
  const semantic=unit.cloneNode(true);
  semantic.querySelectorAll('button,[role="button"],svg,[aria-hidden="true"],h4.sr-only[data-conversation-role="assistant"]').forEach(node=>node.remove());
  const marker=['GOAL_COMPLETE','GOAL_BLOCKED'].includes(body)&&plainGoalMarkerDOM(rendered,answer.messageId,body)&&semantic.textContent.trim()===body;
  return {ok:true,goalResponse:body,goalRawExact:Boolean(marker),goalMarkerPending:!marker&&Boolean(rawCandidate||wholeReference&&(/^GOAL(?:\\+)?_(?:COMPLETE|BLOCKED)$/.test(body)||/^::chatgpt-content-reference\{[^{}]+\}$/.test(body)&&['GOAL_COMPLETE','GOAL_BLOCKED'].includes(rendered.textContent))),url,assistantId:answer.messageId,assistantKey:unit.getAttribute('data-chatgpt-search-unit-key'),
    response:rendered.innerText||rendered.textContent||'',responseStartedAt:times[0].sentAtMs,alias:entry.conversationId,
    firstServerMessageId:entry.turn.firstServerMessageId,proof:'native-detached-user-final'};
}
if(typeof module!=='undefined')module.exports={inspectDetachedUserReply};
