"use strict";

// SSE completion alone is not evidence of a completed answer. This policy is
// intentionally independent of the DOM adapter and any send capability.
interface CompletionAttempt {
  id: string;
  url: string;
  baselineKey: string;
  promptKey?: string;
}
interface CompletionSnapshot {
  url: string;
  attemptId: string;
  promptKey: string;
  isLatest: boolean;
  isReadOnly: boolean;
  generating: boolean;
  hasError: boolean;
  turnStatus: string;
  assistantKey: string;
  assistantCompleted: boolean;
  assistantPhase: string;
}
interface CompletionEvidence {
  attemptId: string;
  promptKey: string;
  assistantKey: string;
}

function bindAttemptPrompt(
  attempt: CompletionAttempt | null | undefined,
  snapshot: CompletionSnapshot | null | undefined,
): CompletionAttempt | null {
  if (!attempt || !snapshot || !attempt.id || typeof attempt.baselineKey !== "string" ||
      attempt.url !== snapshot.url || attempt.id !== snapshot.attemptId ||
      !snapshot.promptKey || snapshot.promptKey === attempt.baselineKey) return null;
  if (attempt.promptKey && attempt.promptKey !== snapshot.promptKey) return null;
  return { ...attempt, promptKey: snapshot.promptKey };
}

function completedAttemptEvidence(
  attempt: CompletionAttempt | null | undefined,
  snapshot: CompletionSnapshot | null | undefined,
): CompletionEvidence | null {
  if (!attempt || !snapshot || !attempt.id || !attempt.promptKey ||
      attempt.url !== snapshot.url || attempt.id !== snapshot.attemptId ||
      attempt.promptKey !== snapshot.promptKey || snapshot.isLatest !== true ||
      snapshot.isReadOnly !== false || snapshot.generating !== false ||
      snapshot.hasError !== false || snapshot.turnStatus !== "complete" ||
      !snapshot.assistantKey || snapshot.assistantCompleted !== true ||
      snapshot.assistantPhase !== "final_answer") return null;
  return { attemptId: attempt.id, promptKey: snapshot.promptKey, assistantKey: snapshot.assistantKey };
}

// Historical mock tests import the standalone classic script as CommonJS.
if (typeof module !== "undefined") module.exports = { completedAttemptEvidence, bindAttemptPrompt };
