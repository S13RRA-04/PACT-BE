import type { AppConfig } from "../config/config.js";
import type { PactContent, PactUser } from "../domain/types.js";
import { isAppError } from "../errors/AppError.js";
import type { LmsAgsClient } from "../integrations/lmsAgsClient.js";
import type { PactRepository } from "../repositories/pactRepository.js";

export type AgsRetryJob = {
  config: AppConfig;
  repository: PactRepository;
  ags: LmsAgsClient;
  user: PactUser;
  content: PactContent;
  score: number;
  maxScore: number;
  progressPercent: number;
  accessToken: string;
  retryCount: number;
};

const scheduled = new Set<string>();

export function scheduleAgsRetry(job: AgsRetryJob) {
  if (!job.config.agsAutoRetryEnabled || job.config.agsAutoRetryMaxAttempts <= 0) return;
  if (job.retryCount >= job.config.agsAutoRetryMaxAttempts) return;

  const key = `${job.user.id}:${job.content.id}:${job.score}:${job.maxScore}:${job.progressPercent}:${job.retryCount + 1}`;
  if (scheduled.has(key)) return;
  scheduled.add(key);

  const delayMs = retryDelayMs(job.config, job.retryCount + 1);
  setTimeout(() => {
    scheduled.delete(key);
    void runRetry({ ...job, retryCount: job.retryCount + 1 });
  }, delayMs).unref?.();
}

async function runRetry(job: AgsRetryJob) {
  try {
    const agsStatus = await job.ags.publishScore({
      lineItemUrl: job.content.lineItemUrl,
      accessToken: job.accessToken,
      userId: job.user.lmsUserId,
      score: job.score,
      maxScore: job.maxScore,
      activityProgress: job.progressPercent >= 100 ? "Completed" : "InProgress",
      gradingProgress: "FullyGraded"
    });
    await job.repository.recordAgsPublishAttempt({
      courseId: job.user.courseId,
      cohortId: job.user.cohortId,
      squadId: job.user.squadId,
      userId: job.user.id,
      contentId: job.content.id,
      lineItemUrl: job.content.lineItemUrl,
      score: job.score,
      maxScore: job.maxScore,
      progressPercent: job.progressPercent,
      status: agsStatus,
      retryCount: job.retryCount
    });
    await job.repository.upsertScore({
      user: job.user,
      contentId: job.content.id,
      contentType: job.content.type,
      score: job.score,
      maxScore: job.maxScore,
      progressPercent: job.progressPercent,
      agsStatus
    });
  } catch (error) {
    const nextRetryCount = job.retryCount;
    await job.repository.recordAgsPublishAttempt({
      courseId: job.user.courseId,
      cohortId: job.user.cohortId,
      squadId: job.user.squadId,
      userId: job.user.id,
      contentId: job.content.id,
      lineItemUrl: job.content.lineItemUrl,
      score: job.score,
      maxScore: job.maxScore,
      progressPercent: job.progressPercent,
      status: "failed",
      retryCount: nextRetryCount,
      nextRetryAt: nextRetryCount < job.config.agsAutoRetryMaxAttempts
        ? new Date(Date.now() + retryDelayMs(job.config, nextRetryCount + 1)).toISOString()
        : undefined,
      errorCode: isAppError(error) ? error.code : undefined,
      errorMessage: isAppError(error) ? error.message : undefined
    });
    scheduleAgsRetry(job);
  }
}

function retryDelayMs(config: AppConfig, attemptNumber: number) {
  const delay = config.agsAutoRetryInitialDelayMs * (2 ** Math.max(0, attemptNumber - 1));
  return Math.min(delay, config.agsAutoRetryMaxDelayMs);
}
