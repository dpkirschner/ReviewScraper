import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { 
  createQueueConnection, 
  createQueueFactory,
  JobTypes,
  closeQueueConnection 
} from '@review-scraper/shared';
import { LabelerService } from '../service.js';

// Mock OpenAI and environment
vi.mock('openai', () => ({
  default: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify([
                {
                  reviewId: 'test-review-1',
                  theme: 'General Feedback',
                  sentiment: 'positive',
                  severity: 1,
                  featureRequest: false,
                  directQuote: 'test quote',
                  confidence: 0.85,
                }
              ])
            }
          }]
        }),
      },
    },
  })),
}));

// Mock database
vi.mock('@review-scraper/shared', async () => {
  const actual = await vi.importActual('@review-scraper/shared');
  return {
    ...actual,
    getDatabasePool: vi.fn(() => ({
      initialize: vi.fn(),
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'test-review-1',
            user_name: 'testuser',
            user_url: null,
            version: '1.0.0',
            score: 5,
            title: 'Great!',
            text: 'This app is amazing!',
            url: null,
            date: new Date(),
            reply_date: null,
            reply_text: null,
            helpful_votes: 0,
            country: 'US',
          }
        ]
      }),
    })),
    createDatabasePool: vi.fn(() => ({
      initialize: vi.fn(),
    })),
    Logger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  };
});

// Set up environment
process.env.OPENAI_API_KEY = 'test-api-key';

describe('Labeler Service Integration Tests', () => {
  let service: LabelerService;
  let connection: any;
  let factory: any;

  beforeAll(async () => {
    try {
      // Initialize queue connection for testing
      connection = createQueueConnection({
        connection: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          db: 2, // Use separate DB for tests
        }
      });
      
      await connection.connect();
      factory = createQueueFactory(connection);
      
      service = new LabelerService();
      
      console.log('✅ Integration test setup complete');
    } catch (error) {
      console.error('❌ Integration test setup failed:', error);
      throw error;
    }
  });

  afterAll(async () => {
    try {
      if (service && service.running) {
        await service.shutdown();
      }
      if (factory) {
        await factory.close();
      }
      await closeQueueConnection();
      console.log('✅ Integration test cleanup complete');
    } catch (error) {
      console.error('❌ Integration test cleanup failed:', error);
    }
  });

  it('should initialize labeler service successfully', async () => {
    await service.initialize();
    expect(service.running).toBe(true);
    
    const health = await service.getHealthStatus();
    expect(health.status).toBeDefined();
    expect(health.service).toBe('labeler');
  });

  it('should queue and validate labeling jobs', async () => {
    const reviewIds = ['test-review-1', 'test-review-2'];
    
    const jobId = await service.queueLabelingJob({
      reviewIds,
      batchSize: 20,
      model: 'gpt-4o-mini',
      correlationId: 'integration-test-123',
    });

    expect(jobId).toBeDefined();
    expect(jobId).toBeTruthy();
    
    // Verify job was added to queue
    const stats = await service.getQueueStats();
    expect(stats.waiting).toBeGreaterThanOrEqual(1);
  });

  it('should get queue statistics', async () => {
    const stats = await service.getQueueStats();
    
    expect(stats).toHaveProperty('waiting');
    expect(stats).toHaveProperty('active');
    expect(stats).toHaveProperty('completed');
    expect(stats).toHaveProperty('failed');
    expect(stats).toHaveProperty('delayed');
    expect(stats).toHaveProperty('paused');
  });

  it('should queue multiple labeling jobs in batches', async () => {
    const reviewIds = Array.from({ length: 45 }, (_, i) => `batch-review-${i}`);
    
    const jobIds = await service.queueMultipleLabelingJobs(reviewIds, {
      batchSize: 20,
      model: 'gpt-4o-mini',
      correlationId: 'batch-test',
    });

    // Should create 3 jobs: 20 + 20 + 5 reviews
    expect(jobIds).toHaveLength(3);
    expect(jobIds.every(id => id && id.length > 0)).toBe(true);
  });

  it('should handle queue management operations', async () => {
    // Test pause/resume
    await service.pauseQueue();
    let stats = await service.getQueueStats();
    expect(stats.paused).toBe(true);
    
    await service.resumeQueue();
    stats = await service.getQueueStats();
    expect(stats.paused).toBe(false);
    
    // Test clean (shouldn't throw)
    await expect(service.cleanQueue(1)).resolves.not.toThrow();
  });

  it('should provide health status with worker details', async () => {
    const health = await service.getHealthStatus();
    
    expect(health).toMatchObject({
      status: expect.any(String),
      timestamp: expect.any(String),
      service: 'labeler',
      worker: expect.objectContaining({
        isRunning: expect.any(Boolean),
        concurrency: expect.any(Number),
      }),
      workerHealth: expect.objectContaining({
        status: expect.any(String),
        details: expect.objectContaining({
          workerRunning: expect.any(Boolean),
          openaiConfigured: expect.any(Boolean),
        }),
      }),
    });
  });

  it('should handle errors gracefully when OpenAI is not configured', async () => {
    // Temporarily remove API key
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const tempService = new LabelerService();
    
    await expect(tempService.initialize()).rejects.toThrow('OPENAI_API_KEY environment variable is required');
    
    // Restore API key
    process.env.OPENAI_API_KEY = originalKey;
  });

  it('should validate job payload parameters', async () => {
    // Test with empty review IDs
    await expect(
      service.queueLabelingJob({
        reviewIds: [],
        batchSize: 20,
        model: 'gpt-4o-mini',
      })
    ).rejects.toThrow();
    
    // Test with valid parameters
    await expect(
      service.queueLabelingJob({
        reviewIds: ['valid-review-id'],
        batchSize: 10,
        model: 'gpt-4o-mini',
      })
    ).resolves.toBeTruthy();
  });
});