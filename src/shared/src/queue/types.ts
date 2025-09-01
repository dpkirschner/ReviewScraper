import { z } from 'zod';

/**
 * Enum-like object defining all available job types in the system
 */
export const JobTypes = {
  SCRAPE_REVIEWS: 'scrape_reviews',
  LABEL_REVIEWS: 'label_reviews', 
  PROCESS_RESULTS: 'process_results',
  CLEANUP_DATA: 'cleanup_data',
  EXPORT_DATA: 'export_data',
} as const;

export type JobType = typeof JobTypes[keyof typeof JobTypes];

/**
 * Base job configuration that all jobs inherit
 */
export const BaseJobConfigSchema = z.object({
  priority: z.number().int().min(1).max(10).default(5),
  retryAttempts: z.number().int().min(0).max(5).default(3),
  delay: z.number().int().min(0).default(0), // Delay in milliseconds before processing
});

export type BaseJobConfig = z.infer<typeof BaseJobConfigSchema>;

/**
 * Job payload for scraping reviews from app stores
 */
export const ScrapeReviewsJobSchema = z.object({
  appId: z.string().min(1, 'App ID is required'),
  countries: z.array(z.string().length(2, 'Country codes must be 2 characters')).min(1).default(['us']),
  pages: z.number().int().min(1).max(10).default(5),
  sortMethods: z.array(z.enum(['recent', 'helpful'])).min(1).default(['recent']),
  throttleMs: z.number().int().min(0).max(5000).default(500),
  correlationId: z.string().uuid().optional(),
}).merge(BaseJobConfigSchema);

export type ScrapeReviewsJob = z.infer<typeof ScrapeReviewsJobSchema>;

/**
 * Job payload for labeling reviews with sentiment analysis
 */
export const LabelReviewsJobSchema = z.object({
  reviewIds: z.array(z.string().min(1)).min(1, 'At least one review ID is required'),
  batchSize: z.number().int().min(1).max(100).default(20),
  model: z.string().default('gpt-4.1-mini'),
  taxonomyPath: z.string().optional(),
  correlationId: z.string().uuid().optional(),
}).merge(BaseJobConfigSchema);

export type LabelReviewsJob = z.infer<typeof LabelReviewsJobSchema>;

/**
 * Job payload for processing and storing results
 */
export const ProcessResultsJobSchema = z.object({
  sourceJobId: z.string().min(1, 'Source job ID is required'),
  resultType: z.enum(['scraped_reviews', 'labeled_reviews', 'exported_data']),
  outputFormat: z.enum(['csv', 'json', 'database']).default('database'),
  correlationId: z.string().uuid().optional(),
}).merge(BaseJobConfigSchema);

export type ProcessResultsJob = z.infer<typeof ProcessResultsJobSchema>;

/**
 * Job payload for data cleanup operations
 */
export const CleanupDataJobSchema = z.object({
  targetType: z.enum(['old_reviews', 'failed_jobs', 'temp_files']),
  olderThanDays: z.number().int().min(1).default(30),
  dryRun: z.boolean().default(false),
  correlationId: z.string().uuid().optional(),
}).merge(BaseJobConfigSchema);

export type CleanupDataJob = z.infer<typeof CleanupDataJobSchema>;

/**
 * Job payload for data export operations
 */
export const ExportDataJobSchema = z.object({
  appId: z.string().min(1, 'App ID is required'),
  format: z.enum(['csv', 'json', 'xlsx']).default('csv'),
  includeLabels: z.boolean().default(true),
  dateRange: z.object({
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
  }).optional(),
  correlationId: z.string().uuid().optional(),
}).merge(BaseJobConfigSchema);

export type ExportDataJob = z.infer<typeof ExportDataJobSchema>;

/**
 * Union type for all job payloads
 */
export type JobPayload = 
  | ScrapeReviewsJob
  | LabelReviewsJob
  | ProcessResultsJob
  | CleanupDataJob
  | ExportDataJob;

/**
 * Job result types
 */
export const JobResultSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  data: z.record(z.any()).optional(),
  error: z.string().optional(),
  processingTime: z.number().int().min(0).optional(),
  itemsProcessed: z.number().int().min(0).optional(),
});

export type JobResult = z.infer<typeof JobResultSchema>;

/**
 * Queue configuration options
 */
export const QueueConfigSchema = z.object({
  defaultJobOptions: z.object({
    removeOnComplete: z.number().int().min(0).default(50),
    removeOnFail: z.number().int().min(0).default(100),
    attempts: z.number().int().min(1).max(10).default(3),
    backoff: z.object({
      type: z.enum(['fixed', 'exponential']).default('exponential'),
      delay: z.number().int().min(100).default(2000),
    }).default({}),
  }).default({}),
  connection: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().min(1).max(65535).default(6379),
    password: z.string().optional(),
    db: z.number().int().min(0).max(15).default(0),
    maxRetriesPerRequest: z.number().int().min(0).default(3),
    retryDelayOnFailover: z.number().int().min(100).default(100),
    lazyConnect: z.boolean().default(true),
  }).default({}),
});

export type QueueConfig = z.infer<typeof QueueConfigSchema>;

/**
 * Helper function to get job schema by job type
 */
export function getJobSchema(jobType: JobType): z.ZodSchema {
  switch (jobType) {
    case JobTypes.SCRAPE_REVIEWS:
      return ScrapeReviewsJobSchema;
    case JobTypes.LABEL_REVIEWS:
      return LabelReviewsJobSchema;
    case JobTypes.PROCESS_RESULTS:
      return ProcessResultsJobSchema;
    case JobTypes.CLEANUP_DATA:
      return CleanupDataJobSchema;
    case JobTypes.EXPORT_DATA:
      return ExportDataJobSchema;
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}

/**
 * Helper function to validate job payload
 */
export function validateJobPayload<T extends JobType>(
  jobType: T,
  payload: unknown
): JobPayload {
  const schema = getJobSchema(jobType);
  return schema.parse(payload);
}