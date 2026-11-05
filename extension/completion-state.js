'use strict';

// HTTP/SSE closure is not answer completion. Callers bind a prompt to the
// current attempt before supplying it here; observing an old answer is unsafe.
function bindAttemptPrompt(attempt, snapshot) {
  if (!attempt || !snapshot || !attempt.id || typeof attempt.baselineKey !== 'string' ||
      attempt.url !== snapshot.url || attempt.id !== snapshot.attemptId ||
      !snapshot.promptKey || snapshot.promptKey === attempt.baselineKey) return null;
  if (attempt.promptKey && attempt.promptKey !== snapshot.promptKey) return null;
  return {...attempt,promptKey:snapshot.promptKey};
}

function completedAttemptEvidence(attempt, snapshot) {
  if (!attempt || !snapshot || !attempt.id || !attempt.promptKey ||
      attempt.url !== snapshot.url || attempt.id !== snapshot.attemptId ||
      attempt.promptKey !== snapshot.promptKey || snapshot.isLatest !== true ||
      snapshot.isReadOnly !== false || snapshot.generating !== false ||
      snapshot.hasError !== false || snapshot.turnStatus !== 'complete' ||
      !snapshot.assistantKey || snapshot.assistantCompleted !== true ||
      snapshot.assistantPhase !== 'final_answer') return null;
  return {attemptId:attempt.id,promptKey:attempt.promptKey,assistantKey:snapshot.assistantKey};
}

if (typeof module !== 'undefined') module.exports = { completedAttemptEvidence, bindAttemptPrompt };

// Positive rendered marker contract, shared by the isolated content reader.
// The MAIN probe carries the same self-contained predicate for serialization.
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
if(typeof module!=='undefined')module.exports.plainGoalMarkerDOM=plainGoalMarkerDOM;
