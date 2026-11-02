import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const tests=readdirSync(new URL('../tests/',import.meta.url)).filter(name=>name.endsWith('.ts')).sort();
for(const test of tests){
  console.log(`\n${test}`);
  const result=spawnSync(process.execPath,[`tests/${test}`],{cwd:root,stdio:'inherit',timeout:120000});
  if(result.error){console.error(result.error.message);process.exit(1);}
  if(result.status!==0)process.exit(result.status||1);
}
console.log(`\nPassed ${tests.length} test programs.`);
