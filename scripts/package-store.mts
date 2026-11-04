// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic, dependency-free ZIP. Only this reviewed runtime allowlist ships.
import {readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const runtimeFiles=[
  'chat-title-probe.js','completion-checkpoint.js','completion-probe.js','completion-state.js',
  'content-script.js','deferred-task-status.js','goal-inline.js','goal-policy.js','goal-store.js',
  'handoff-renamer.js','handoff-title.js','journal-store.js','journal.html','journal.js',
  'legacy-handoff-status.js','manifest.json','memory-maintenance.js','offscreen.html','offscreen.js',
  'page-probe.js','popup.html','popup.js','request-receipts.js','service-worker.js',
  'status-animation.js','status-indicator.js','status-store.js','watcher-bootstrap.js',
  'icons/icon16.png','icons/icon48.png','icons/icon128.png',
  'icons/status-error.png','icons/status-error.svg','icons/status-success.png','icons/status-success.svg'
];
type Manifest={manifest_version:number;name:string;version:string;description:string;minimum_chrome_version:string;
  permissions:string[];host_permissions:string[];background:{service_worker:string};
  content_scripts:{matches:string[];js:string[]}[];icons:Record<string,string>;action:{default_popup:string}};
const manifest=JSON.parse(readFileSync(resolve(root,'extension/manifest.json'),'utf8')) as Manifest;
const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')) as {version:string};
function requireValid(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(message);}
requireValid(manifest.manifest_version===3,'Store package must use Manifest V3');
requireValid(typeof manifest.name==='string'&&manifest.name.length>0&&manifest.name.length<=75,'Manifest name must have 1-75 characters');
requireValid(typeof manifest.description==='string'&&manifest.description.length>0&&manifest.description.length<=132,'Manifest description must have 1-132 characters');
requireValid(/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(manifest.version)&&manifest.version.split('.').every(n=>Number(n)<=65535)&&manifest.version.split('.').some(n=>Number(n)>0),'Invalid Chrome version');
requireValid(manifest.version===pkg.version,'Package/manifest versions differ');
requireValid(Number(manifest.minimum_chrome_version)>=116,'Offscreen runtime requires Chrome 116+');
const permissions=['notifications','storage','offscreen','scripting','webRequest','unlimitedStorage'];
requireValid(JSON.stringify([...manifest.permissions].sort())===JSON.stringify(permissions.sort()),'Permissions changed: update the privacy audit before packaging');
requireValid(JSON.stringify(manifest.host_permissions)===JSON.stringify(['https://chatgpt.com/*']),'Host access changed: update the privacy audit');
for(const script of manifest.content_scripts)requireValid(JSON.stringify(script.matches)===JSON.stringify(['https://chatgpt.com/*']),'Unexpected content-script host');
const entries=new Map<string,Buffer>();
const extensionRoot=realpathSync(resolve(root,'extension'));
for(const file of runtimeFiles){
  const path=resolve(root,'extension',file);
  requireValid(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink(),`Not a regular runtime file: ${file}`);
  requireValid(realpathSync(path).startsWith(extensionRoot+sep),`Runtime file resolves outside extension/: ${file}`);
  entries.set(file,readFileSync(path));
}
for(const file of ['LICENSE','NOTICE.md'])entries.set(file,readFileSync(resolve(root,file)));
function resource(file:string){requireValid(entries.has(file),`Missing packaged resource: ${file}`);}
for(const file of [manifest.background.service_worker,manifest.action.default_popup,...Object.values(manifest.icons),...manifest.content_scripts.flatMap(s=>s.js)])resource(file);
for(const [name,data] of entries){
  if(name.endsWith('.html'))for(const match of data.toString().matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g))resource(match[1]!);
  if(name.endsWith('.js'))for(const match of data.toString().matchAll(/importScripts\(['"]([^'"]+)['"]\)/g))resource(match[1]!);
  requireValid(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-proj-[A-Za-z0-9_-]{20,}\b/.test(data.toString()),`Possible secret in ${name}`);
}
// ZIP method 0 avoids compressor-version variation. Fixed 1980-01-01 metadata.
function crc32(data:Buffer):number {
  let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
const bodies:Buffer[]=[],directory:Buffer[]=[];
let offset=0;
for(const [name,data] of [...entries].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const filename=Buffer.from(name),crc=crc32(data),local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
  bodies.push(local,filename,data);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);
  central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
  directory.push(central,filename);offset+=local.length+filename.length+data.length;
}
const central=Buffer.concat(directory),end=Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.size,8);end.writeUInt16LE(entries.size,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...bodies,central,end]);
const args=process.argv.slice(2);
requireValid(args.length===0||(args.length===2&&args[0]==='--out'),'Usage: npm run package:store -- [--out /path/package.zip]');
const output=resolve(args[1]||resolve(root,'work',`chatgpt-completion-alert-${manifest.version}.zip`));
requireValid(output.endsWith('.zip'),'Output must end in .zip');
requireValid(!output.startsWith(resolve(root,'extension')+sep),'Output must be outside extension/');
requireValid(realpathSync(execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'}).trim())===realpathSync(root),'Packaging requires the extension repository Git checkout');
const dirtyPaths=execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{cwd:root,encoding:'utf8'}).trimEnd().split('\n').filter(Boolean);
const source={gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirtyPaths,
  status:dirtyPaths.length?'Preparatory package; Git HEAD alone does not identify dirty runtime bytes. Rebuild after the final commit.':'Clean source checkout; runtime bytes packaged from the recorded Git HEAD.'};
const receipt={source,version:manifest.version,files:entries.size,bytes:zip.length,sha256:createHash('sha256').update(zip).digest('hex'),
  entries:[...entries.keys()].sort(),note:'Static package validation only; Chrome Web Store review and live ChatGPT behavior are separate.'};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,zip);
writeFileSync(output+'.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({output,...receipt},null,2));
