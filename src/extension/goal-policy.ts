"use strict";

interface GoalSettingsInput {
  goal?: unknown; rules?: unknown; maxContinuations?: unknown; maxMinutes?: unknown;
}
interface GoalSettings {
  goal: string; rules: string; maxContinuations: number; maxMinutes: number;
}
interface GoalPolicyRecord extends GoalSettings { deadlineAt: number; continuations: number }
type GoalDecision = "unverified" | "complete" | "deadline" | "budget" | "continue";
interface GoalPolicyAPI {
  MARKER: string; CONTINUATION: string;
  DEFAULTS:{maxContinuations:number;maxMinutes:number};
  pageUrl(value:string|null|undefined):string;
  composerSettings(input?:GoalSettingsInput):Pick<GoalSettings,"rules"|"maxContinuations"|"maxMinutes">;
  canonical(value: string): string;
  settings(input: GoalSettingsInput | null | undefined): GoalSettings;
  initialText(record: GoalSettings): string;
  continuationText(record: GoalSettings): string;
  handoffText(record: GoalPolicyRecord): string;
  exactMarker(response: string, rawExact: boolean, nativeVerified: boolean): boolean;
  decision(record: GoalPolicyRecord,response: string,rawExact: boolean,nativeVerified: boolean,time: number): GoalDecision;
}
declare const module: undefined | { exports: unknown };

// Pure Goal rules. The model's marker is an assertion, not evidence of CI or merge.
(function(root: typeof globalThis & {ChatGPTGoalPolicy?:GoalPolicyAPI}) {
  const MARKER='GOAL_COMPLETE';
  const CONTINUATION='Продолжай выполнение исходной цели до полного результата. Проверь всё end-to-end, включая необходимые pull requests, merge и успешные проверки, если это входит в цель. Если работа ещё не завершена, продолжай её и не выдавай маркер. Только когда вся цель и условия остановки выполнены, ответь одним сообщением ровно GOAL_COMPLETE, без Markdown, пояснений и других символов.';
  function canonical(value: string): string {
    try {
      const url=new URL(value);
      return url.origin==='https://chatgpt.com'&&/^\/c\/[a-z0-9-]+\/?$/.test(url.pathname)
        ?url.origin+url.pathname.replace(/\/$/,''):'';
    } catch {return '';}
  }
  const DEFAULTS=Object.freeze({maxContinuations:10,maxMinutes:1440});
  function pageUrl(value:string|null|undefined):string {
    if(typeof value!=='string')return '';
    try {const url=new URL(value);return url.origin==='https://chatgpt.com'&&url.pathname==='/'?url.origin+'/':canonical(value);}catch{return '';}
  }
  function composerSettings(input:GoalSettingsInput={}):Pick<GoalSettings,"rules"|"maxContinuations"|"maxMinutes"> {
    const {rules,maxContinuations,maxMinutes}=settings({...DEFAULTS,...Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined)),goal:'Native message'});
    return {rules,maxContinuations,maxMinutes};
  }
  function settings(input: GoalSettingsInput | null | undefined): GoalSettings {
    const goal=typeof input?.goal==='string'?input.goal.trim():'';
    const rules=typeof input?.rules==='string'?input.rules.trim():'';
    const maxContinuations=Number(input?.maxContinuations);
    const maxMinutes=Number(input?.maxMinutes);
    if(!goal||goal.length>10000||rules.length>5000)throw Error('Введите цель (до 10000 символов) и правила (до 5000)');
    if(!Number.isInteger(maxContinuations)||maxContinuations<1||maxContinuations>100)throw Error('Лимит продолжений: 1–100');
    if(!Number.isInteger(maxMinutes)||maxMinutes<1||maxMinutes>1440)throw Error('Лимит времени: 1–1440 минут');
    return {goal,rules,maxContinuations,maxMinutes};
  }
  function initialText(record: GoalSettings): string {
    return ['Цель (автономное выполнение):',record.goal,
      ...(record.rules?['Условия завершения:',record.rules]:[]),
      'Продолжай работу end-to-end. Успешные проверки, публикация и merge должны действительно состояться, если это требуется целью.',
      'Если цель полностью выполнена, ответь ровно GOAL_COMPLETE — это должен быть весь окончательный ответ, без оформления и дополнительного текста.',
      'Если цель не завершена, не используй GOAL_COMPLETE. Работай дальше, прямо указывай блокировки и реальные результаты.'].join('\n\n');
  }
  function continuationText(record: GoalSettings): string {
    return [CONTINUATION,'Исходная цель:',record.goal,
      ...(record.rules?['Условия завершения:',record.rules]:[])].join('\n\n');
  }
  function handoffText(record: GoalPolicyRecord): string {
    return ['--- Активная цель расширения (не отчёт о выполнении) ---',
      record.goal,...(record.rules?[record.rules]:[]),
      'Продолжений подтверждено: '+record.continuations+' из '+record.maxContinuations+'.',
      'Не считай перенос чата выполнением цели. '+CONTINUATION].join('\n\n');
  }
  function exactMarker(response: string,rawExact: boolean,nativeVerified: boolean): boolean {
    return nativeVerified===true&&rawExact===true&&response===MARKER;
  }
  function decision(record: GoalPolicyRecord,response: string,rawExact: boolean,nativeVerified: boolean,time: number): GoalDecision {
    if(nativeVerified!==true)return 'unverified';
    if(exactMarker(response,rawExact,nativeVerified))return 'complete';
    if(time>=record.deadlineAt)return 'deadline';
    if(record.continuations>=record.maxContinuations)return 'budget';
    return 'continue';
  }
  const api: GoalPolicyAPI=Object.freeze({MARKER,CONTINUATION,DEFAULTS,canonical,pageUrl,composerSettings,settings,initialText,continuationText,handoffText,exactMarker,decision});
  root.ChatGPTGoalPolicy=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
