import { 
  createQueueConnection, 
  createQueueFactory, 
  createDatabasePool,
  DatabasePool,
  QueueConnection,
  QueueFactory,
  QueueMonitor,
  JobTypes,
  LabelReviewsJob,
  Logger,
} from '@review-scraper/shared';
import { BullMQLabelerWorker } from './queue-worker.js';

/**
 * Labeler service that manages the queue-based sentiment analysis system
 * Handles worker lifecycle, job creation, and monitoring
 */
export class LabelerService {
  private connection!: QueueConnection;
  private factory!: QueueFactory;
  private monitor!: QueueMonitor;
  private queueWorker!: BullMQLabelerWorker;
  private logger: Logger;
  private isRunning = false;

  constructor() {
    this.logger = new Logger('LabelerService');
  }

  /**
   * Initialize the labeler service with queue connections and workers
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing labeler service...');

      // Check for required environment variables
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is required');
      }

      // Initialize database connection
      const dbPool = await DatabasePool.getInstance();

      // Initialize queue connection
      this.connection = createQueueConnection();
      await this.connection.connect();

      // Initialize queue factory
      this.factory = createQueueFactory(this.connection);

      // Initialize queue monitor
      this.monitor = new QueueMonitor(this.factory, this.connection);

      // Initialize BullMQ worker
      this.queueWorker = new BullMQLabelerWorker();

      this.isRunning = true;
      this.logger.info('Labeler service initialized successfully');

    } catch (error) {
      this.logger.error('Failed to initialize labeler service:', error);
      throw error;
    }
  }

  /**
   * Add a labeling job to the queue
   */
  async queueLabelingJob(jobData: Omit<LabelReviewsJob, 'priority' | 'retryAttempts' | 'delay'>): Promise<string> {
    if (!this.isRunning) {
      throw new Error('Labeler service not initialized. Call initialize() first.');
    }

    const job = await this.factory.addJob(JobTypes.LABEL_REVIEWS, {
      ...jobData,
      priority: 5,
      retryAttempts: 2, // Fewer retries for labeling jobs due to API costs
      delay: 0,
    });

    this.logger.info(`Queued labeling job ${job.id}`, {
      reviewCount: jobData.reviewIds.length,
      batchSize: jobData.batchSize,
      model: jobData.model,
      correlationId: jobData.correlationId,
    });

    return job.id?.toString() || '';
  }

  /**
   * Queue multiple labeling jobs for different batches of reviews
   */
  async queueMultipleLabelingJobs(
    reviewIds: string[],
    options: {
      batchSize?: number;
      model?: string;
      correlationId?: string;
    } = {}
  ): Promise<string[]> {
    const jobIds: string[] = [];
    const batchSize = options.batchSize || 20;
    
    // Split reviews into batches
    for (let i = 0; i < reviewIds.length; i += batchSize) {
      const batch = reviewIds.slice(i, i + batchSize);
      
      try {
        const jobId = await this.queueLabelingJob({
          reviewIds: batch,
          batchSize,
          model: options.model || 'gpt-4o-mini',
          correlationId: options.correlationId || `batch-${Date.now()}-${i}`,
        });
        
        jobIds.push(jobId);
        this.logger.info(`Queued labeling job for batch ${Math.floor(i / batchSize) + 1}: ${jobId}`);
      } catch (error) {
        this.logger.error(`Failed to queue labeling job for batch starting at ${i}:`, error);
      }
    }

    return jobIds;
  }

  /**
   * Get service health status including queue metrics
   */
  async getHealthStatus(): Promise<any> {
    if (!this.isRunning) {
      return {
        status: 'not_initialized',
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const workerHealth = await this.queueWorker.healthCheck();
      
      return {
        status: workerHealth.status,
        timestamp: new Date().toISOString(),
        service: 'labeler',
        worker: await this.queueWorker.getStatus(),
        workerHealth: workerHealth,
        connections: this.connection.getStats(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        status: 'error',
        error: errorMessage,
        timestamp: new Date().toISOString(),
        service: 'labeler',
      };
    }
  }

  /**
   * Get queue statistics for labeling jobs
   */
  async getQueueStats(): Promise<any> {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }

    try {
      const stats = await this.factory.getQueueStats(JobTypes.LABEL_REVIEWS);
      const details = await this.monitor.getQueueDetails(JobTypes.LABEL_REVIEWS);
      
      return {
        ...stats,
        ...details,
      };
    } catch (error) {
      this.logger.error('Failed to get queue stats:', error);
      throw error;
    }
  }

  /**
   * Pause the labeling queue (stop processing new jobs)
   */
  async pauseQueue(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }

    await this.factory.pauseQueue(JobTypes.LABEL_REVIEWS);
    this.logger.info('Labeling queue paused');
  }

  /**
   * Resume the labeling queue
   */
  async resumeQueue(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }

    await this.factory.resumeQueue(JobTypes.LABEL_REVIEWS);
    this.logger.info('Labeling queue resumed');
  }

  /**
   * Clean old completed/failed jobs from the queue
   */
  async cleanQueue(olderThanHours: number = 24): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }

    const olderThanMs = olderThanHours * 60 * 60 * 1000;
    await this.factory.cleanQueue(JobTypes.LABEL_REVIEWS, olderThanMs);
    this.logger.info(`Cleaned old jobs from labeling queue (older than ${olderThanHours}h)`);
  }

  /**
   * Get the BullMQ worker instance for advanced operations
   */
  getQueueWorker(): BullMQLabelerWorker {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }
    return this.queueWorker;
  }

  /**
   * Gracefully shutdown the service
   */
  async shutdown(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Shutting down labeler service...');

    try {
      // Shutdown BullMQ worker first
      if (this.queueWorker) {
        await this.queueWorker.shutdown();
      }

      // Close factory (workers and queues)
      if (this.factory) {
        await this.factory.close();
      }

      // Close connection
      if (this.connection) {
        await this.connection.close();
      }

      this.isRunning = false;
      this.logger.info('Labeler service shut down successfully');
    } catch (error) {
      this.logger.error('Error during shutdown:', error);
      throw error;
    }
  }

  /**
   * Check if service is running
   */
  get running(): boolean {
    return this.isRunning;
  }
}