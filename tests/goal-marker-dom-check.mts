import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

// Exercise the actual content-script marker reader, isolated from the
// notification and recovery observers. No browser or network interaction.
const source=readFileSync('extension/content-script.js','utf8');
const from=source.indexOf('  function assistantGoalMarker(turn) {');
const until=source.indexOf('\n  function assistantText(turn) {',from);
assert.ok(from>0&&until>from,'production marker function is present');
const markerReader=source.slice(from,until);

function matchTurn(turn:string) {
  const {document}=parseHTML(`<html><body>${turn}</body></html>`);
  const context=createContext({document});
  runInContext(readFileSync('extension/completion-state.js','utf8'),context);
  runInContext(markerReader,context);
  return runInContext('assistantGoalMarker(document.querySelector("article"))',context)===true;
}

function match(content:string,extra='') {
  return matchTurn(`<article data-turn="assistant">
    <div data-message-author-role="assistant">
      <div class="markdown">${content}</div>${extra}
    </div>
  </article>`);
}

assert.equal(match('<p>GOAL_COMPLETE</p>'),true,'exact plain response');
assert.equal(match('<p>GOAL_COMPLETE</p>',`<div class="toolbar">
  <button aria-label="Copy"><svg></svg><span>Copy</span></button>
  <button aria-label="Share">Share</button>
</div>`),true,'Copy/Share UI is not assistant content');
assert.equal(match('<p>GOAL_COMPLETE</p>','<div aria-hidden="true">hidden decorative label</div>'),true);
assert.equal(match('<p> GOAL_COMPLETE</p>'),false,'leading answer whitespace is not exact');
assert.equal(match('<p>GOAL_COMPLETE </p>'),false,'trailing answer whitespace is not exact');
assert.equal(match('<p>GOAL_COMPLETE</p><p>Still working</p>'),false,'second paragraph in answer');
assert.equal(match('<p>GOAL_COMPLETE</p>','<p>Other assistant text outside markdown</p>'),false);
assert.equal(match('<p>GOAL_COMPLETE</p>','<div class="markdown">another output</div>'),false);
assert.equal(match('<p><code>GOAL_COMPLETE</code></p>'),false,'code is not the marker');
assert.equal(match('<p><strong>GOAL_COMPLETE</strong></p>'),false,'strong markup is not the marker');
assert.equal(match('<p><a href="#">GOAL_COMPLETE</a></p>'),false,'link is not the marker');
for(const tag of ['h1','h2','h3','h4','h5','h6','pre','blockquote','div','span'])
  assert.equal(match(`<${tag}>GOAL_COMPLETE</${tag}>`),false,`${tag} is not a plain paragraph`);
for(const tag of ['del','s','b','i','u','mark','small','sup','sub','unknown-rich-node'])
  assert.equal(match(`<p><${tag}>GOAL_COMPLETE</${tag}></p>`),false,`${tag} markup is not the marker`);
assert.equal(match('<p>GOAL_COMPLETE<br></p>'),false,'a line break is additional answer content');
assert.equal(match('<p>GOAL_COMPLETE</p><p></p>'),false,'a second empty paragraph is not the exact marker');
assert.equal(match('<p>GOAL_COMPLETE<!--extra node--></p>'),false,'unknown paragraph nodes fail closed');
assert.equal(match('<p>Done: GOAL_COMPLETE</p>'),false,'substring is not the marker');
for(const phrase of ['Маркер <code>GOAL_COMPLETE</code> не выдаю.',
 'Маркер GOAL_COMPLETE не выдаю.','GOAL_COMPLETE не выдаю.','Не завершено: GOAL_COMPLETE'])
 assert.equal(match('<p>'+phrase+'</p>'),false,'a quoted or negated mention is not a completion message');
assert.equal(match('<p>goal_complete</p>'),false,'marker is case-sensitive');
assert.equal(match('<p>GOAL_COMPLETE</p><button>Click me</button>'),false,
  'interactive content inside the rendered answer disqualifies the marker');

function fallback(content:string,extra='',headingClass='sr-only') {
  return matchTurn(`<article data-chatgpt-search-unit-key="fallback-turn-fixture:assistant">
    <h4 class="${headingClass}" data-conversation-role="assistant"><span>ChatGPT сказал:</span><span aria-hidden="true">ChatGPT</span></h4>
    <div><div data-markdown-text-style="assistant-message"><div class="markdown">${content}</div></div></div>
    ${extra}
    <div><button aria-label="Copy"><svg></svg><span>Copy</span></button><button aria-label="Good response">Good response</button></div>
  </article>`);
}
assert.equal(fallback('<p>GOAL_COMPLETE</p>'),true,
  'fallback turn screen reader role heading and feedback are interface labels');
assert.equal(fallback('<p>GOAL_COMPLETE</p>','<p>Still working</p>'),false,
  'real assistant text outside fallback markdown still disqualifies the marker');
assert.equal(fallback('<p><code>GOAL_COMPLETE</code></p>'),false,'fallback code is not a plain marker');
assert.equal(fallback('<p><strong>GOAL_COMPLETE</strong></p>'),false,'fallback styled marker is not plain');
assert.equal(fallback('<h1>GOAL_COMPLETE</h1>'),false,'fallback Markdown heading is not plain');
assert.equal(fallback('<p><del>GOAL_COMPLETE</del></p>'),false,'fallback strikethrough is not plain');
assert.equal(fallback('<p>GOAL_COMPLETE</p>','',''),false,'visible assistant headings are still content');

const dil=JSON.parse(readFileSync('tests/fixtures/goal-marker-dil.json','utf8')) as {messageId:string;html:string};
const dilTurn=(html:string,ids=dil.messageId)=>`<article data-chatgpt-search-unit-key="native-turn:1:assistant" data-chatgpt-search-message-ids="${ids}"><h4 class="sr-only" data-conversation-role="assistant">Assistant</h4><div data-markdown-text-style="assistant-message">${html}</div></article>`;
assert.equal(matchTurn(dilTurn(dil.html)),true,'native neutral DIL run is a plain marker');
assert.equal(matchTurn(dilTurn(dil.html,dil.messageId+' '+dil.messageId)),true,'duplicate identical native IDs remain one identity');
for(const html of [dil.html.replace('<p ','<h1 ').replace('</p>','</h1>'),
 dil.html.replace('GOAL_COMPLETE','<strong>GOAL_COMPLETE</strong>'),dil.html.replace('GOAL_COMPLETE','<a href="#">GOAL_COMPLETE</a>'),
 dil.html.replace('GOAL_COMPLETE','<code>GOAL_COMPLETE</code>'),dil.html.replace('GOAL_COMPLETE','<del>GOAL_COMPLETE</del>'),
 dil.html.replace('GOAL_COMPLETE','GOAL_COMPLETE '),dil.html.replace('</p>','</p><p>More</p>'),
 dil.html.replace('<span data-d-stream-run','<span style="font-weight:bold" data-d-stream-run'),
 dil.html.replace('<span data-d-stream-run','<span hidden data-d-stream-run'),
 dil.html.replace('<p class=','<p style="display:none" class='),dil.html.replace('<div hidden=""></div>','<div hidden="">Hidden meaning</div>'),
 dil.html.replace('data-dil-message-id="'+dil.messageId+'"','data-dil-message-id="other"')])
 assert.equal(matchTurn(dilTurn(html)),false,'DIL markup, hidden meaning, rich spans and extra content fail closed');
assert.equal(matchTurn(dilTurn(dil.html,'other')),false,'DIL source requires the rendered assistant native identity');

console.log('Exact Goal marker DOM, visible extra content and Copy/Share toolbar passed.');

// Real DIL may flatten the completed stream span into a plain text paragraph.
const directDIL=dil.html.replace('<span data-d-stream-run="" data-d-text-flow="run">GOAL_COMPLETE</span>','GOAL_COMPLETE');
assert.notEqual(directDIL,dil.html,'the direct-text fixture differs from the stream-run fixture');
assert.equal(matchTurn(dilTurn(directDIL)),true,'source-bound DIL plain text paragraph is an exact marker');
for(const html of [directDIL.replace('GOAL_COMPLETE','<strong>GOAL_COMPLETE</strong>'),
 directDIL.replace('GOAL_COMPLETE','<code>GOAL_COMPLETE</code>'),
 directDIL.replace('GOAL_COMPLETE','Маркер GOAL_COMPLETE не выдаю.'),
 directDIL.replace('GOAL_COMPLETE','GOAL_COMPLETE '),
 directDIL.replace('</p>','</p><p>Additional answer</p>'),
 directDIL.replace('<p class=','<p hidden class='),
 directDIL.replace('<div hidden=""></div>','<div hidden="">Hidden meaning</div>')])
 assert.equal(matchTurn(dilTurn(html)),false,'plain-text DIL retains markup, hidden content and exact-text fences');
assert.equal(matchTurn(dilTurn(directDIL,'other')),false,'plain-text DIL remains source-message bound');

// The serialized MAIN probe must carry the same exact contract.
const probe=readFileSync('extension/completion-probe.js','utf8');
const probeFrom=probe.indexOf('  function plainGoalMarkerDOM(');
const probeUntil=probe.indexOf('  const url=location.origin',probeFrom);
assert.ok(probeFrom>0&&probeUntil>probeFrom);
const mainPredicate=probe.slice(probeFrom,probeUntil);
function mainMatch(html:string,id=dil.messageId,marker='GOAL_COMPLETE') {
 const {document}=parseHTML('<html><body><div id="answer" class="markdown">'+html+'</div></body></html>');
 const context=createContext({document,sourceMessageId:id,marker});
 runInContext(mainPredicate,context);
 return runInContext('plainGoalMarkerDOM(document.querySelector("#answer"),sourceMessageId,marker)',context);
}
assert.equal(mainMatch(dil.html),true);assert.equal(mainMatch(directDIL),true);
assert.equal(mainMatch(directDIL,'other'),false);
for(const invalid of [directDIL.replace('GOAL_COMPLETE','<code>GOAL_COMPLETE</code>'),
 directDIL.replace('GOAL_COMPLETE','Маркер GOAL_COMPLETE не выдаю.'),
 directDIL.replace('</p>','</p><p>More</p>'),directDIL.replace('<p class=','<p hidden class=')])
 assert.equal(mainMatch(invalid),false,'MAIN probe keeps the same plain-text DIL refusals');

// Ordinary Markdown renderer: a single neutral span is plain text, not quotation.
assert.equal(match('<p><span>GOAL_COMPLETE</span></p>'),true);
assert.equal(fallback('<p class="Paragraph-fixture" dir="auto"><span>GOAL_COMPLETE</span></p>'),true);
for(const attrs of ['hidden','aria-hidden="true"','style="font-weight:bold"','class="rich"','role="code"'])
 assert.equal(match('<p><span '+attrs+'>GOAL_COMPLETE</span></p>'),false);
for(const text of ['Маркер GOAL_COMPLETE не выдаю.','GOAL_COMPLETE не выдаю.','GOAL_COMPLETE '])
 assert.equal(match('<p><span>'+text+'</span></p>'),false);
assert.equal(match('<p><span><code>GOAL_COMPLETE</code></span></p>'),false);
assert.equal(match('<p><span>GOAL_COMPLETE</span><span></span></p>'),false);
assert.equal(mainMatch('<div class="markdown"><p><span>GOAL_COMPLETE</span></p></div>'),true);
assert.equal(mainMatch('<div class="markdown"><p><span hidden>GOAL_COMPLETE</span></p></div>'),false);
// Current native renderer paints stream text through a color-only custom
// property. It does not turn a plain completion signal into rich text.
const inkDIL=dil.html.replace('<span data-d-stream-run','<span style="--d-stream-ink: rgb(237, 237, 237);" data-d-stream-run');
assert.equal(matchTurn(dilTurn(inkDIL)),true);assert.equal(mainMatch(inkDIL),true);
for(const style of ['--d-stream-ink: rgb(237,237,237); display:none','--d-stream-ink: rgb(237,237,237); font-weight:bold',
 '--d-stream-ink: transparent','--d-stream-ink: rgb(999,0,0)','--d-stream-ink: url(https://example.test/)','opacity:0']) {
 const html=dil.html.replace('<span data-d-stream-run',`<span style="${style}" data-d-stream-run`);
 assert.equal(matchTurn(dilTurn(html)),false,style);assert.equal(mainMatch(html),false,style);
}

assert.equal(mainMatch('<p>GOAL_BLOCKED</p>','','GOAL_BLOCKED'),true);
assert.equal(mainMatch(directDIL.replaceAll('GOAL_COMPLETE','GOAL_BLOCKED'),dil.messageId,'GOAL_BLOCKED'),true);
for(const html of ['<p>GOAL_BLOCKED не выдаю.</p>','<p><code>GOAL_BLOCKED</code></p>','<p>GOAL_BLOCKED</p><p>Reason</p>','<p> GOAL_BLOCKED</p>'])
 assert.equal(mainMatch(html,'','GOAL_BLOCKED'),false,'blocked uses the same whole plain-answer gate');

assert.equal(match('<p>GOAL_BLOCKED</p>'),true,'content reader accepts plain blocked marker');
assert.equal(match('<p>GOAL_BLOCKED</p>','<button>Copy</button>'),true,'toolbar does not alter blocked response');
for(const html of ['<p>GOAL_BLOCKED не выдаю.</p>','<p><code>GOAL_BLOCKED</code></p>','<p>GOAL_BLOCKED</p><p>Reason</p>','<p> GOAL_BLOCKED</p>'])
 assert.equal(match(html),false,'content reader rejects ambiguous blocked response');
