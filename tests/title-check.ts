import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Naming = { version: 1; sourceUrl: string; baseTitle: string; part: number; title: string };
type Lineage = Naming & { targetUrl: string; confirmed: true };
type Policy = {
  chatUrl: (url: string) => string;
  planNext: (input: { sourceUrl: string; sourceTitle: string; lineage?: unknown }) => Naming;
  confirm: (naming: Naming, targetUrl: string) => Lineage;
};
const context = createContext({ URL });
runInContext(readFileSync('extension/handoff-title.js', 'utf8'), context);
const policy = context.ChatGPTHandoffTitle as Policy;
const sourceUrl = 'https://chatgpt.com/c/source';
const targetUrl = 'https://chatgpt.com/c/target';
const nextUrl = 'https://chatgpt.com/c/next';
const plan = policy.planNext({ sourceUrl, sourceTitle: 'Release (2026)' });
assert.equal(plan.title, 'Release (2026) (1)', 'real parentheses must survive unchanged');
const stored = JSON.parse(JSON.stringify(policy.confirm(plan, targetUrl))) as Lineage;
assert.equal(policy.planNext({ sourceUrl: targetUrl, sourceTitle: stored.title, lineage: stored }).title,
  'Release (2026) (2)', 'a persisted, confirmed continuation increments the same chain');
assert.equal(policy.planNext({ sourceUrl: nextUrl, sourceTitle: stored.title, lineage: stored }).title,
  'Release (2026) (1) (1)', 'an unrelated chat with a colliding title is never treated as the chain');
const renamedPlan=policy.planNext({ sourceUrl: targetUrl, sourceTitle: 'Owner renamed (9)', lineage: stored });
assert.equal(renamedPlan.title,
  'Owner renamed (9) (2)', 'a manual title change keeps the confirmed chain count and all literal title characters');
const renamedLineage=policy.confirm(renamedPlan,nextUrl);
assert.equal(policy.planNext({ sourceUrl: nextUrl,sourceTitle:renamedLineage.title,lineage:renamedLineage }).title,
  'Owner renamed (9) (3)', 'the next continuation keeps the updated base and incremented count');
assert.equal(policy.planNext({sourceUrl:targetUrl,sourceTitle:'Automatic new-chat title',lineage:{...stored,confirmed:false,transferred:true}}).title,
 'Release (2026) (2)','confirmed transfer keeps its count and original base even when renaming failed');
for (const lineage of [{ ...stored, confirmed: false,transferred:false }, { ...stored, part: 8 }, { ...stored, version: 2 }]) {
  assert.equal(policy.planNext({ sourceUrl: targetUrl, sourceTitle: stored.title, lineage }).title,
    'Release (2026) (1) (1)', 'unconfirmed or inconsistent metadata cannot strip a suffix');
}
assert.equal(policy.planNext({ sourceUrl, sourceTitle: 'Task (1)' }).title, 'Task (1) (1)');
assert.throws(() => policy.planNext({ sourceUrl, sourceTitle: '  ' }));
assert.throws(() => policy.confirm(plan, sourceUrl), /binding/);
assert.throws(() => policy.confirm(plan, 'https://elsewhere.test/c/target'), /binding/);
assert.equal(policy.chatUrl(`${targetUrl}?view=chat#message`), targetUrl);
assert.equal(policy.chatUrl(`${targetUrl}/?view=chat#message`), targetUrl);
for(const suffix of ['local-chatgpt:temporary-id','local-chatgpt%3Atemporary-id','local-chatgpt%253Atemporary-id','target%2Fother','target_extra']) {
  assert.equal(policy.chatUrl(`https://chatgpt.com/c/${suffix}`),'','a temporary alias or encoded ID cannot bind a handoff');
  assert.throws(()=>policy.confirm(plan,`https://chatgpt.com/c/${suffix}`),/binding/);
}
assert.equal(policy.chatUrl('https://chatgpt.com/c/11111111-2222-3333-4444-555555555555'),
  'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555');

console.log('PASS: persisted exact-chat lineage, continuation counts after rename, literal parentheses/collisions, invalid lineage refusal');
