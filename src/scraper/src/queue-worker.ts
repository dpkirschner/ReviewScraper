import { Worker, Job } from 'bullmq';
import { 
  getQueueConnection, 
  JobTypes, 
  ScrapeReviewsJob, 
  JobResult,
  Logger 
} from '@review-scraper/shared';
import { ScraperWorker } from './worker.js';

/**
 * BullMQ worker wrapper that processes SCRAPE_REVIEWS jobs
 * Connects the existing ScraperWorker logic to the queue system
 */
export class BullMQScraperWorker {
  private worker: Worker;
  private scraperWorker: ScraperWorker;
  private logger: Logger;
  private isShuttingDown = false;

  constructor() {
    this.logger = new Logger('BullMQScraperWorker');
    this.scraperWorker = new ScraperWorker();
    
    this.logger.info('Initializing BullMQ scraper worker...');
    
    this.worker = new Worker(
      JobTypes.SCRAPE_REVIEWS,
      this.processJob.bind(this),
      {
        connection: getQueueConnection().connectionConfig.connection,
        concurrency: ScraperWorker.getWorkerConfig().concurrency,
        limiter: ScraperWorker.getWorkerConfig().limiter,
        removeOnComplete: { count: 50 }, // Keep last 50 completed jobs
        removeOnFail: { count: 100 },    // Keep last 100 failed jobs
      }
    );

    this.setupEventHandlers();
  }

  /**
   * Process a single scraping job
   * This is the bridge between BullMQ and our existing ScraperWorker
   */
  private async processJob(job: Job<ScrapeReviewsJob>): Promise<JobResult> {
    if (this.isShuttingDown) {
      throw new Error('Worker is shutting down, cannot process new jobs');
    }

    this.logger.info(`Processing scraping job ${job.id}`, {
      appId: job.data.appId,
      countries: job.data.countries,
      correlationId: job.data.correlationId,
    });

    try {
      // Use existing ScraperWorker logic
      const result = await this.scraperWorker.processScrapingJob(job);
      
      this.logger.info(`Completed scraping job ${job.id}`, {
        success: result.success,
        itemsProcessed: result.itemsProcessed,
        processingTime: result.processingTime,
      });

      return result;
    } catch (error) {
      this.logger.error(`Failed to process scraping job ${job.id}:`, error);
      
      // Return structured error result
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        data: { appId: job.data.appId },
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
      this.logger.info('BullMQ scraper worker is ready to process jobs');
    });

    this.worker.on('error', (error: Error) => {
      this.logger.error('BullMQ scraper worker error:', error);
    });

    this.worker.on('failed', (job: Job | undefined, error: Error) => {
      this.logger.error(`Job ${job?.id || 'unknown'} failed:`, error);
    });

    this.worker.on('completed', (job: Job, result: JobResult) => {
      this.logger.info(`Job ${job.id} completed successfully`, {
        itemsProcessed: result.itemsProcessed,
        processingTime: result.processingTime,
      });
    });

    this.worker.on('stalled', (jobId: string) => {
      this.logger.warn(`Job ${jobId} stalled`);
    });

    this.worker.on('progress', (job: Job, progress: any) => {
      this.logger.debug(`Job ${job.id} progress: ${progress}`);
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
    const processed = 0; // Metrics API changed in BullMQ
    const failed = 0;
    const active = 0;

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
    };
  }> {
    try {
      const workerRunning = this.worker.isRunning();
      const connectionHealth = await getQueueConnection().health();
      const connectionHealthy = connectionHealth.status === 'healthy';

      if (!workerRunning) {
        return {
          status: 'unhealthy',
          message: 'Worker is not running',
          details: { workerRunning, connectionHealthy },
        };
      }

      if (!connectionHealthy) {
        return {
          status: 'degraded',
          message: 'Queue connection is degraded',
          details: { workerRunning, connectionHealthy },
        };
      }

      return {
        status: 'healthy',
        details: { workerRunning, connectionHealthy },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        details: { workerRunning: false, connectionHealthy: false },
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
    this.logger.info('Initiating graceful shutdown of BullMQ scraper worker...');

    try {
      // Close the worker gracefully
      await this.worker.close();
      this.logger.info('BullMQ scraper worker shutdown completed');
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