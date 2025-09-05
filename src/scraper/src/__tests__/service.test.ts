import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScraperService } from '../service.js';
import { JobTypes, ScrapeReviewsJob } from '@review-scraper/shared';

// Mock all dependencies
vi.mock('@review-scraper/shared', async () => {
  const actual = await vi.importActual('@review-scraper/shared');
  return {
    ...actual,
    createQueueConnection: vi.fn(),
    createQueueFactory: vi.fn(),
    createDatabasePool: vi.fn(),
    getQueueConnection: vi.fn(),
    getDatabasePool: vi.fn(),
    DatabasePool: {
      getInstance: vi.fn(),
    },
    QueueMonitor: vi.fn(),
    Logger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

vi.mock('./worker.js', () => ({
  ScraperWorker: vi.fn(() => ({
    processScrapingJob: vi.fn(),
  })),
}));

vi.mock('./queue-worker.js', () => ({
  BullMQScraperWorker: vi.fn(() => ({
    processScrapingJob: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({ isRunning: true, running: true }),
    healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('ScraperService', () => {
  let service: ScraperService;
  let mockConnection: any;
  let mockFactory: any;
  let mockDbPool: any;
  let mockMonitor: any;
  let mockWorker: any;
  let shared: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import and setup mocks
    shared = await import('@review-scraper/shared');
    const { BullMQScraperWorker } = await import('./queue-worker.js');

    mockConnection = {
      connect: vi.fn(),
      close: vi.fn(),
      getStats: vi.fn().mockResolvedValue({ connected: true, host: 'localhost' }),
      health: vi.fn().mockResolvedValue({ status: 'healthy' }),
      connectionConfig: {
        connection: { host: 'localhost', port: 6379 }
      }
    };

    mockFactory = {
      addJob: vi.fn(),
      getQueueStats: vi.fn(),
      pauseQueue: vi.fn(),
      resumeQueue: vi.fn(),
      cleanQueue: vi.fn(),
      close: vi.fn(),
    };

    mockDbPool = {
      initialize: vi.fn(),
    };

    mockMonitor = {
      getHealthStatus: vi.fn(),
      getQueueDetails: vi.fn(),
    };

    mockWorker = {
      processScrapingJob: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({ isRunning: true, running: true }),
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    (shared.createQueueConnection as any).mockReturnValue(mockConnection);
    (shared.createQueueFactory as any).mockReturnValue(mockFactory);
    (shared.createDatabasePool as any).mockReturnValue(mockDbPool);
    (shared.getQueueConnection as any).mockReturnValue(mockConnection);
    (shared.getDatabasePool as any).mockReturnValue(mockDbPool);
    (shared.DatabasePool.getInstance as any).mockResolvedValue(mockDbPool);
    (shared.QueueMonitor as any).mockReturnValue(mockMonitor);
    (BullMQScraperWorker as any).mockReturnValue(mockWorker);

    service = new ScraperService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize all components successfully', async () => {
      mockConnection.connect.mockResolvedValue(undefined);

      await service.initialize();

      expect(shared.DatabasePool.getInstance).toHaveBeenCalledOnce();
      expect(mockConnection.connect).toHaveBeenCalledOnce();
      expect(service.running).toBe(true);
    });

    it('should handle initialization errors', async () => {
      (shared.DatabasePool.getInstance as any).mockRejectedValue(new Error('Database connection failed'));

      await expect(service.initialize()).rejects.toThrow('Database connection failed');
      expect(service.running).toBe(false);
    });

    it('should handle queue connection errors', async () => {
      (shared.DatabasePool.getInstance as any).mockResolvedValue(mockDbPool);
      mockConnection.connect.mockRejectedValue(new Error('Redis connection failed'));

      await expect(service.initialize()).rejects.toThrow('Redis connection failed');
    });
  });

  describe('queueScrapingJob', () => {
    beforeEach(async () => {
      await initializeService();
    });

    it('should queue a scraping job successfully', async () => {
      const mockJob = { id: 'job-123' };
      mockFactory.addJob.mockResolvedValue(mockJob);

      const jobData = {
        appId: '12345',
        countries: ['us', 'gb'],
        pages: 5,
        sortMethods: ['recent' as const],
        throttleMs: 500,
        correlationId: 'test-correlation',
      };

      const jobId = await service.queueScrapingJob(jobData);

      expect(jobId).toBe('job-123');
      expect(mockFactory.addJob).toHaveBeenCalledWith(JobTypes.SCRAPE_REVIEWS, {
        ...jobData,
        priority: 5,
        retryAttempts: 3,
        delay: 0,
      });
    });

    it('should apply default priority when not specified', async () => {
      const mockJob = { id: 'job-456' };
      mockFactory.addJob.mockResolvedValue(mockJob);

      const jobData = {
        appId: '12345',
        countries: ['us'],
        pages: 3,
        sortMethods: ['recent' as const],
        throttleMs: 1000,
      };

      await service.queueScrapingJob(jobData);

      expect(mockFactory.addJob).toHaveBeenCalledWith(JobTypes.SCRAPE_REVIEWS, {
        ...jobData,
        priority: 5,
        retryAttempts: 3,
        delay: 0,
      });
    });

    it('should throw error when service not initialized', async () => {
      const uninitializedService = new ScraperService();
      
      await expect(
        uninitializedService.queueScrapingJob({
          appId: '12345',
          countries: ['us'],
          pages: 5,
          sortMethods: ['recent'],
        })
      ).rejects.toThrow('Scraper service not initialized. Call initialize() first.');
    });
  });

  describe('queueMultipleScrapingJobs', () => {
    beforeEach(async () => {
      await initializeService();
    });

    it('should queue multiple jobs with default options', async () => {
      mockFactory.addJob
        .mockResolvedValueOnce({ id: 'job-1' })
        .mockResolvedValueOnce({ id: 'job-2' });

      const appIds = ['app1', 'app2'];
      const jobIds = await service.queueMultipleScrapingJobs(appIds);

      expect(jobIds).toEqual(['job-1', 'job-2']);
      expect(mockFactory.addJob).toHaveBeenCalledTimes(2);
      
      // Verify default options applied
      expect(mockFactory.addJob).toHaveBeenCalledWith(JobTypes.SCRAPE_REVIEWS, 
        expect.objectContaining({
          countries: ['us'],
          pages: 5,
          sortMethods: ['recent'],
          throttleMs: 500,
        })
      );
    });

    it('should queue multiple jobs with custom options', async () => {
      mockFactory.addJob
        .mockResolvedValueOnce({ id: 'job-1' })
        .mockResolvedValueOnce({ id: 'job-2' });

      const appIds = ['app1', 'app2'];
      const options = {
        countries: ['us', 'gb', 'ca'],
        pages: 3,
        sortMethods: ['recent' as const, 'helpful' as const],
        throttleMs: 1000,
      };

      const jobIds = await service.queueMultipleScrapingJobs(appIds, options);

      expect(jobIds).toEqual(['job-1', 'job-2']);
      expect(mockFactory.addJob).toHaveBeenCalledWith(JobTypes.SCRAPE_REVIEWS, 
        expect.objectContaining(options)
      );
    });

    it('should handle individual job failures gracefully', async () => {
      mockFactory.addJob
        .mockResolvedValueOnce({ id: 'job-1' })
        .mockRejectedValueOnce(new Error('Job creation failed'));

      const appIds = ['app1', 'app2'];
      const jobIds = await service.queueMultipleScrapingJobs(appIds);

      // Should return IDs for successful jobs only
      expect(jobIds).toEqual(['job-1']);
      expect(mockFactory.addJob).toHaveBeenCalledTimes(2);
    });
  });

  describe('getHealthStatus', () => {
    it('should return not_initialized when service not running', async () => {
      const status = await service.getHealthStatus();

      expect(status.status).toBe('not_initialized');
      expect(status.timestamp).toBeDefined();
    });

    it('should return health status when service is running', async () => {
      await initializeService();
      
      const mockHealth = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        connections: { redis: 'connected' },
      };
      
      mockMonitor.getHealthStatus.mockResolvedValue(mockHealth);

      const status = await service.getHealthStatus();

      expect(status.status).toBe('healthy');
      expect(status.service).toBe('scraper');
      expect(status.worker.isRunning).toBe(true);
      expect(status.connections).toBeDefined();
    });

    it('should handle monitor errors gracefully', async () => {
      await initializeService();
      
      mockMonitor.getHealthStatus.mockRejectedValue(new Error('Monitor failed'));

      const status = await service.getHealthStatus();

      expect(status.status).toBe('error');
      expect(status.error).toBe('Monitor failed');
    });
  });

  describe('getQueueStats', () => {
    beforeEach(async () => {
      await initializeService();
    });

    it('should return queue statistics', async () => {
      const mockStats = {
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
      };

      const mockDetails = {
        recentJobs: [{ id: 'job-1', status: 'completed' }],
        deadLetterQueue: { count: 1 },
      };

      mockFactory.getQueueStats.mockResolvedValue(mockStats);
      mockMonitor.getQueueDetails.mockResolvedValue(mockDetails);

      const stats = await service.getQueueStats();

      expect(stats.waiting).toBe(5);
      expect(stats.active).toBe(2);
      expect(stats.recentJobs).toBeDefined();
      expect(stats.deadLetterQueue).toBeDefined();

      expect(mockFactory.getQueueStats).toHaveBeenCalledWith(JobTypes.SCRAPE_REVIEWS);
      expect(mockMonitor.getQueueDetails).toHaveBeenCalledWith(JobTypes.SCRAPE_REVIEWS);
    });

    it('should throw error when service not initialized', async () => {
      const uninitializedService = new ScraperService();
      
      await expect(uninitializedService.getQueueStats()).rejects.toThrow('Service not initialized');
    });
  });

  describe('queue management', () => {
    beforeEach(async () => {
      await initializeService();
    });

    it('should pause queue successfully', async () => {
      mockFactory.pauseQueue.mockResolvedValue(undefined);

      await service.pauseQueue();

      expect(mockFactory.pauseQueue).toHaveBeenCalledWith(JobTypes.SCRAPE_REVIEWS);
    });

    it('should resume queue successfully', async () => {
      mockFactory.resumeQueue.mockResolvedValue(undefined);

      await service.resumeQueue();

      expect(mockFactory.resumeQueue).toHaveBeenCalledWith(JobTypes.SCRAPE_REVIEWS);
    });

    it('should clean queue with default age', async () => {
      mockFactory.cleanQueue.mockResolvedValue(undefined);

      await service.cleanQueue();

      expect(mockFactory.cleanQueue).toHaveBeenCalledWith(
        JobTypes.SCRAPE_REVIEWS,
        24 * 60 * 60 * 1000 // 24 hours in ms
      );
    });

    it('should clean queue with custom age', async () => {
      mockFactory.cleanQueue.mockResolvedValue(undefined);

      await service.cleanQueue(48);

      expect(mockFactory.cleanQueue).toHaveBeenCalledWith(
        JobTypes.SCRAPE_REVIEWS,
        48 * 60 * 60 * 1000 // 48 hours in ms
      );
    });
  });

  describe('shutdown', () => {
    it('should shutdown successfully when running', async () => {
      await initializeService();
      
      mockFactory.close.mockResolvedValue(undefined);
      mockConnection.close.mockResolvedValue(undefined);

      await service.shutdown();

      expect(mockFactory.close).toHaveBeenCalledOnce();
      expect(mockConnection.close).toHaveBeenCalledOnce();
      expect(service.running).toBe(false);
    });

    it('should do nothing when not running', async () => {
      await service.shutdown();

      expect(mockFactory.close).not.toHaveBeenCalled();
      expect(mockConnection.close).not.toHaveBeenCalled();
    });

    it('should handle shutdown errors', async () => {
      await initializeService();
      
      mockFactory.close.mockRejectedValue(new Error('Factory close failed'));

      await expect(service.shutdown()).rejects.toThrow('Factory close failed');
    });
  });

  describe('running property', () => {
    it('should return false initially', () => {
      expect(service.running).toBe(false);
    });

    it('should return true after initialization', async () => {
      await initializeService();
      expect(service.running).toBe(true);
    });

    it('should return false after shutdown', async () => {
      await initializeService();
      await service.shutdown();
      expect(service.running).toBe(false);
    });
  });

  // Helper function to initialize service with mocked dependencies
  async function initializeService() {
    mockConnection.connect.mockResolvedValue(undefined);
    await service.initialize();
  }
});