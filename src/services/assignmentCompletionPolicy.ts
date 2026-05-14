import type { PactQuestion, PactQuestionAttempt } from "../domain/types.js";

export type EffectiveQuestionAttempt = PactQuestionAttempt & {
  manualGraded?: boolean;
};

export type AssignmentCompletionEvaluation = {
  complete: boolean;
  status: "in_progress" | "pending_manual" | "failed_must_pass" | "complete";
  requiredQuestionIds: string[];
  answeredRequiredQuestionIds: string[];
  pendingQuestionIds: string[];
  pendingManualQuestionIds: string[];
  failedMustPassQuestionIds: string[];
  exhaustedQuestionIds: string[];
  score: number;
  maxScore: number;
};

export function assertQuestionAttemptAllowed(question: PactQuestion, existingAttemptCount: number) {
  const maxAttempts = question.scoring.maxAttempts;
  if (maxAttempts !== undefined && existingAttemptCount >= maxAttempts) {
    return {
      allowed: false,
      maxAttempts
    };
  }
  return {
    allowed: true,
    maxAttempts
  };
}

export function isManualQuestion(question: PactQuestion) {
  return question.scoring.gradingMode === "manual";
}

export function evaluateAssignmentCompletion(
  questions: PactQuestion[],
  latestAttempts: Map<string, EffectiveQuestionAttempt>
): AssignmentCompletionEvaluation {
  const requiredQuestions = questions.filter((question) => !question.scoring.optional);
  const requiredQuestionIds = requiredQuestions.map((question) => question.id);
  const answeredRequiredQuestionIds = requiredQuestionIds.filter((questionId) => latestAttempts.has(questionId));
  const pendingQuestionIds = requiredQuestionIds.filter((questionId) => !latestAttempts.has(questionId));
  const pendingManualQuestionIds = requiredQuestions
    .filter((question) => isManualQuestion(question) && latestAttempts.has(question.id) && !latestAttempts.get(question.id)?.manualGraded)
    .map((question) => question.id);
  const failedMustPassQuestionIds = requiredQuestions
    .filter((question) => question.scoring.mustPass && latestAttempts.has(question.id) && !latestAttempts.get(question.id)?.isCorrect)
    .map((question) => question.id);
  const exhaustedQuestionIds = requiredQuestions
    .filter((question) => {
      const maxAttempts = question.scoring.maxAttempts;
      const latestAttempt = latestAttempts.get(question.id);
      return maxAttempts !== undefined && latestAttempt !== undefined && latestAttempt.attemptNumber >= maxAttempts;
    })
    .map((question) => question.id);
  const score = requiredQuestionIds.reduce((total, questionId) => total + (latestAttempts.get(questionId)?.score ?? 0), 0);
  const maxScore = requiredQuestions.reduce((total, question) => total + question.scoring.points, 0);

  if (pendingQuestionIds.length) {
    return baseEvaluation("in_progress");
  }
  if (pendingManualQuestionIds.length) {
    return baseEvaluation("pending_manual");
  }
  if (failedMustPassQuestionIds.length) {
    return baseEvaluation("failed_must_pass");
  }
  return baseEvaluation("complete");

  function baseEvaluation(status: AssignmentCompletionEvaluation["status"]): AssignmentCompletionEvaluation {
    return {
      complete: status === "complete",
      status,
      requiredQuestionIds,
      answeredRequiredQuestionIds,
      pendingQuestionIds,
      pendingManualQuestionIds,
      failedMustPassQuestionIds,
      exhaustedQuestionIds,
      score,
      maxScore
    };
  }
}
