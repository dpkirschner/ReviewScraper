import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  JobTypes,
  ScrapeReviewsJobSchema,
  LabelReviewsJobSchema,
  ProcessResultsJobSchema,
  CleanupDataJobSchema,
  ExportDataJobSchema,
  JobResultSchema,
  QueueConfigSchema,
  getJobSchema,
  validateJobPayload,
} from './types.js';

describe('Job Types', () => {
  describe('JobTypes constant', () => {
    it('should contain all expected job types', () => {
      expect(JobTypes.SCRAPE_REVIEWS).toBe('scrape_reviews');
      expect(JobTypes.LABEL_REVIEWS).toBe('label_reviews');
      expect(JobTypes.PROCESS_RESULTS).toBe('process_results');
      expect(JobTypes.CLEANUP_DATA).toBe('cleanup_data');
      expect(JobTypes.EXPORT_DATA).toBe('export_data');
    });
  });

  describe('ScrapeReviewsJobSchema', () => {
    it('should validate a valid scrape reviews job', () => {
      const validJob = {
        appId: '123456789',
        countries: ['us', 'ca'],
        pages: 5,
        sortMethods: ['recent', 'helpful'],
        throttleMs: 1000,
        priority: 7,
        retryAttempts: 2,
        correlationId: uuidv4(),
      };

      const result = ScrapeReviewsJobSchema.parse(validJob);
      expect(result).toEqual({ ...validJob, delay: 0 }); // delay is added by default
    });

    it('should use defaults for optional fields', () => {
      const minimalJob = {
        appId: '123456789',
      };

      const result = ScrapeReviewsJobSchema.parse(minimalJob);
      expect(result.countries).toEqual(['us']);
      expect(result.pages).toBe(5);
      expect(result.sortMethods).toEqual(['recent']);
      expect(result.throttleMs).toBe(500);
      expect(result.priority).toBe(5);
      expect(result.retryAttempts).toBe(3);
      expect(result.delay).toBe(0);
    });

    it('should reject invalid data', () => {
      expect(() => ScrapeReviewsJobSchema.parse({ appId: '' })).toThrow();
      expect(() => ScrapeReviewsJobSchema.parse({ appId: '123', countries: [] })).toThrow();
      expect(() => ScrapeReviewsJobSchema.parse({ appId: '123', pages: 0 })).toThrow();
      expect(() => ScrapeReviewsJobSchema.parse({ appId: '123', pages: 11 })).toThrow();
      expect(() => ScrapeReviewsJobSchema.parse({ appId: '123', priority: 0 })).toThrow();
      expect(() => ScrapeReviewsJobSchema.parse({ appId: '123', priority: 11 })).toThrow();
    });

    it('should validate country codes are 2 characters', () => {
      expect(() => ScrapeReviewsJobSchema.parse({
        appId: '123',
        countries: ['usa'] // Should be 'us'
      })).toThrow();
      
      expect(() => ScrapeReviewsJobSchema.parse({
        appId: '123', 
        countries: ['u'] // Should be 2 characters
      })).toThrow();
    });
  });

  describe('LabelReviewsJobSchema', () => {
    it('should validate a valid label reviews job', () => {
      const validJob = {
        reviewIds: ['review1', 'review2', 'review3'],
        batchSize: 30,
        model: 'gpt-4',
        taxonomyPath: '/path/to/taxonomy.json',
        correlationId: uuidv4(),
        priority: 8,
      };

      const result = LabelReviewsJobSchema.parse(validJob);
      expect(result.reviewIds).toEqual(validJob.reviewIds);
      expect(result.batchSize).toBe(30);
      expect(result.model).toBe('gpt-4');
    });

    it('should use defaults for optional fields', () => {
      const minimalJob = {
        reviewIds: ['review1'],
      };

      const result = LabelReviewsJobSchema.parse(minimalJob);
      expect(result.batchSize).toBe(20);
      expect(result.model).toBe('gpt-4.1-mini');
      expect(result.priority).toBe(5);
    });

    it('should reject invalid data', () => {
      expect(() => LabelReviewsJobSchema.parse({ reviewIds: [] })).toThrow();
      expect(() => LabelReviewsJobSchema.parse({ reviewIds: [''] })).toThrow();
      expect(() => LabelReviewsJobSchema.parse({ reviewIds: ['valid'], batchSize: 0 })).toThrow();
      expect(() => LabelReviewsJobSchema.parse({ reviewIds: ['valid'], batchSize: 101 })).toThrow();
    });
  });

  describe('ProcessResultsJobSchema', () => {
    it('should validate a valid process results job', () => {
      const validJob = {
        sourceJobId: 'job123',
        resultType: 'scraped_reviews' as const,
        outputFormat: 'json' as const,
        correlationId: uuidv4(),
      };

      const result = ProcessResultsJobSchema.parse(validJob);
      expect(result.sourceJobId).toBe('job123');
      expect(result.resultType).toBe('scraped_reviews');
      expect(result.outputFormat).toBe('json');
    });

    it('should use defaults', () => {
      const minimalJob = {
        sourceJobId: 'job123',
        resultType: 'labeled_reviews' as const,
      };

      const result = ProcessResultsJobSchema.parse(minimalJob);
      expect(result.outputFormat).toBe('database');
      expect(result.priority).toBe(5);
    });

    it('should validate enum values', () => {
      expect(() => ProcessResultsJobSchema.parse({
        sourceJobId: 'job123',
        resultType: 'invalid_type'
      })).toThrow();

      expect(() => ProcessResultsJobSchema.parse({
        sourceJobId: 'job123',
        resultType: 'scraped_reviews',
        outputFormat: 'xml'
      })).toThrow();
    });
  });

  describe('CleanupDataJobSchema', () => {
    it('should validate a valid cleanup job', () => {
      const validJob = {
        targetType: 'old_reviews' as const,
        olderThanDays: 60,
        dryRun: true,
        correlationId: uuidv4(),
      };

      const result = CleanupDataJobSchema.parse(validJob);
      expect(result.targetType).toBe('old_reviews');
      expect(result.olderThanDays).toBe(60);
      expect(result.dryRun).toBe(true);
    });

    it('should use defaults', () => {
      const minimalJob = {
        targetType: 'failed_jobs' as const,
      };

      const result = CleanupDataJobSchema.parse(minimalJob);
      expect(result.olderThanDays).toBe(30);
      expect(result.dryRun).toBe(false);
    });

    it('should validate minimum days', () => {
      expect(() => CleanupDataJobSchema.parse({
        targetType: 'old_reviews',
        olderThanDays: 0
      })).toThrow();
    });
  });

  describe('ExportDataJobSchema', () => {
    it('should validate a valid export job', () => {
      const validJob = {
        appId: 'app123',
        format: 'xlsx' as const,
        includeLabels: false,
        dateRange: {
          startDate: '2024-01-01T00:00:00Z',
          endDate: '2024-12-31T23:59:59Z',
        },
        correlationId: uuidv4(),
      };

      const result = ExportDataJobSchema.parse(validJob);
      expect(result.appId).toBe('app123');
      expect(result.format).toBe('xlsx');
      expect(result.includeLabels).toBe(false);
      expect(result.dateRange).toBeDefined();
    });

    it('should use defaults', () => {
      const minimalJob = {
        appId: 'app123',
      };

      const result = ExportDataJobSchema.parse(minimalJob);
      expect(result.format).toBe('csv');
      expect(result.includeLabels).toBe(true);
      expect(result.dateRange).toBeUndefined();
    });

    it('should validate datetime format', () => {
      expect(() => ExportDataJobSchema.parse({
        appId: 'app123',
        dateRange: {
          startDate: 'invalid-date',
          endDate: '2024-12-31T23:59:59Z'
        }
      })).toThrow();
    });
  });

  describe('JobResultSchema', () => {
    it('should validate a valid job result', () => {
      const validResult = {
        success: true,
        message: 'Job completed successfully',
        data: { reviewsProcessed: 100 },
        processingTime: 5000,
        itemsProcessed: 100,
      };

      const result = JobResultSchema.parse(validResult);
      expect(result.success).toBe(true);
      expect(result.message).toBe('Job completed successfully');
      expect(result.data?.reviewsProcessed).toBe(100);
    });

    it('should validate failed job result', () => {
      const failedResult = {
        success: false,
        error: 'Network timeout',
        processingTime: 30000,
        itemsProcessed: 0,
      };

      const result = JobResultSchema.parse(failedResult);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });
  });

  describe('QueueConfigSchema', () => {
    it('should validate a valid queue config', () => {
      const validConfig = {
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 5,
          backoff: {
            type: 'fixed' as const,
            delay: 1000,
          },
        },
        connection: {
          host: 'redis.example.com',
          port: 6380,
          password: 'secret',
          db: 1,
        },
      };

      const result = QueueConfigSchema.parse(validConfig);
      expect(result.connection.host).toBe('redis.example.com');
      expect(result.connection.port).toBe(6380);
      expect(result.defaultJobOptions.attempts).toBe(5);
    });

    it('should use defaults', () => {
      const minimalConfig = {};

      const result = QueueConfigSchema.parse(minimalConfig);
      expect(result.connection.host).toBe('localhost');
      expect(result.connection.port).toBe(6379);
      expect(result.defaultJobOptions.attempts).toBe(3);
      expect(result.defaultJobOptions.backoff.type).toBe('exponential');
    });
  });

  describe('Helper functions', () => {
    describe('getJobSchema', () => {
      it('should return correct schema for each job type', () => {
        expect(getJobSchema(JobTypes.SCRAPE_REVIEWS)).toBe(ScrapeReviewsJobSchema);
        expect(getJobSchema(JobTypes.LABEL_REVIEWS)).toBe(LabelReviewsJobSchema);
        expect(getJobSchema(JobTypes.PROCESS_RESULTS)).toBe(ProcessResultsJobSchema);
        expect(getJobSchema(JobTypes.CLEANUP_DATA)).toBe(CleanupDataJobSchema);
        expect(getJobSchema(JobTypes.EXPORT_DATA)).toBe(ExportDataJobSchema);
      });

      it('should throw for unknown job type', () => {
        expect(() => getJobSchema('unknown' as any)).toThrow('Unknown job type: unknown');
      });
    });

    describe('validateJobPayload', () => {
      it('should validate and return correct payload for scrape job', () => {
        const payload = { appId: '123' };
        const result = validateJobPayload(JobTypes.SCRAPE_REVIEWS, payload);
        
        expect(result.appId).toBe('123');
        expect(result.countries).toEqual(['us']); // Default
      });

      it('should throw for invalid payload', () => {
        expect(() => validateJobPayload(JobTypes.SCRAPE_REVIEWS, { appId: '' })).toThrow();
        expect(() => validateJobPayload(JobTypes.LABEL_REVIEWS, { reviewIds: [] })).toThrow();
      });
    });
  });
});