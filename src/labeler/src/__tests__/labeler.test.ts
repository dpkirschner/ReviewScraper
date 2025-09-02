import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReviewLabeler, type LabelResult } from '../labeler.js';
import type { Review } from '@review-scraper/shared';

// Mock OpenAI
const mockOpenAI = {
  chat: {
    completions: {
      create: vi.fn(),
    },
  },
};

vi.mock('openai', () => ({
  default: vi.fn(() => mockOpenAI),
}));

// Mock database pool
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

describe('ReviewLabeler', () => {
  let labeler: ReviewLabeler;
  const mockReviews: Review[] = [
    {
      id: 'review-1',
      userName: 'user1',
      userUrl: null,
      version: '1.0.0',
      score: 5,
      title: 'Great app!',
      text: 'This app is amazing and works perfectly. Love the new features!',
      url: null,
      date: new Date('2024-01-01'),
      replyDate: null,
      replyText: null,
      helpfulVotes: 10,
      country: 'US',
    },
    {
      id: 'review-2',
      userName: 'user2',
      userUrl: null,
      version: '1.0.0',
      score: 1,
      title: 'Terrible bugs',
      text: 'The app keeps crashing and the login feature is broken. Please fix this!',
      url: null,
      date: new Date('2024-01-02'),
      replyDate: null,
      replyText: null,
      helpfulVotes: 5,
      country: 'US',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    labeler = new ReviewLabeler({
      apiKey: 'test-api-key',
    });
  });

  describe('labelReviews', () => {
    it('should process reviews and return label results', async () => {
      // Mock OpenAI response
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify([
              {
                reviewId: 'review-1',
                theme: 'Features',
                sentiment: 'positive',
                severity: 1,
                featureRequest: false,
                directQuote: 'amazing and works perfectly',
                confidence: 0.95,
              },
              {
                reviewId: 'review-2',
                theme: 'Bugs/Errors',
                sentiment: 'negative',
                severity: 4,
                featureRequest: true,
                directQuote: 'keeps crashing and login feature is broken',
                confidence: 0.90,
              }
            ])
          }
        }]
      };

      mockOpenAI.chat.completions.create.mockResolvedValue(mockResponse);

      const results = await labeler.labelReviews(mockReviews);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        reviewId: 'review-1',
        theme: 'Features',
        sentiment: 'positive',
        severity: 1,
        featureRequest: false,
        confidence: 0.95,
      });
      expect(results[1]).toMatchObject({
        reviewId: 'review-2',
        theme: 'Bugs/Errors',
        sentiment: 'negative',
        severity: 4,
        featureRequest: true,
        confidence: 0.90,
      });
    });

    it('should handle OpenAI API errors gracefully', async () => {
      mockOpenAI.chat.completions.create.mockRejectedValue(new Error('API Error'));

      const results = await labeler.labelReviews(mockReviews);

      // Should return default results for failed batch
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        reviewId: 'review-1',
        theme: 'General Feedback',
        sentiment: 'neutral',
        severity: 1,
        featureRequest: false,
        confidence: 0,
      });
    });

    it('should handle malformed OpenAI responses', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: 'invalid json response'
          }
        }]
      };

      mockOpenAI.chat.completions.create.mockResolvedValue(mockResponse);

      const results = await labeler.labelReviews(mockReviews);

      // Should return default results for failed parsing
      expect(results).toHaveLength(2);
      expect(results[0].theme).toBe('General Feedback');
      expect(results[0].sentiment).toBe('neutral');
    });

    it('should validate and clean up result data', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify([
              {
                reviewId: 'review-1',
                theme: 'Invalid Theme', // Should default to General Feedback
                sentiment: 'invalid-sentiment', // Should default to neutral
                severity: 10, // Should be clamped to 5
                featureRequest: 'yes', // Should convert to boolean
                directQuote: 'a'.repeat(200), // Should be truncated to 100 chars
                confidence: 2.5, // Should be clamped to 1.0
              }
            ])
          }
        }]
      };

      mockOpenAI.chat.completions.create.mockResolvedValue(mockResponse);

      const results = await labeler.labelReviews([mockReviews[0]]);

      expect(results[0]).toMatchObject({
        theme: 'General Feedback',
        sentiment: 'neutral',
        severity: 5, // Clamped to max
        featureRequest: true, // Converted to boolean
        confidence: 1.0, // Clamped to max
      });
      expect(results[0].directQuote.length).toBeLessThanOrEqual(100);
    });

    it('should process reviews in batches', async () => {
      const largeReviewSet = Array.from({ length: 25 }, (_, i) => ({
        ...mockReviews[0],
        id: `review-${i}`,
        text: `Review text ${i}`,
      }));

      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify(
              Array.from({ length: 20 }, (_, i) => ({
                reviewId: `review-${i}`,
                theme: 'General Feedback',
                sentiment: 'neutral',
                severity: 1,
                featureRequest: false,
                directQuote: 'test quote',
                confidence: 0.5,
              }))
            )
          }
        }]
      });

      const results = await labeler.labelReviews(largeReviewSet, { batchSize: 20 });

      // Should make 2 API calls (20 + 5 reviews)
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(25);
    });
  });

  describe('saveLabelResults', () => {
    it('should save results to database', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
      const mockDb = { query: mockQuery };
      
      // Mock getDatabasePool to return our mock
      const { getDatabasePool } = await import('@review-scraper/shared');
      vi.mocked(getDatabasePool).mockReturnValue(mockDb as any);

      const labelResults: LabelResult[] = [
        {
          reviewId: 'review-1',
          theme: 'Features',
          sentiment: 'positive',
          severity: 1,
          featureRequest: false,
          directQuote: 'great app',
          confidence: 0.95,
          modelVersion: 'gpt-4o-mini',
        }
      ];

      await labeler.saveLabelResults(labelResults);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO labels'),
        expect.arrayContaining([
          expect.any(String), // id
          'review-1', // review_id
          'positive', // sentiment
          0.95, // confidence
          'Features', // theme
          1, // severity
          false, // feature_request
          'great app', // direct_quote
          'gpt-4o-mini' // model_version
        ])
      );
    });

    it('should handle database errors gracefully', async () => {
      const mockQuery = vi.fn().mockRejectedValue(new Error('DB Error'));
      const mockDb = { query: mockQuery };
      
      const { getDatabasePool } = await import('@review-scraper/shared');
      vi.mocked(getDatabasePool).mockReturnValue(mockDb as any);

      const labelResults: LabelResult[] = [
        {
          reviewId: 'review-1',
          theme: 'Features',
          sentiment: 'positive',
          severity: 1,
          featureRequest: false,
          directQuote: 'great app',
          confidence: 0.95,
          modelVersion: 'gpt-4o-mini',
        }
      ];

      await expect(labeler.saveLabelResults(labelResults)).rejects.toThrow('DB Error');
    });
  });

  describe('getUnlabeledReviews', () => {
    it('should fetch unlabeled reviews from database', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'review-1',
            user_name: 'user1',
            user_url: null,
            version: '1.0.0',
            score: 5,
            title: 'Great!',
            text: 'Amazing app',
            url: null,
            date: new Date('2024-01-01'),
            reply_date: null,
            reply_text: null,
            helpful_votes: 10,
            country: 'US',
          }
        ]
      });
      const mockDb = { query: mockQuery };
      
      const { getDatabasePool } = await import('@review-scraper/shared');
      vi.mocked(getDatabasePool).mockReturnValue(mockDb as any);

      const reviews = await labeler.getUnlabeledReviews(10);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT r.* FROM reviews r'),
        [10]
      );
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        id: 'review-1',
        userName: 'user1',
        score: 5,
        text: 'Amazing app',
        country: 'US',
      });
    });
  });
});