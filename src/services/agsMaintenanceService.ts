import type { AppConfig } from "../config/config.js";
import type { AppLogger } from "../logging/logger.js";
import type { PactRepository } from "../repositories/pactRepository.js";
import type { PactService } from "./pactService.js";

export class AgsMaintenanceService {
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: PactRepository,
    private readonly pactService: PactService,
    private readonly logger: AppLogger
  ) {}

  start() {
    void this.cleanupOldAttempts();
    void this.retryDueAgsAttempts();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupOldAttempts();
      void this.retryDueAgsAttempts();
    }, this.config.agsRetentionCleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async cleanupOldAttempts() {
    const cutoff = new Date(Date.now() - this.config.agsAttemptRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const deletedCount = await this.repository.deleteAgsPublishAttemptsBefore(cutoff);
    if (deletedCount > 0) {
      this.logger.info({ deletedCount, cutoff }, "Cleaned up old AGS publish attempts");
    }
    return deletedCount;
  }

  async retryDueAgsAttempts() {
    if (!this.config.agsAutoRetryEnabled || this.config.agsAutoRetryMaxAttempts <= 0) {
      await this.deliverDueNotifications();
      return { scanned: 0, retried: 0, failed: 0, exhausted: 0 };
    }
    const result = await this.pactService.retryDueAgsPublishAttempts();
    if (result.exhausted > 0) {
      this.logger.warn(result, "AGS retries exhausted max attempts");
      await this.enqueueRetryExhaustedNotifications(result);
    }
    await this.deliverDueNotifications();
    if (result.scanned > 0) {
      this.logger.info(result, "Processed due AGS retry attempts");
    }
    return result;
  }

  async deliverDueNotifications() {
    if (!this.config.agsRetryExhaustedWebhookUrls.length) return { scanned: 0, delivered: 0, failed: 0, deadLettered: 0 };
    const due = await this.repository.listDueNotifications({ nowIso: new Date().toISOString(), limit: 25 });
    let delivered = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const notification of due) {
      try {
        const response = await fetch(notification.sinkUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.agsRetryExhaustedWebhookBearerToken ? { authorization: `Bearer ${this.config.agsRetryExhaustedWebhookBearerToken}` } : {})
          },
          body: JSON.stringify(notification.payload)
        });
        if (response.ok) {
          await this.repository.markNotificationDelivered(notification.id);
          delivered += 1;
          continue;
        }
        const deadLetter = notification.attemptCount + 1 >= this.config.agsRetryExhaustedWebhookMaxAttempts;
        await this.repository.markNotificationFailed({
          id: notification.id,
          attemptCount: notification.attemptCount + 1,
          nextAttemptAt: deadLetter ? undefined : nextNotificationAttemptAt(this.config, notification.attemptCount + 1),
          deadLetter,
          status: response.status
        });
        failed += 1;
        if (deadLetter) deadLettered += 1;
        this.logger.warn({ url: notification.sinkUrl, status: response.status, deadLetter }, "AGS retry exhausted notification sink failed");
      } catch (error) {
        const deadLetter = notification.attemptCount + 1 >= this.config.agsRetryExhaustedWebhookMaxAttempts;
        await this.repository.markNotificationFailed({
          id: notification.id,
          attemptCount: notification.attemptCount + 1,
          nextAttemptAt: deadLetter ? undefined : nextNotificationAttemptAt(this.config, notification.attemptCount + 1),
          deadLetter,
          error: error instanceof Error ? error.message : "Notification sink request failed"
        });
        failed += 1;
        if (deadLetter) deadLettered += 1;
        this.logger.warn({ url: notification.sinkUrl, error, deadLetter }, "AGS retry exhausted notification sink failed");
      }
    }

    if (due.length > 0) {
      this.logger.info({ scanned: due.length, delivered, failed, deadLettered }, "Processed AGS exhausted retry notifications");
    }
    return { scanned: due.length, delivered, failed, deadLettered };
  }

  private async enqueueRetryExhaustedNotifications(result: { scanned: number; retried: number; failed: number; exhausted: number }) {
    if (!this.config.agsRetryExhaustedWebhookUrls.length) return;
    const payload = {
      event: "ags.retry_exhausted",
      exhausted: result.exhausted,
      failed: result.failed,
      scanned: result.scanned,
      retried: result.retried,
      occurredAt: new Date().toISOString()
    };

    await Promise.all(this.config.agsRetryExhaustedWebhookUrls.map((url) => this.repository.enqueueNotification({
      event: "ags.retry_exhausted",
      sinkUrl: url,
      payload
    })));
  }
}

function nextNotificationAttemptAt(config: AppConfig, attemptCount: number) {
  const delay = Math.min(
    config.agsRetryExhaustedWebhookMaxDelayMs,
    config.agsRetryExhaustedWebhookInitialDelayMs * (2 ** Math.max(0, attemptCount - 1))
  );
  return new Date(Date.now() + delay).toISOString();
}
