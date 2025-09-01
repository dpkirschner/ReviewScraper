import { Queue, Job } from 'bullmq';
import { QueueFactory } from './factory.js';
import { JobType, JobTypes, JobResult } from './types.js';
import { Logger } from '../utils/index.js';

/**
 * Dead Letter Queue manager for handling permanently failed jobs
 * Provides inspection, retry, and cleanup capabilities for failed jobs
 */
export class DeadLetterQueueManager {
  private factory: QueueFactory;
  private logger: Logger;
  private readonly DLQ_SUFFIX = '_dlq';

  constructor(factory: QueueFactory) {
    this.factory = factory;
    this.logger = new Logger('DeadLetterQueueManager');
  }

  /**
   * Get the dead letter queue name for a job type
   */
  private getDLQName(jobType: JobType): string {
    return `${jobType}${this.DLQ_SUFFIX}`;
  }

  /**
   * Move a failed job to the dead letter queue
   */
  async moveToDeadLetter(jobType: JobType, job: Job, error: Error): Promise<void> {
    try {
      const dlqName = this.getDLQName(jobType);
      const dlq = await this.factory.getQueue(dlqName as JobType);

      const dlqJob = await dlq.add(`${jobType}_failed`, {
        originalJobData: job.data,
        originalJobId: job.id,
        originalJobType: jobType,
        failureReason: error.message,
        failureStack: error.stack,
        failedAt: new Date().toISOString(),
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
      }, {
        removeOnComplete: 1000, // Keep more DLQ records
        removeOnFail: 100,
      });

      this.logger.warn(`Moved job ${job.id} to dead letter queue`, {
        originalJobType: jobType,
        dlqJobId: dlqJob.id,
        error: error.message,
      });
    } catch (dlqError) {
      this.logger.error(`Failed to move job ${job.id} to dead letter queue:`, dlqError);
      throw dlqError;
    }
  }

  /**
   * Get all jobs in a dead letter queue
   */
  async getDeadLetterJobs(jobType: JobType, start = 0, end = 99): Promise<Job[]> {
    const dlqName = this.getDLQName(jobType);
    const dlq = await this.factory.getQueue(dlqName as JobType);
    
    const jobs = await dlq.getJobs(['completed', 'failed', 'active', 'waiting'], start, end);
    return jobs;
  }

  /**
   * Get dead letter queue statistics
   */
  async getDLQStats(jobType: JobType): Promise<{
    total: number;
    byFailureReason: Record<string, number>;
    oldestFailure: string | null;
    newestFailure: string | null;
  }> {
    const dlqJobs = await this.getDeadLetterJobs(jobType, 0, -1); // Get all jobs
    
    const byFailureReason: Record<string, number> = {};
    let oldestFailure: string | null = null;
    let newestFailure: string | null = null;

    for (const job of dlqJobs) {
      const reason = job.data.failureReason || 'Unknown';
      byFailureReason[reason] = (byFailureReason[reason] || 0) + 1;

      const failedAt = job.data.failedAt;
      if (!oldestFailure || (failedAt && failedAt < oldestFailure)) {
        oldestFailure = failedAt;
      }
      if (!newestFailure || (failedAt && failedAt > newestFailure)) {
        newestFailure = failedAt;
      }
    }

    return {
      total: dlqJobs.length,
      byFailureReason,
      oldestFailure,
      newestFailure,
    };
  }

  /**
   * Retry a job from the dead letter queue
   */
  async retryFromDeadLetter(
    jobType: JobType, 
    dlqJobId: string,
    options: {
      priority?: number;
      delay?: number;
    } = {}
  ): Promise<Job> {
    const dlqName = this.getDLQName(jobType);
    const dlq = await this.factory.getQueue(dlqName as JobType);
    
    const dlqJob = await dlq.getJob(dlqJobId);
    if (!dlqJob) {
      throw new Error(`Dead letter job ${dlqJobId} not found`);
    }

    const originalQueue = await this.factory.getQueue(jobType);
    const retriedJob = await originalQueue.add(
      jobType,
      dlqJob.data.originalJobData,
      {
        priority: options.priority || 5,
        delay: options.delay || 0,
        attempts: 3, // Reset attempts
        removeOnComplete: 50,
        removeOnFail: 50,
      }
    );

    // Remove the job from dead letter queue
    await dlqJob.remove();

    this.logger.info(`Retried job from dead letter queue`, {
      originalJobId: dlqJob.data.originalJobId,
      retriedJobId: retriedJob.id,
      jobType,
    });

    return retriedJob;
  }

  /**
   * Retry multiple jobs from dead letter queue with the same failure reason
   */
  async retryByFailureReason(
    jobType: JobType,
    failureReason: string,
    options: {
      priority?: number;
      delay?: number;
      maxJobs?: number;
    } = {}
  ): Promise<Job[]> {
    const dlqJobs = await this.getDeadLetterJobs(jobType, 0, -1);
    const matchingJobs = dlqJobs.filter(job => 
      job.data.failureReason === failureReason
    ).slice(0, options.maxJobs || 10);

    const retriedJobs: Job[] = [];
    
    for (const dlqJob of matchingJobs) {
      try {
        const retriedJob = await this.retryFromDeadLetter(
          jobType, 
          dlqJob.id!.toString(), 
          options
        );
        retriedJobs.push(retriedJob);
      } catch (error) {
        this.logger.error(`Failed to retry job ${dlqJob.id} from DLQ:`, error);
      }
    }

    this.logger.info(`Retried ${retriedJobs.length} jobs with failure reason "${failureReason}"`);
    return retriedJobs;
  }

  /**
   * Clean old jobs from dead letter queue
   */
  async cleanDeadLetterQueue(
    jobType: JobType,
    olderThanMs: number = 30 * 24 * 60 * 60 * 1000 // 30 days
  ): Promise<number> {
    const dlqName = this.getDLQName(jobType);
    const dlq = await this.factory.getQueue(dlqName as JobType);

    const cleanedCompleted = await dlq.clean(olderThanMs, 0, 'completed');
    const cleanedFailed = await dlq.clean(olderThanMs, 0, 'failed');
    
    const totalCleaned = (cleanedCompleted.length || 0) + (cleanedFailed.length || 0);

    this.logger.info(`Cleaned ${totalCleaned} old jobs from dead letter queue ${dlqName}`);
    
    return totalCleaned;
  }

  /**
   * Get all dead letter queue names
   */
  getAllDLQNames(): string[] {
    return Object.values(JobTypes).map(jobType => this.getDLQName(jobType));
  }

  /**
   * Get comprehensive dead letter queue overview
   */
  async getDLQOverview(): Promise<Record<string, {
    stats: Awaited<ReturnType<DeadLetterQueueManager['getDLQStats']>>;
    recentJobs: Array<{
      id: string;
      failureReason: string;
      failedAt: string;
      originalJobType: string;
    }>;
  }>> {
    const overview: Record<string, any> = {};

    for (const jobType of Object.values(JobTypes)) {
      try {
        const stats = await this.getDLQStats(jobType);
        const recentJobs = await this.getDeadLetterJobs(jobType, 0, 4); // Get 5 most recent
        
        overview[jobType] = {
          stats,
          recentJobs: recentJobs.map(job => ({
            id: job.id?.toString() || '',
            failureReason: job.data.failureReason || 'Unknown',
            failedAt: job.data.failedAt || '',
            originalJobType: job.data.originalJobType || '',
          })),
        };
      } catch (error) {
        this.logger.error(`Failed to get DLQ overview for ${jobType}:`, error);
        overview[jobType] = {
          stats: { total: 0, byFailureReason: {}, oldestFailure: null, newestFailure: null },
          recentJobs: [],
        };
      }
    }

    return overview;
  }

  /**
   * Setup automatic cleanup for all dead letter queues
   */
  setupAutomaticCleanup(intervalMs: number = 24 * 60 * 60 * 1000): void { // Daily by default
    setInterval(async () => {
      this.logger.info('Running automatic dead letter queue cleanup');
      
      for (const jobType of Object.values(JobTypes)) {
        try {
          await this.cleanDeadLetterQueue(jobType);
        } catch (error) {
          this.logger.error(`Automatic cleanup failed for DLQ ${jobType}:`, error);
        }
      }
    }, intervalMs);
    
    this.logger.info('Automatic dead letter queue cleanup scheduled', {
      intervalHours: intervalMs / (60 * 60 * 1000),
    });
  }
}