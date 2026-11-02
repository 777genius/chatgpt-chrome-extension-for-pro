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

function match(content:string,extra='') {
  const {document}=parseHTML(`<html><body><article data-turn="assistant">
    <div data-message-author-role="assistant">
      <div class="markdown">${content}</div>${extra}
    </div>
  </article></body></html>`);
  const context=createContext({document});
  runInContext(markerReader,context);
  return runInContext('assistantGoalMarker(document.querySelector("article"))',context)===true;
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
assert.equal(match('<p>Done: GOAL_COMPLETE</p>'),false,'substring is not the marker');
assert.equal(match('<p>goal_complete</p>'),false,'marker is case-sensitive');
assert.equal(match('<p>GOAL_COMPLETE</p><button>Click me</button>'),false,
  'interactive content inside the rendered answer disqualifies the marker');

console.log('Exact Goal marker DOM, visible extra content and Copy/Share toolbar passed.');
