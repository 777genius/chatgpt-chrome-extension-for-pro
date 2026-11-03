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
for(const tag of ['del','s','b','i','u','mark','small','sup','sub','span','unknown-rich-node'])
  assert.equal(match(`<p><${tag}>GOAL_COMPLETE</${tag}></p>`),false,`${tag} markup is not the marker`);
assert.equal(match('<p>GOAL_COMPLETE<br></p>'),false,'a line break is additional answer content');
assert.equal(match('<p>GOAL_COMPLETE</p><p></p>'),false,'a second empty paragraph is not the exact marker');
assert.equal(match('<p>GOAL_COMPLETE<!--extra node--></p>'),false,'unknown paragraph nodes fail closed');
assert.equal(match('<p>Done: GOAL_COMPLETE</p>'),false,'substring is not the marker');
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

console.log('Exact Goal marker DOM, visible extra content and Copy/Share toolbar passed.');
