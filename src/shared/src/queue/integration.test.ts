import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueueConnection, QueueFactory, QueueMonitor, JobTypes } from './index.js';

// Mock BullMQ for integration testing
vi.mock('bullmq', () => {
  const queueInstances = new Map();
  
  const createMockJob = (data: any, id: string = Math.random().toString()) => ({
    id,
    data,
    progress: 0,
    timestamp: Date.now(),
    processedOn: Date.now() - 1000,
    finishedOn: Date.now() - 500,
    add: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    failedReason: undefined,
  });

  const createMockQueue = (queueName: string) => {
    const mockQueue = {
      name: queueName,
      add: vi.fn().mockImplementation((jobType: string, data: any) => {
        return Promise.resolve(createMockJob(data, `${queueName}-${Math.random()}`));
      }),
      getWaiting: vi.fn().mockResolvedValue([]),
      getActive: vi.fn().mockResolvedValue([]),
      getCompleted: vi.fn().mockResolvedValue([]),
      getFailed: vi.fn().mockResolvedValue([]),
      getDelayed: vi.fn().mockResolvedValue([]),
      getJobs: vi.fn().mockResolvedValue([]), // Added missing getJobs method
      isPaused: vi.fn().mockResolvedValue(false),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      clean: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      getJob: vi.fn().mockImplementation((jobId: string) => {
        return Promise.resolve(createMockJob({ id: jobId }, jobId));
      }),
    };
    return mockQueue;
  };

  const mockWorker = {
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    Queue: vi.fn().mockImplementation((queueName: string) => {
      // Return unique queue instance per name
      if (!queueInstances.has(queueName)) {
        queueInstances.set(queueName, createMockQueue(queueName));
      }
      return queueInstances.get(queueName);
    }),
    Worker: vi.fn(() => mockWorker),
    Job: createMockJob({ test: 'data' }),
  };
});

// Mock IORedis
vi.mock('ioredis', () => {
  const mockRedis = {
    status: 'ready',
    options: { host: 'localhost', port: 6379, db: 0 },
    on: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  };

  return {
    default: vi.fn(() => mockRedis),
  };
});

describe('Queue Infrastructure Integration', () => {
  let connection: QueueConnection;
  let factory: QueueFactory;
  let monitor: QueueMonitor;

  beforeEach(async () => {
    // Clean up any existing global instances
    try {
      const { closeQueueConnection } = await import('./connection.js');
      await closeQueueConnection();
    } catch (error) {
      // Ignore if not exists
    }
    
    // Create fresh instances
    connection = new QueueConnection();
    await connection.connect();
    
    factory = new QueueFactory(connection);
    monitor = new QueueMonitor(factory, connection);
  });

  afterEach(async () => {
    if (factory) {
      await factory.close();
    }
    if (connection) {
      await connection.close();
    }
  });

  describe('Queue Connection', () => {
    it('should establish Redis connection successfully', async () => {
      expect(connection.isConnected).toBe(true);
      
      const health = await connection.health();
      expect(health.status).toBe('healthy');
    });

    it('should provide connection statistics', () => {
      const stats = connection.getStats();
      expect(stats).toBeDefined();
      expect(stats?.status).toBe('ready');
    });
  });

  describe('Queue Factory', () => {
    it('should create queues for different job types', async () => {
      const scrapeQueue = await factory.getQueue(JobTypes.SCRAPE_REVIEWS);
      const labelQueue = await factory.getQueue(JobTypes.LABEL_REVIEWS);
      
      expect(scrapeQueue).toBeDefined();
      expect(labelQueue).toBeDefined();
      expect(scrapeQueue).not.toBe(labelQueue);
    });

    it('should add jobs to queue with validation', async () => {
      const jobData = {
        appId: '123456789',
        countries: ['us', 'ca'],
        pages: 3,
      };

      const job = await factory.addJob(JobTypes.SCRAPE_REVIEWS, jobData);
      expect(job).toBeDefined();
      expect(job.data.appId).toBe('123456789');
      expect(job.data.countries).toEqual(['us', 'ca']);
    });

    it('should reject invalid job data', async () => {
      const invalidJobData = {
        appId: '', // Invalid: empty string
      };

      await expect(
        factory.addJob(JobTypes.SCRAPE_REVIEWS, invalidJobData)
      ).rejects.toThrow();
    });

    it('should get queue statistics', async () => {
      await factory.getQueue(JobTypes.SCRAPE_REVIEWS);
      
      const stats = await factory.getQueueStats(JobTypes.SCRAPE_REVIEWS);
      expect(stats).toEqual({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
      });
    });

    it('should get all queue statistics', async () => {
      const allStats = await factory.getAllQueueStats();
      
      expect(Object.keys(allStats)).toEqual(
        expect.arrayContaining(Object.values(JobTypes))
      );
    });
  });

  describe('Queue Monitoring', () => {
    it('should provide comprehensive health status', async () => {
      const health = await monitor.getHealthStatus();
      
      expect(health).toMatchObject({
        status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
        timestamp: expect.any(String),
        connection: {
          status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
          responseTime: expect.any(Number),
        },
        queues: expect.any(Object),
        deadLetterQueues: expect.any(Object),
        summary: {
          totalActiveJobs: expect.any(Number),
          totalWaitingJobs: expect.any(Number),
          totalFailedJobs: expect.any(Number),
          totalDLQJobs: expect.any(Number),
        },
      });
    });

    it('should provide metrics for monitoring', async () => {
      const metrics = await monitor.getMetrics();
      
      expect(metrics).toMatchObject({
        timestamp: expect.any(String),
        connection: {
          responseTime: expect.any(Number),
          status: expect.any(String),
        },
        queues: expect.any(Object),
        deadLetterQueues: expect.any(Object),
        system: {
          total_jobs_processed: expect.any(Number),
          total_jobs_failed: expect.any(Number),
          total_active_jobs: expect.any(Number),
        },
      });
    });

    it('should provide simple health check', async () => {
      const simpleHealth = await monitor.getSimpleHealthCheck();
      
      expect(simpleHealth).toMatchObject({
        status: expect.stringMatching(/^(ok|error)$/),
        timestamp: expect.any(String),
      });
      expect(simpleHealth.status).toBe('ok');
    });

    it('should provide queue details', async () => {
      const details = await monitor.getQueueDetails(JobTypes.SCRAPE_REVIEWS);
      
      expect(details).toMatchObject({
        jobType: JobTypes.SCRAPE_REVIEWS,
        stats: {
          waiting: expect.any(Number),
          active: expect.any(Number),
          completed: expect.any(Number),
          failed: expect.any(Number),
          delayed: expect.any(Number),
          paused: expect.any(Boolean),
        },
        recentJobs: expect.any(Array),
        deadLetterQueue: {
          total: expect.any(Number),
          byFailureReason: expect.any(Object),
          recentFailures: expect.any(Array),
        },
      });
    });

    it('should provide processing statistics', async () => {
      const stats = await monitor.getProcessingStats();
      
      expect(stats).toMatchObject({
        processingRates: expect.any(Object),
        systemLoad: {
          totalActiveWorkers: expect.any(Number),
          averageQueueDepth: expect.any(Number),
          oldestWaitingJob: null,
        },
      });
    });
  });

  describe('Job Validation', () => {
    it('should validate scrape reviews job schema', async () => {
      const validJob = {
        appId: '737534985',
        countries: ['us', 'gb'],
        pages: 5,
        sortMethods: ['recent'],
        priority: 8,
      };

      const job = await factory.addJob(JobTypes.SCRAPE_REVIEWS, validJob);
      expect(job.data).toMatchObject({
        appId: '737534985',
        countries: ['us', 'gb'],
        pages: 5,
        sortMethods: ['recent'],
        priority: 8,
        retryAttempts: 3, // Default value
        delay: 0, // Default value
      });
    });

    it('should validate label reviews job schema', async () => {
      const validJob = {
        reviewIds: ['review1', 'review2'],
        batchSize: 25,
        model: 'gpt-4',
      };

      const job = await factory.addJob(JobTypes.LABEL_REVIEWS, validJob);
      expect(job.data).toMatchObject({
        reviewIds: ['review1', 'review2'],
        batchSize: 25,
        model: 'gpt-4',
        priority: 5, // Default value
        retryAttempts: 3, // Default value
      });
    });

    it('should validate export data job schema', async () => {
      const validJob = {
        appId: 'app123',
        format: 'xlsx' as const,
        includeLabels: false,
      };

      const job = await factory.addJob(JobTypes.EXPORT_DATA, validJob);
      expect(job.data).toMatchObject({
        appId: 'app123',
        format: 'xlsx',
        includeLabels: false,
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle connection failures gracefully', async () => {
      // Simulate connection failure
      const mockConnection = new QueueConnection();
      vi.spyOn(mockConnection, 'health').mockResolvedValue({
        status: 'unhealthy',
        responseTime: 5000,
        error: 'Connection timeout',
      });

      const mockMonitor = new QueueMonitor(factory, mockConnection);
      const health = await mockMonitor.getSimpleHealthCheck();
      
      expect(health.status).toBe('error');
      expect(health.message).toContain('Connection timeout');
    });
  });
});