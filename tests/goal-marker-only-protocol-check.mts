import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const policy=require('../extension/goal-policy.js');
const record={goal:'Finish the synthetic fixture',rules:'Verify the fixture',continuations:1,maxContinuations:10,
 supplements:[{userText:'Also check the second fixture'}]};
for(const text of [policy.initialText(record),policy.continuationText(record),policy.handoffText(record)]) {
 assert.match(text,/ответь ровно одной строкой GOAL_COMPLETE без точки в конце/);
 assert.match(text,/Всё сообщение должно состоять только из этой строки/);
 assert.match(text,/без Markdown, кавычек, пояснений, итогов и любого другого текста/);
 assert.match(text,/Не обсуждай сигнал завершения/);
 assert.match(text,/Ожидание само по себе не является блокировкой/);
 assert.match(text,/очередь CI, ожидание runner/);
 assert.match(text,/Дождись результата штатным механизмом, затем проверь результат и продолжай работу end-to-end/);
 assert.match(text,/а простое ожидание результата не поможет/);
 assert.match(text,/какое именно действие пользователя необходимо/);
 assert.match(text,/Не выдавай GOAL_BLOCKED, если хоть один из этих пунктов не установлен/);
 assert.match(text,/Ошибка проверки, уязвимая или неподтверждённая зависимость/);
 assert.match(text,/продолжай другие независимые части цели/);
 assert.match(text,/отсутствие функции в одном инструменте само по себе не доказывает блокировку/);
 assert.match(text,/Не выдумывай доступные инструменты и не обходи запреты или права доступа/);
 assert.match(text,/Не считай старое сообщение о блокировке или частичный результат доказательством/);
 assert.match(text,/Соблюдай заданные лимиты цели и ручную остановку пользователя/);
 assert.doesNotMatch(text,/Итог:|первым абзацем|1–3 коротких пункта/);
 assert.equal(text.match(/GOAL_COMPLETE/g)?.length,1,'completion protocol states the token once, without instructions to discuss it');
}
const active={deadlineAt:2000,continuations:0,maxContinuations:10};
assert.equal(policy.decision(active,'GOAL_COMPLETE',true,true,1000),'complete');
for(const text of ['Маркер `GOAL_COMPLETE` не выдаю.','Маркер GOAL_COMPLETE не выдаю.',
 'GOAL_COMPLETE не выдаю.','GOAL_COMPLETE\nDone','GOAL_COMPLETE\n\nИтог:\n- Done',
 '> GOAL_COMPLETE','`GOAL_COMPLETE`','**GOAL_COMPLETE**','"GOAL_COMPLETE"']) {
 assert.equal(policy.decision(active,text,true,true,1000),'continue','only the exact message is a policy completion');
}
assert.equal(policy.decision(active,'GOAL_COMPLETE',false,true,1000),'continue');
assert.equal(policy.decision(active,'GOAL_COMPLETE',true,false,1000),'unverified');
console.log('Goal marker-only instructions: initial/continue/handoff, no withheld-marker chatter, quoted/negated mentions and exact stop passed.');
