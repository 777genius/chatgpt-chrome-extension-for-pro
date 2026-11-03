import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

type Settings={goal:string;rules:string;maxContinuations:number;maxMinutes:number};
type RecordValue=Settings & {continuations:number;deadlineAt:number};
type Policy={
  canonical(v:string):string;
  settings(input:unknown):Settings;
  initialText(record:Settings):string;
  continuationText(record:Settings):string;
  handoffText(record:RecordValue):string;
  exactMarker(value:string,raw:boolean,native:boolean):boolean;
  decision(record:RecordValue,value:string,raw:boolean,native:boolean,time:number):string;
};

function policy(directory:"extension"|"dist/extension"):Policy{
  const src=readFileSync(new URL("../"+directory+"/goal-policy.js",import.meta.url),"utf8");
  const context=createContext({URL,module:{exports:{}}});
  runInContext(src,context);
  const value:unknown=runInContext("module.exports",context);
  assert.ok(value && typeof value==="object");
  return value as Policy;
}
function observe(api:Policy):unknown[]{
  const cases:unknown[]=[];
  const config=api.settings({goal:" Complete task ",rules:" Without regressions ",maxContinuations:12,maxMinutes:20});
  cases.push(config,api.canonical("https://chatgpt.com/c/example?x=1"));
  const record:RecordValue={...config,continuations:0,deadlineAt:1000};
  cases.push(api.initialText(config),api.continuationText(config),api.handoffText(record));
  for(const response of ["GOAL_COMPLETE","GOAL_COMPLETE\n"," GOAL_COMPLETE","not complete"]){
    for(const raw of [true,false]){
      for(const native of [true,false]){
        cases.push([response,raw,native,api.exactMarker(response,raw,native),
          api.decision(record,response,raw,native,900)]);
      }
    }
  }
  cases.push(api.decision({...record,continuations:12},"not complete",true,true,900));
  cases.push(api.decision(record,"not complete",true,true,1000));
  for(const input of [
    {goal:"",maxContinuations:1,maxMinutes:1},
    {goal:"ok",maxContinuations:0,maxMinutes:1},
    {goal:"ok",maxContinuations:1,maxMinutes:1441},
    null,
  ]){
    try{api.settings(input);cases.push("unexpected success");}
    catch(error){cases.push(error instanceof Error?error.message:String(error));}
  }
  return JSON.parse(JSON.stringify(cases)) as unknown[];
}
test("Goal marker policy preserves exact baseline and fail-closed input admission",()=>{
  const baseline=observe(policy("extension"));
  const compiled=observe(policy("dist/extension"));
  assert.deepEqual(compiled,baseline);
  const api=policy("dist/extension");
  assert.equal(api.exactMarker("GOAL_COMPLETE",true,true),true);
  assert.equal(api.exactMarker("GOAL_COMPLETE\n",true,true),false);
  assert.equal(api.exactMarker("GOAL_COMPLETE",false,true),false);
  assert.equal(api.decision({...api.settings({goal:"safe",rules:"",maxContinuations:5,maxMinutes:5}),continuations:0,deadlineAt:1000},"continue",true,false,500),"unverified");
});
