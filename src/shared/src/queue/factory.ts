import { Queue, Worker, Job } from 'bullmq';
import { QueueConnection } from './connection.js';
import { JobTypes, JobType, JobPayload, JobResult, validateJobPayload } from './types.js';
import { Logger } from '../utils/index.js';

/**
 * Queue factory that manages queue instances and workers
 */
export class QueueFactory {
  private queues = new Map<JobType, Queue>();
  private workers = new Map<JobType, Worker>();
  private connection: QueueConnection;
  private logger: Logger;

  constructor(connection: QueueConnection) {
    this.connection = connection;
    this.logger = new Logger('QueueFactory');
  }

  /**
   * Get or create a queue for a specific job type
   */
  async getQueue(jobType: JobType): Promise<Queue> {
    if (this.queues.has(jobType)) {
      return this.queues.get(jobType)!;
    }

    const redis = await this.connection.getConnection();
    const config = this.connection.connectionConfig;

    const queue = new Queue(jobType, {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: config.defaultJobOptions.removeOnComplete,
        removeOnFail: config.defaultJobOptions.removeOnFail,
        attempts: config.defaultJobOptions.attempts,
        backoff: {
          type: config.defaultJobOptions.backoff.type,
          delay: config.defaultJobOptions.backoff.delay,
        },
      },
    });

    // Set up queue event handlers
    queue.on('error', (error: Error) => {
      this.logger.error(`Queue ${jobType} error:`, error);
    });

    queue.on('waiting', (job: { id: string }) => {
      this.logger.debug(`Job ${job.id} is waiting in queue ${jobType}`);
    });

    queue.on('active', (job: { id: string; processedOn?: number }) => {
      this.logger.info(`Job ${job.id} started processing in queue ${jobType}`);
    });

    queue.on('completed', (job: { id: string; processedOn?: number }) => {
      this.logger.info(`Job ${job.id} completed in queue ${jobType}`, {
        processingTime: Date.now() - (job.processedOn || Date.now()),
      });
    });

    queue.on('failed', (job: { id: string } | undefined, error: Error) => {
      this.logger.error(`Job ${job?.id} failed in queue ${jobType}:`, error);
    });

    queue.on('stalled', (job: { id: string }) => {
      this.logger.warn(`Job ${job.id} stalled in queue ${jobType}`);
    });

    this.queues.set(jobType, queue);
    this.logger.info(`Created queue for job type: ${jobType}`);
    
    return queue;
  }

  /**
   * Add a job to the appropriate queue
   */
  async addJob<T extends JobType>(
    jobType: T,
    data: JobPayload,
    options: {
      priority?: number;
      delay?: number;
      attempts?: number;
      jobId?: string;
    } = {}
  ): Promise<Job<JobPayload>> {
    // Validate the job payload
    const validatedData = validateJobPayload(jobType, data);
    
    const queue = await this.getQueue(jobType);
    
    const jobOptions = {
      priority: options.priority || validatedData.priority || 5,
      delay: options.delay || validatedData.delay || 0,
      attempts: options.attempts || validatedData.retryAttempts || 3,
      ...(options.jobId && { jobId: options.jobId }),
    };

    this.logger.info(`Adding job to queue ${jobType}`, {
      jobId: jobOptions.jobId,
      priority: jobOptions.priority,
      delay: jobOptions.delay,
    });

    const job = await queue.add(jobType, validatedData, jobOptions);
    
    return job;
  }

  /**
   * Create a worker for a specific job type
   */
  async createWorker<T extends JobType>(
    jobType: T,
    processor: (job: Job<JobPayload>) => Promise<JobResult>,
    options: {
      concurrency?: number;
      limiter?: {
        max: number;
        duration: number;
      };
    } = {}
  ): Promise<Worker> {
    if (this.workers.has(jobType)) {
      throw new Error(`Worker for job type ${jobType} already exists`);
    }

    const redis = await this.connection.getConnection();
    
    const worker = new Worker(jobType, processor, {
      connection: redis,
      concurrency: options.concurrency || 1,
      ...(options.limiter && { limiter: options.limiter }),
    });

    // Set up worker event handlers
    worker.on('error', (error) => {
      this.logger.error(`Worker ${jobType} error:`, error);
    });

    worker.on('active', (job) => {
      this.logger.info(`Worker ${jobType} started processing job ${job.id}`);
    });

    worker.on('completed', (job, result) => {
      this.logger.info(`Worker ${jobType} completed job ${job.id}`, {
        success: result.success,
        processingTime: result.processingTime,
        itemsProcessed: result.itemsProcessed,
      });
    });

    worker.on('failed', (job: Job | undefined, error: Error) => {
      this.logger.error(`Worker ${jobType} failed processing job ${job?.id}:`, error);
    });

    worker.on('stalled', (job: { id: string }) => {
      this.logger.warn(`Worker ${jobType} job ${job.id} stalled`);
    });

    this.workers.set(jobType, worker);
    this.logger.info(`Created worker for job type: ${jobType}`, {
      concurrency: options.concurrency || 1,
      limiter: options.limiter,
    });
    
    return worker;
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(jobType: JobType): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: boolean;
  }> {
    const queue = await this.getQueue(jobType);
    
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed(),
      queue.getDelayed(),
    ]);

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
      paused: await queue.isPaused(),
    };
  }

  /**
   * Get all queue statistics
   */
  async getAllQueueStats(): Promise<Record<JobType, {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: boolean;
  }>> {
    const stats: any = {};
    
    for (const jobType of Object.values(JobTypes)) {
      try {
        stats[jobType] = await this.getQueueStats(jobType);
      } catch (error) {
        this.logger.error(`Failed to get stats for queue ${jobType}:`, error);
        stats[jobType] = {
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: false,
        };
      }
    }
    
    return stats;
  }

  /**
   * Pause a queue
   */
  async pauseQueue(jobType: JobType): Promise<void> {
    const queue = await this.getQueue(jobType);
    await queue.pause();
    this.logger.info(`Paused queue: ${jobType}`);
  }

  /**
   * Resume a queue
   */
  async resumeQueue(jobType: JobType): Promise<void> {
    const queue = await this.getQueue(jobType);
    await queue.resume();
    this.logger.info(`Resumed queue: ${jobType}`);
  }

  /**
   * Clean completed/failed jobs from a queue
   */
  async cleanQueue(
    jobType: JobType,
    grace: number = 24 * 60 * 60 * 1000, // 24 hours
    limit: number = 100
  ): Promise<void> {
    const queue = await this.getQueue(jobType);
    
    const [cleanedCompleted, cleanedFailed] = await Promise.all([
      queue.clean(grace, limit, 'completed'),
      queue.clean(grace, limit, 'failed'),
    ]);

    this.logger.info(`Cleaned queue ${jobType}`, {
      completedCleaned: cleanedCompleted,
      failedCleaned: cleanedFailed,
    });
  }

  /**
   * Close all queues and workers
   */
  async close(): Promise<void> {
    this.logger.info('Closing all queues and workers');

    // Close all workers first
    const workerClosePromises = Array.from(this.workers.values()).map(worker => 
      worker.close()
    );
    
    await Promise.allSettled(workerClosePromises);
    this.workers.clear();

    // Then close all queues
    const queueClosePromises = Array.from(this.queues.values()).map(queue => 
      queue.close()
    );
    
    await Promise.allSettled(queueClosePromises);
    this.queues.clear();

    this.logger.info('All queues and workers closed');
  }

  /**
   * Health check for the queue factory
   */
  async health(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    queues: Record<string, boolean>;
    connection: any;
  }> {
    const connectionHealth = await this.connection.health();
    const queueStatus: Record<string, boolean> = {};

    // Check each active queue
    for (const [jobType, queue] of Array.from(this.queues.entries())) {
      try {
        await queue.getWaiting();
        queueStatus[jobType] = true;
      } catch (error) {
        queueStatus[jobType] = false;
        this.logger.error(`Health check failed for queue ${jobType}:`, error);
      }
    }

    const allQueuesHealthy = Object.values(queueStatus).every(status => status);
    const status = connectionHealth.status === 'healthy' && allQueuesHealthy 
      ? 'healthy' 
      : connectionHealth.status === 'unhealthy' || !allQueuesHealthy
      ? 'unhealthy'
      : 'degraded';

    return {
      status,
      queues: queueStatus,
      connection: connectionHealth,
    };
  }
}

// Global factory instance
let globalFactory: QueueFactory | null = null;

/**
 * Create the global queue factory instance
 */
export function createQueueFactory(connection: QueueConnection): QueueFactory {
  if (globalFactory) {
    throw new Error('Queue factory already exists. Use getQueueFactory() to get the existing instance.');
  }
  
  globalFactory = new QueueFactory(connection);
  return globalFactory;
}

/**
 * Get the global queue factory instance
 */
export function getQueueFactory(): QueueFactory {
  if (!globalFactory) {
    throw new Error('Queue factory not initialized. Call createQueueFactory() first.');
  }
  
  return globalFactory;
}

/**
 * Close and cleanup the global queue factory
 */
export async function closeQueueFactory(): Promise<void> {
  if (globalFactory) {
    await globalFactory.close();
    globalFactory = null;
  }
}