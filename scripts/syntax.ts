import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../extension/',import.meta.url)).filter(name=>name.endsWith('.js'));
for(const file of files){
  const result=spawnSync(process.execPath,['--check',`extension/${file}`],{cwd:root,stdio:'inherit'});
  if(result.error||result.status!==0)process.exit(1);
}
const manifest=JSON.parse(readFileSync(new URL('../extension/manifest.json',import.meta.url),'utf8')) as {
  version:string;background:{service_worker:string};content_scripts:{js:string[]}[];icons:Record<string,string>;
};
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string};
if(manifest.version!==pkg.version)throw new Error('Package/extension version mismatch');
for(const file of [manifest.background.service_worker,...manifest.content_scripts.flatMap(value=>value.js),...Object.values(manifest.icons)]){
  if(!existsSync(new URL(`../extension/${file}`,import.meta.url)))throw new Error(`Missing manifest resource: ${file}`);
}
console.log(`Syntax and manifest resources OK (${files.length} scripts).`);
