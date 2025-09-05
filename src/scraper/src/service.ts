import { 
  createQueueConnection, 
  createQueueFactory, 
  createDatabasePool,
  DatabasePool,
  QueueConnection,
  QueueFactory,
  QueueMonitor,
  JobTypes,
  ScrapeReviewsJob,
  Logger,
  Job,
} from '@review-scraper/shared';
import { BullMQScraperWorker } from './queue-worker.js';

/**
 * Scraper service that manages the queue-based scraping system
 * Handles worker lifecycle, job creation, and monitoring
 */
export class ScraperService {
  private connection!: QueueConnection;
  private factory!: QueueFactory;
  private monitor!: QueueMonitor;
  private queueWorker!: BullMQScraperWorker;
  private logger: Logger;
  private isRunning = false;

  constructor() {
    this.logger = new Logger('ScraperService');
  }

  /**
   * Initialize the scraper service with queue connections and workers
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing scraper service...');

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
      this.queueWorker = new BullMQScraperWorker();

      this.isRunning = true;
      this.logger.info('Scraper service initialized successfully');

    } catch (error) {
      this.logger.error('Failed to initialize scraper service:', error);
      throw error;
    }
  }

  /**
   * Get the BullMQ worker instance for advanced operations
   */
  getQueueWorker(): BullMQScraperWorker {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }
    return this.queueWorker;
  }

  /**
   * Add a scraping job to the queue
   */
  async queueScrapingJob(jobData: Omit<ScrapeReviewsJob, 'priority' | 'retryAttempts' | 'delay'>): Promise<string> {
    if (!this.isRunning) {
      throw new Error('Scraper service not initialized. Call initialize() first.');
    }

    const job = await this.factory.addJob(JobTypes.SCRAPE_REVIEWS, {
      ...jobData,
      priority: 5,
      retryAttempts: 3,
      delay: 0,
    });

    this.logger.info(`Queued scraping job ${job.id}`, {
      appId: jobData.appId,
      countries: jobData.countries,
      pages: jobData.pages,
    });

    return job.id?.toString() || '';
  }

  /**
   * Queue multiple scraping jobs for different apps
   */
  async queueMultipleScrapingJobs(
    appIds: string[],
    options: {
      countries?: string[];
      pages?: number;
      sortMethods?: ('recent' | 'helpful')[];
      throttleMs?: number;
    } = {}
  ): Promise<string[]> {
    const jobIds: string[] = [];
    
    const defaultOptions = {
      countries: ['us'],
      pages: 5,
      sortMethods: ['recent' as const],
      throttleMs: 500,
      ...options,
    };

    for (const appId of appIds) {
      try {
        const jobId = await this.queueScrapingJob({
          appId,
          countries: defaultOptions.countries,
          pages: defaultOptions.pages,
          sortMethods: defaultOptions.sortMethods,
          throttleMs: defaultOptions.throttleMs,
          correlationId: `batch-${Date.now()}-${appId}`,
        });
        
        jobIds.push(jobId);
        this.logger.info(`Queued scraping job for app ${appId}: ${jobId}`);
      } catch (error) {
        this.logger.error(`Failed to queue scraping job for app ${appId}:`, error);
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
      // Get health status from monitor
      const monitorHealth = await this.monitor.getHealthStatus();
      
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'scraper',
        worker: await this.queueWorker.getStatus(),
        workerHealth: await this.queueWorker.healthCheck(),
        connections: this.connection.getStats(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        status: 'error',
        error: errorMessage,
        timestamp: new Date().toISOString(),
        service: 'scraper',
      };
    }
  }

  /**
   * Get queue statistics for scraping jobs
   */
  async getQueueStats(): Promise<any> {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }

    try {
      const stats = await this.factory.getQueueStats(JobTypes.SCRAPE_REVIEWS);
      const details = await this.monitor.getQueueDetails(JobTypes.SCRAPE_REVIEWS);
      
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
   * Pause the scraping queue (stop processing new jobs)
   */
  async pauseQueue(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }

    await this.factory.pauseQueue(JobTypes.SCRAPE_REVIEWS);
    this.logger.info('Scraping queue paused');
  }

  /**
   * Resume the scraping queue
   */
  async resumeQueue(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }

    await this.factory.resumeQueue(JobTypes.SCRAPE_REVIEWS);
    this.logger.info('Scraping queue resumed');
  }

  /**
   * Clean old completed/failed jobs from the queue
   */
  async cleanQueue(olderThanHours: number = 24): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service not initialized');
    }

    const olderThanMs = olderThanHours * 60 * 60 * 1000;
    await this.factory.cleanQueue(JobTypes.SCRAPE_REVIEWS, olderThanMs);
    this.logger.info(`Cleaned old jobs from scraping queue (older than ${olderThanHours}h)`);
  }

  /**
   * Gracefully shutdown the service
   */
  async shutdown(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Shutting down scraper service...');

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
      this.logger.info('Scraper service shut down successfully');
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