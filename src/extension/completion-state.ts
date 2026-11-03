"use strict";

// SSE completion alone is not evidence of a completed answer. This policy is
// intentionally independent of the DOM adapter and any send capability.
interface CompletionAttempt {
  id: string;
  url: string;
  baselineKey: string;
  promptKey?: string;
}
interface CompletionSnapshot {
  url: string;
  attemptId: string;
  promptKey: string;
  isLatest: boolean;
  isReadOnly: boolean;
  generating: boolean;
  hasError: boolean;
  turnStatus: string;
  assistantKey: string;
  assistantCompleted: boolean;
  assistantPhase: string;
}
interface CompletionEvidence {
  attemptId: string;
  promptKey: string;
  assistantKey: string;
}

function bindAttemptPrompt(
  attempt: CompletionAttempt | null | undefined,
  snapshot: CompletionSnapshot | null | undefined,
): CompletionAttempt | null {
  if (!attempt || !snapshot || !attempt.id || typeof attempt.baselineKey !== "string" ||
      attempt.url !== snapshot.url || attempt.id !== snapshot.attemptId ||
      !snapshot.promptKey || snapshot.promptKey === attempt.baselineKey) return null;
  if (attempt.promptKey && attempt.promptKey !== snapshot.promptKey) return null;
  return { ...attempt, promptKey: snapshot.promptKey };
}

function completedAttemptEvidence(
  attempt: CompletionAttempt | null | undefined,
  snapshot: CompletionSnapshot | null | undefined,
): CompletionEvidence | null {
  if (!attempt || !snapshot || !attempt.id || !attempt.promptKey ||
      attempt.url !== snapshot.url || attempt.id !== snapshot.attemptId ||
      attempt.promptKey !== snapshot.promptKey || snapshot.isLatest !== true ||
      snapshot.isReadOnly !== false || snapshot.generating !== false ||
      snapshot.hasError !== false || snapshot.turnStatus !== "complete" ||
      !snapshot.assistantKey || snapshot.assistantCompleted !== true ||
      snapshot.assistantPhase !== "final_answer") return null;
  return { attemptId: attempt.id, promptKey: snapshot.promptKey, assistantKey: snapshot.assistantKey };
}

// Historical mock tests import the standalone classic script as CommonJS.
if (typeof module !== "undefined") module.exports = { completedAttemptEvidence, bindAttemptPrompt };

// Positive rendered marker contract, shared by the isolated content reader.
// The MAIN probe carries the same self-contained predicate for serialization.
function plainGoalMarkerDOM(rendered:Element|null|undefined,sourceMessageId:string=''):boolean {
  if(!rendered||rendered.textContent!=='GOAL_COMPLETE')return false;
  const plain=(node:Element|null|undefined):boolean=>node?.tagName==='P'&&!node.children.length&&node.childNodes.length===1&&
    node.firstChild?.nodeType===3&&node.firstChild?.textContent==='GOAL_COMPLETE';
  let paragraph:Element=rendered;
  while(paragraph.tagName==='DIV'&&paragraph.matches('[data-markdown-text-style="assistant-message"], .markdown, [class*="prose"], [data-message-content]')&&paragraph.children.length===1)paragraph=paragraph.firstElementChild!;
  if(plain(paragraph))return true;
  const sources=Array.from(rendered.querySelectorAll('[data-dil-source-message-id]'));
  if(sources.length!==1||!sourceMessageId||sources[0].getAttribute('data-dil-source-message-id')!==sourceMessageId)return false;
  const source=sources[0],roots=Array.from(source.querySelectorAll('[data-dil-message-id]'));
  if(roots.length!==1||roots[0].getAttribute('data-dil-message-id')!==sourceMessageId)return false;
  const dil=roots[0],p=dil.firstElementChild,run=p?.firstElementChild;
  const neutral=(node:Element)=>!Array.from(node.attributes).some(a=>/^(?:role|href|contenteditable|aria-hidden|hidden)$/i.test(a.name));
  if(dil.tagName!=='DIV'||dil.children.length!==1||dil.childNodes.length!==1||p?.tagName!=='P'||
      p.getAttribute('data-d-component')!=='text'||!p.hasAttribute('data-d-text-flow')||p.children.length!==1||p.childNodes.length!==1||
      run?.tagName!=='SPAN'||!run.hasAttribute('data-d-stream-run')||run.getAttribute('data-d-text-flow')!=='run'||
      run.children.length||run.childNodes.length!==1||run.firstChild?.nodeType!==3||run.firstChild?.textContent!=='GOAL_COMPLETE'||!neutral(p)||!neutral(run)||
      Array.from(run.attributes).some(a=>!['data-d-stream-run','data-d-text-flow'].includes(a.name)))return false;
  // Only native DIV layout wrappers and truly empty hidden placeholders may
  // surround the one DIL paragraph; no hidden/interactive meaning is ignored.
  for(const node of rendered.querySelectorAll<HTMLElement>('*')) {
    const style=node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    if(node.textContent&&(node.style?.display==='none'||['hidden','collapse'].includes(node.style?.visibility)||
        style?.display==='none'||['hidden','collapse'].includes(style?.visibility??'')))return false;
    if(node===p||node===run)continue;
    if(node.tagName!=='DIV'||node.querySelector('button,a,input,textarea,pre,code,h1,h2,h3,h4,h5,h6,strong,em,del,s')||
        node.hasAttribute('role')||node.hasAttribute('aria-hidden')||node.hasAttribute('contenteditable')||
        node.hasAttribute('hidden')&&(node.childNodes.length||node===dil||node.contains(dil)))return false;
    if(Array.from(node.childNodes).some(child=>child.nodeType!==1&&(child.nodeType!==3||child.textContent!=='')))return false;
  }
  return true;
}
if(typeof module!=='undefined')module.exports.plainGoalMarkerDOM=plainGoalMarkerDOM;
