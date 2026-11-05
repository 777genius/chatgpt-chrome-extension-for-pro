import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(path,'utf8');
const manifest=JSON.parse(read('extension/manifest.json'));
const pkg=JSON.parse(read('package.json'));
const lock=JSON.parse(read('package-lock.json'));
const script=read('extension/content-script.js');
const readme=read('README.md');
const packager=read('scripts/package-store.mts');
assert.equal(pkg.version,manifest.version,'manifest and package use the same release version');
assert.equal(lock.version,manifest.version);
assert.equal(lock.packages[''].version,manifest.version);
assert.equal(/const SCRIPT_VERSION = '([^']+)'/.exec(script)?.[1],manifest.version,
  'a bumped extension must replace its old injected content script');
assert.ok(readme.includes('Version **'+manifest.version+'**'),'README release version must agree');
assert.deepEqual([...manifest.permissions].sort(),
  ['notifications','offscreen','scripting','storage','unlimitedStorage','webRequest'].sort(),
  'keep the reviewed minimal Chrome Web Store permissions');
assert.deepEqual(manifest.host_permissions,['https://chatgpt.com/*']);
for(const dependency of ['goal-lineage.js','goal-request-proof.js','reply-probe.js']) {
  assert.ok(packager.includes("'"+dependency+"'"),'Store ZIP must include '+dependency);
  assert.ok(read('extension/service-worker.js').includes("importScripts('"+dependency+"')"));
}
console.log('Integrated extension version, permissions and runtime packaging constraints passed.');
