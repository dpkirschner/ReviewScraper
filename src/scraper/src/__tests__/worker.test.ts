import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Job } from 'bullmq';
import { ScraperWorker } from '../worker.js';
import { ScrapeReviewsJob, JobResult, AppInfo, Review } from '@review-scraper/shared';

// Mock dependencies
vi.mock('app-store-scraper', () => ({
  default: {
    app: vi.fn(),
    reviews: vi.fn(),
    sort: {
      RECENT: 0,
      HELPFUL: 1,
    },
  },
}));

vi.mock('@review-scraper/shared', async () => {
  const actual = await vi.importActual('@review-scraper/shared');
  return {
    ...actual,
    getDatabasePool: vi.fn(() => ({
      query: vi.fn(),
    })),
    Logger: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  };
});

describe('ScraperWorker', () => {
  let worker: ScraperWorker;
  let mockJob: Partial<Job<ScrapeReviewsJob>>;
  let mockDbPool: any;
  let mockStore: any;

  beforeEach(async () => {
    // Reset all mocks
    vi.clearAllMocks();

    // Import the mocked modules
    const { getDatabasePool } = await import('@review-scraper/shared');
    const store = await import('app-store-scraper');
    
    mockStore = store.default;
    mockDbPool = {
      query: vi.fn(),
    };

    (getDatabasePool as any).mockReturnValue(mockDbPool);

    worker = new ScraperWorker();

    // Mock job object
    mockJob = {
      id: 'test-job-123',
      data: {
        appId: '12345',
        countries: ['us', 'gb'],
        pages: 2,
        sortMethods: ['recent' as const],
        throttleMs: 100,
        correlationId: 'test-correlation-id',
        priority: 5,
        retryAttempts: 3,
        delay: 0,
      },
      updateProgress: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('processScrapingJob', () => {
    it('should successfully process a scraping job', async () => {
      const mockAppData = {
        title: 'Test App',
        description: 'A test app',
        version: '1.0.0',
        developer: 'Test Developer',
        genre: 'Games',
      };

      const mockReviews = [
        {
          id: 'review1',
          userName: 'User1',
          userUrl: 'https://example.com/user1',
          version: '1.0.0',
          score: 5,
          title: 'Great app!',
          text: 'Love this app',
          url: 'https://example.com/review1',
          date: '2024-01-01',
          replyDate: null,
          replyText: null,
          helpfulVotes: 5,
        },
        {
          id: 'review2',
          userName: 'User2',
          userUrl: null,
          version: '1.0.0',
          score: 4,
          title: 'Good app',
          text: 'Pretty good',
          url: 'https://example.com/review2',
          date: '2024-01-02',
          replyDate: '2024-01-03',
          replyText: 'Thanks!',
          helpfulVotes: 2,
        },
      ];

      // Mock app store API responses
      mockStore.app.mockResolvedValue(mockAppData);
      mockStore.reviews.mockResolvedValue(mockReviews);

      // Mock database responses
      mockDbPool.query
        .mockResolvedValueOnce({ rows: [] }) // App doesn't exist
        .mockResolvedValue({ rows: [{ id: 1 }] }); // All other queries succeed

      const result = await worker.processScrapingJob(mockJob as Job<ScrapeReviewsJob>);

      expect(result.success).toBe(true);
      expect(result.data?.reviewsScraped).toBe(2); // Unique reviews after deduplication
      expect(result.data?.appId).toBe('12345');
      expect(result.data?.appTitle).toBe('Test App');
      expect(result.processingTime).toBeGreaterThan(0);
      expect(result.itemsProcessed).toBe(2);

      // Verify progress updates
      expect(mockJob.updateProgress).toHaveBeenCalledWith(10);
      expect(mockJob.updateProgress).toHaveBeenCalledWith(20);
      expect(mockJob.updateProgress).toHaveBeenCalledWith(30);
      expect(mockJob.updateProgress).toHaveBeenCalledWith(100);

      // Verify app creation
      expect(mockStore.app).toHaveBeenCalledWith({ id: '12345', country: 'us' });
      expect(mockDbPool.query).toHaveBeenCalledWith(
        'SELECT id FROM apps WHERE id = $1',
        ['12345']
      );

      // Verify reviews were fetched for both countries
      expect(mockStore.reviews).toHaveBeenCalledWith({
        id: '12345',
        country: 'us',
        page: 1,
        sort: 0, // RECENT
        throttle: 100,
      });
      expect(mockStore.reviews).toHaveBeenCalledWith({
        id: '12345',
        country: 'gb',
        page: 1,
        sort: 0, // RECENT
        throttle: 100,
      });
    });

    it('should handle app fetch errors gracefully', async () => {
      const mockReviews = [
        {
          id: 'review1',
          userName: 'User1',
          score: 5,
          title: 'Great!',
          text: 'Good app',
          date: '2024-01-01',
          helpfulVotes: 1,
        },
      ];

      // Mock app fetch error
      mockStore.app.mockRejectedValue(new Error('App not found'));
      mockStore.reviews.mockResolvedValue(mockReviews);
      
      // Mock database responses
      mockDbPool.query.mockResolvedValue({ rows: [{ id: 1 }] });

      const result = await worker.processScrapingJob(mockJob as Job<ScrapeReviewsJob>);

      expect(result.success).toBe(true);
      expect(result.data?.appTitle).toBe('Unknown App');
      
      // Should still process reviews
      expect(mockStore.reviews).toHaveBeenCalled();
    });

    it('should handle database errors', async () => {
      const mockAppData = { title: 'Test App' };
      
      mockStore.app.mockResolvedValue(mockAppData);
      mockStore.reviews.mockResolvedValue([]);
      
      // Mock database error
      mockDbPool.query.mockRejectedValue(new Error('Database connection failed'));

      const result = await worker.processScrapingJob(mockJob as Job<ScrapeReviewsJob>);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Database connection failed');
      expect(result.itemsProcessed).toBe(0);
    });

    it('should handle review fetch errors for individual countries', async () => {
      const mockAppData = { title: 'Test App' };
      const mockReviews = [{ id: 'review1', score: 5, date: '2024-01-01' }];

      mockStore.app.mockResolvedValue(mockAppData);
      mockStore.reviews
        .mockResolvedValueOnce(mockReviews) // First country succeeds
        .mockRejectedValueOnce(new Error('Country blocked')); // Second country fails

      mockDbPool.query.mockResolvedValue({ rows: [{ id: 1 }] });

      const result = await worker.processScrapingJob(mockJob as Job<ScrapeReviewsJob>);

      expect(result.success).toBe(true);
      expect(result.data?.reviewsScraped).toBe(1); // Only one country's reviews
    });

    it('should handle multiple sort methods', async () => {
      const jobWithMultipleSorts = {
        ...mockJob,
        data: {
          ...mockJob.data!,
          sortMethods: ['recent' as const, 'helpful' as const],
        },
      };

      const mockAppData = { title: 'Test App' };
      const mockReviews = [{ id: 'review1', score: 5, date: '2024-01-01' }];

      mockStore.app.mockResolvedValue(mockAppData);
      mockStore.reviews.mockResolvedValue(mockReviews);
      mockDbPool.query.mockResolvedValue({ rows: [{ id: 1 }] });

      const result = await worker.processScrapingJob(jobWithMultipleSorts as Job<ScrapeReviewsJob>);

      expect(result.success).toBe(true);
      
      // Should call reviews API for each sort method × country combination × pages
      // 2 sort methods × 2 countries × 2 pages = 8 calls maximum (may stop early if no reviews)
      expect(mockStore.reviews).toHaveBeenCalledTimes(8);
      
      // Check that different sort methods were used
      expect(mockStore.reviews).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 0 }) // RECENT
      );
      expect(mockStore.reviews).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 1 }) // HELPFUL
      );
    });

    it('should deduplicate reviews by ID', async () => {
      const mockAppData = { title: 'Test App' };
      const duplicateReviews = [
        { id: 'review1', score: 5, date: '2024-01-01', userName: 'User1' },
        { id: 'review1', score: 5, date: '2024-01-01', userName: 'User1' }, // Duplicate
        { id: 'review2', score: 4, date: '2024-01-02', userName: 'User2' },
      ];

      mockStore.app.mockResolvedValue(mockAppData);
      mockStore.reviews.mockResolvedValue(duplicateReviews);
      mockDbPool.query.mockResolvedValue({ rows: [{ id: 1 }] });

      const result = await worker.processScrapingJob(mockJob as Job<ScrapeReviewsJob>);

      expect(result.success).toBe(true);
      
      // Should save only unique reviews: 2 unique reviews (deduplication works)
      expect(result.data?.reviewsScraped).toBe(2);
      expect(result.itemsProcessed).toBe(2);
    });

    it('should stop fetching when no more reviews are found', async () => {
      const mockAppData = { title: 'Test App' };

      mockStore.app.mockResolvedValue(mockAppData);
      mockStore.reviews
        .mockResolvedValueOnce([{ id: 'review1', score: 5, date: '2024-01-01' }]) // Page 1 has reviews
        .mockResolvedValueOnce([]); // Page 2 is empty

      mockDbPool.query.mockResolvedValue({ rows: [{ id: 1 }] });

      const result = await worker.processScrapingJob(mockJob as Job<ScrapeReviewsJob>);

      expect(result.success).toBe(true);
      
      // Should fetch page 1 for each country (2 calls), then page 2 for each country (2 calls) = 4 total
      expect(mockStore.reviews).toHaveBeenCalledTimes(4);
    });
  });

  describe('getWorkerConfig', () => {
    it('should return development config by default', () => {
      const config = ScraperWorker.getWorkerConfig();
      
      expect(config.concurrency).toBe(1);
      expect(config.limiter.max).toBe(10);
      expect(config.limiter.duration).toBe(60000);
    });

    it('should return production config when NODE_ENV is production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      const config = ScraperWorker.getWorkerConfig();
      
      expect(config.concurrency).toBe(3);
      expect(config.limiter.max).toBe(10);
      expect(config.limiter.duration).toBe(60000);
      
      // Restore original environment
      process.env.NODE_ENV = originalEnv;
    });
  });
});