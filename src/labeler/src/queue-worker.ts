import { Worker, Job } from 'bullmq';
import { 
  getQueueConnection, 
  JobTypes, 
  LabelReviewsJob, 
  JobResult,
  Logger 
} from '@review-scraper/shared';
import { LabelerWorker } from './worker.js';

/**
 * BullMQ worker wrapper that processes LABEL_REVIEWS jobs
 * Connects the existing LabelerWorker logic to the queue system
 */
export class BullMQLabelerWorker {
  private worker: Worker;
  private labelerWorker: LabelerWorker;
  private logger: Logger;
  private isShuttingDown = false;

  constructor() {
    this.logger = new Logger('BullMQLabelerWorker');
    this.labelerWorker = new LabelerWorker();
    
    this.logger.info('Initializing BullMQ labeler worker...');
    
    this.worker = new Worker(
      JobTypes.LABEL_REVIEWS,
      this.processJob.bind(this),
      {
        connection: getQueueConnection().connectionConfig.connection,
        concurrency: LabelerWorker.getWorkerConfig().concurrency,
        limiter: LabelerWorker.getWorkerConfig().limiter,
        removeOnComplete: 50, // Keep last 50 completed jobs
        removeOnFail: 100,    // Keep last 100 failed jobs
      }
    );

    this.setupEventHandlers();
  }

  /**
   * Process a single labeling job
   * This is the bridge between BullMQ and our LabelerWorker
   */
  private async processJob(job: Job<LabelReviewsJob>): Promise<JobResult> {
    if (this.isShuttingDown) {
      throw new Error('Worker is shutting down, cannot process new jobs');
    }

    this.logger.info(`Processing labeling job ${job.id}`, {
      reviewCount: job.data.reviewIds.length,
      batchSize: job.data.batchSize,
      model: job.data.model,
      correlationId: job.data.correlationId,
    });

    try {
      // Use existing LabelerWorker logic
      const result = await this.labelerWorker.processLabelingJob(job);
      
      this.logger.info(`Completed labeling job ${job.id}`, {
        success: result.success,
        itemsProcessed: result.itemsProcessed,
        processingTime: result.processingTime,
      });

      return result;
    } catch (error) {
      this.logger.error(`Failed to process labeling job ${job.id}:`, error);
      
      // Return structured error result
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        data: { reviewIds: job.data.reviewIds.slice(0, 5) }, // First 5 IDs for debugging
        processingTime: 0,
        itemsProcessed: 0,
      };
    }
  }

  /**
   * Set up event handlers for monitoring and logging
   */
  private setupEventHandlers(): void {
    this.worker.on('ready', () => {
      this.logger.info('BullMQ labeler worker is ready to process jobs');
    });

    this.worker.on('error', (error: Error) => {
      this.logger.error('BullMQ labeler worker error:', error);
    });

    this.worker.on('failed', (job: Job | undefined, error: Error) => {
      this.logger.error(`Job ${job?.id || 'unknown'} failed:`, error);
    });

    this.worker.on('completed', (job: Job, result: JobResult) => {
      this.logger.info(`Job ${job.id} completed successfully`, {
        itemsProcessed: result.itemsProcessed,
        processingTime: result.processingTime,
        averageConfidence: result.data?.averageConfidence,
      });
    });

    this.worker.on('stalled', (jobId: string) => {
      this.logger.warn(`Job ${jobId} stalled`);
    });

    this.worker.on('progress', (job: Job, progress: number) => {
      this.logger.debug(`Job ${job.id} progress: ${progress}%`);
    });
  }

  /**
   * Get worker status and statistics
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    isShuttingDown: boolean;
    concurrency: number;
    processed: number;
    failed: number;
    active: number;
  }> {
    const processed = this.worker.opts.metrics?.completed || 0;
    const failed = this.worker.opts.metrics?.failed || 0;
    const active = this.worker.opts.metrics?.active || 0;

    return {
      isRunning: this.worker.isRunning(),
      isShuttingDown: this.isShuttingDown,
      concurrency: this.worker.opts.concurrency || 1,
      processed,
      failed,
      active,
    };
  }

  /**
   * Health check for the worker
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    message?: string;
    details: {
      workerRunning: boolean;
      connectionHealthy: boolean;
      openaiConfigured: boolean;
    };
  }> {
    try {
      const workerRunning = this.worker.isRunning();
      const connectionHealth = await getQueueConnection().health();
      const connectionHealthy = connectionHealth.status === 'healthy';
      const openaiConfigured = !!process.env.OPENAI_API_KEY;

      if (!workerRunning) {
        return {
          status: 'unhealthy',
          message: 'Worker is not running',
          details: { workerRunning, connectionHealthy, openaiConfigured },
        };
      }

      if (!openaiConfigured) {
        return {
          status: 'unhealthy',
          message: 'OpenAI API key not configured',
          details: { workerRunning, connectionHealthy, openaiConfigured },
        };
      }

      if (!connectionHealthy) {
        return {
          status: 'degraded',
          message: 'Queue connection is degraded',
          details: { workerRunning, connectionHealthy, openaiConfigured },
        };
      }

      return {
        status: 'healthy',
        details: { workerRunning, connectionHealthy, openaiConfigured },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: { workerRunning: false, connectionHealthy: false, openaiConfigured: false },
      };
    }
  }

  /**
   * Gracefully shutdown the worker
   * Waits for active jobs to complete before closing
   */
  async shutdown(timeoutMs: number = 30000): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Worker is already shutting down');
      return;
    }

    this.isShuttingDown = true;
    this.logger.info('Initiating graceful shutdown of BullMQ labeler worker...');

    try {
      // Close the worker gracefully
      await this.worker.close();
      this.logger.info('BullMQ labeler worker shutdown completed');
    } catch (error) {
      this.logger.error('Error during worker shutdown:', error);
      throw error;
    }
  }

  /**
   * Get the underlying BullMQ Worker instance (for advanced operations)
   */
  getWorker(): Worker {
    return this.worker;
  }
}