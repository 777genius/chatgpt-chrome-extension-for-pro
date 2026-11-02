'use strict';

// HTTP/SSE closure is not answer completion. Callers bind a prompt to the
// current attempt before supplying it here; observing an old answer is unsafe.
function bindAttemptPrompt(attempt, snapshot) {
  if (!attempt || !snapshot || !attempt.id || typeof attempt.baselineKey !== 'string' ||
      attempt.url !== snapshot.url || attempt.id !== snapshot.attemptId ||
      !snapshot.promptKey || snapshot.promptKey === attempt.baselineKey) return null;
  if (attempt.promptKey && attempt.promptKey !== snapshot.promptKey) return null;
  return {...attempt,promptKey:snapshot.promptKey};
}

function completedAttemptEvidence(attempt, snapshot) {
  if (!attempt || !snapshot || !attempt.id || !attempt.promptKey ||
      attempt.url !== snapshot.url || attempt.id !== snapshot.attemptId ||
      attempt.promptKey !== snapshot.promptKey || snapshot.isLatest !== true ||
      snapshot.isReadOnly !== false || snapshot.generating !== false ||
      snapshot.hasError !== false || snapshot.turnStatus !== 'complete' ||
      !snapshot.assistantKey || snapshot.assistantCompleted !== true ||
      snapshot.assistantPhase !== 'final_answer') return null;
  return {attemptId:attempt.id,promptKey:attempt.promptKey,assistantKey:snapshot.assistantKey};
}

if (typeof module !== 'undefined') module.exports = { completedAttemptEvidence, bindAttemptPrompt };
