import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LabelerWorker } from '../worker.js';
import type { Job, LabelReviewsJob } from '@review-scraper/shared';

// Mock the labeler
const mockLabeler = {
  labelReviews: vi.fn(),
  saveLabelResults: vi.fn(),
  getUnlabeledReviews: vi.fn(),
};

// Mock ReviewLabeler class
vi.mock('../labeler.js', () => ({
  ReviewLabeler: vi.fn(() => mockLabeler),
}));

// Mock shared dependencies
vi.mock('@review-scraper/shared', async () => {
  const actual = await vi.importActual('@review-scraper/shared');
  return {
    ...actual,
    getDatabasePool: vi.fn(() => ({
      query: vi.fn(),
    })),
    Logger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  };
});

// Mock environment variables
const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' };
  vi.clearAllMocks();
});

describe('LabelerWorker', () => {
  let worker: LabelerWorker;
  let mockJob: Partial<Job<LabelReviewsJob>>;

  beforeEach(() => {
    worker = new LabelerWorker();
    mockJob = {
      id: 'job-123',
      data: {
        reviewIds: ['review-1', 'review-2'],
        batchSize: 20,
        model: 'gpt-4o-mini',
        correlationId: 'test-correlation',
        priority: 5,
        retryAttempts: 2,
        delay: 0,
      },
      updateProgress: vi.fn(),
    };
  });

  describe('constructor', () => {
    it('should throw error if OPENAI_API_KEY is not set', () => {
      delete process.env.OPENAI_API_KEY;
      
      expect(() => new LabelerWorker()).toThrow('OPENAI_API_KEY environment variable is required');
    });

    it('should initialize successfully with API key', () => {
      expect(() => new LabelerWorker()).not.toThrow();
    });
  });

  describe('processLabelingJob', () => {
    beforeEach(() => {
      // Mock database query for fetching reviews
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 'review-1',
              user_name: 'user1',
              text: 'Great app!',
              score: 5,
              country: 'US',
              date: new Date(),
            },
            {
              id: 'review-2',
              user_name: 'user2',
              text: 'Terrible bugs',
              score: 1,
              country: 'US',
              date: new Date(),
            },
          ]
        })
      };
      
      const { getDatabasePool } = require('@review-scraper/shared');
      getDatabasePool.mockReturnValue(mockDb);
    });

    it('should process labeling job successfully', async () => {
      const mockLabelResults = [
        {
          reviewId: 'review-1',
          theme: 'Features',
          sentiment: 'positive',
          severity: 1,
          featureRequest: false,
          directQuote: 'Great app',
          confidence: 0.95,
          modelVersion: 'gpt-4o-mini',
        },
        {
          reviewId: 'review-2',
          theme: 'Bugs/Errors',
          sentiment: 'negative',
          severity: 4,
          featureRequest: true,
          directQuote: 'Terrible bugs',
          confidence: 0.90,
        },
      ];

      mockLabeler.labelReviews.mockResolvedValue(mockLabelResults);
      mockLabeler.saveLabelResults.mockResolvedValue(undefined);

      const result = await worker.processLabelingJob(mockJob as Job<LabelReviewsJob>);

      expect(result.success).toBe(true);
      expect(result.itemsProcessed).toBe(2);
      expect(result.data).toMatchObject({
        reviewsProcessed: 2,
        model: 'gpt-4o-mini',
        averageConfidence: 0.925, // (0.95 + 0.90) / 2
        sentimentBreakdown: {
          positive: 1,
          negative: 1,
          neutral: 0,
        },
        correlationId: 'test-correlation',
      });

      expect(mockJob.updateProgress).toHaveBeenCalledWith(100);
      expect(mockLabeler.labelReviews).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'review-1' }),
          expect.objectContaining({ id: 'review-2' }),
        ]),
        {
          batchSize: 20,
          model: 'gpt-4o-mini',
        }
      );
      expect(mockLabeler.saveLabelResults).toHaveBeenCalledWith(mockLabelResults);
    });

    it('should handle case when no reviews are found', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] })
      };
      
      const { getDatabasePool } = require('@review-scraper/shared');
      getDatabasePool.mockReturnValue(mockDb);

      const result = await worker.processLabelingJob(mockJob as Job<LabelReviewsJob>);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No reviews found');
      expect(result.itemsProcessed).toBe(0);
    });

    it('should handle labeling errors gracefully', async () => {
      mockLabeler.labelReviews.mockRejectedValue(new Error('OpenAI API Error'));

      const result = await worker.processLabelingJob(mockJob as Job<LabelReviewsJob>);

      expect(result.success).toBe(false);
      expect(result.error).toBe('OpenAI API Error');
      expect(result.itemsProcessed).toBe(0);
      expect(result.data).toMatchObject({
        reviewIds: ['review-1', 'review-2'],
        correlationId: 'test-correlation',
      });
    });

    it('should handle database save errors', async () => {
      const mockLabelResults = [
        {
          reviewId: 'review-1',
          theme: 'Features',
          sentiment: 'positive',
          severity: 1,
          featureRequest: false,
          directQuote: 'Great app',
          confidence: 0.95,
          modelVersion: 'gpt-4o-mini',
        },
      ];

      mockLabeler.labelReviews.mockResolvedValue(mockLabelResults);
      mockLabeler.saveLabelResults.mockRejectedValue(new Error('Database error'));

      const result = await worker.processLabelingJob(mockJob as Job<LabelReviewsJob>);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Database error');
    });

    it('should update job progress throughout processing', async () => {
      mockLabeler.labelReviews.mockResolvedValue([]);
      mockLabeler.saveLabelResults.mockResolvedValue(undefined);

      await worker.processLabelingJob(mockJob as Job<LabelReviewsJob>);

      expect(mockJob.updateProgress).toHaveBeenCalledWith(10); // Starting
      expect(mockJob.updateProgress).toHaveBeenCalledWith(20); // Reviews fetched
      expect(mockJob.updateProgress).toHaveBeenCalledWith(80); // Labeling complete
      expect(mockJob.updateProgress).toHaveBeenCalledWith(95); // Saved to DB
      expect(mockJob.updateProgress).toHaveBeenCalledWith(100); // Complete
    });
  });

  describe('processUnlabeledReviews', () => {
    it('should process unlabeled reviews successfully', async () => {
      const mockUnlabeledReviews = [
        {
          id: 'review-3',
          userName: 'user3',
          text: 'Decent app',
          score: 3,
          country: 'US',
        },
      ];

      const mockLabelResults = [
        {
          reviewId: 'review-3',
          theme: 'General Feedback',
          sentiment: 'neutral',
          severity: 1,
          featureRequest: false,
          directQuote: 'Decent app',
          confidence: 0.75,
          modelVersion: 'gpt-4o-mini',
        },
      ];

      mockLabeler.getUnlabeledReviews.mockResolvedValue(mockUnlabeledReviews);
      mockLabeler.labelReviews.mockResolvedValue(mockLabelResults);
      mockLabeler.saveLabelResults.mockResolvedValue(undefined);

      const result = await worker.processUnlabeledReviews(10);

      expect(result.success).toBe(true);
      expect(result.itemsProcessed).toBe(1);
      expect(result.data).toMatchObject({
        reviewsProcessed: 1,
        averageConfidence: 0.75,
        sentimentBreakdown: {
          positive: 0,
          negative: 0,
          neutral: 1,
        },
      });

      expect(mockLabeler.getUnlabeledReviews).toHaveBeenCalledWith(10);
    });

    it('should handle case when no unlabeled reviews exist', async () => {
      mockLabeler.getUnlabeledReviews.mockResolvedValue([]);

      const result = await worker.processUnlabeledReviews(10);

      expect(result.success).toBe(true);
      expect(result.message).toBe('No unlabeled reviews found');
      expect(result.itemsProcessed).toBe(0);
    });
  });

  describe('helper methods', () => {
    it('should calculate average confidence correctly', async () => {
      const mockLabelResults = [
        { confidence: 0.8, sentiment: 'positive' as const },
        { confidence: 0.9, sentiment: 'negative' as const },
        { confidence: 0.7, sentiment: 'neutral' as const },
      ];

      // Access private method for testing
      const avgConfidence = (worker as any).calculateAverageConfidence(mockLabelResults);
      expect(avgConfidence).toBe(0.8); // (0.8 + 0.9 + 0.7) / 3 = 0.8
    });

    it('should create sentiment breakdown correctly', async () => {
      const mockLabelResults = [
        { sentiment: 'positive' as const },
        { sentiment: 'positive' as const },
        { sentiment: 'negative' as const },
        { sentiment: 'neutral' as const },
      ];

      const breakdown = (worker as any).getSentimentBreakdown(mockLabelResults);
      expect(breakdown).toEqual({
        positive: 2,
        negative: 1,
        neutral: 1,
      });
    });
  });

  describe('getWorkerConfig', () => {
    it('should return development config by default', () => {
      process.env.NODE_ENV = 'development';
      const config = LabelerWorker.getWorkerConfig();
      
      expect(config).toEqual({
        concurrency: 1,
        limiter: {
          max: 5,
          duration: 60000,
        },
      });
    });

    it('should return production config when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      const config = LabelerWorker.getWorkerConfig();
      
      expect(config).toEqual({
        concurrency: 2,
        limiter: {
          max: 5,
          duration: 60000,
        },
      });
    });
  });
});