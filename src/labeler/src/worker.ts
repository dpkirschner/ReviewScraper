import { Job } from 'bullmq';
import { 
  JobTypes, 
  LabelReviewsJob, 
  JobResult,
  Logger,
  getDatabasePool,
  DatabasePool,
  Review
} from '@review-scraper/shared';
import { ReviewLabeler, LabelResult } from './labeler.js';

/**
 * Worker-based labeler that processes LABEL_REVIEWS jobs from the queue
 * Integrates the ReviewLabeler with the BullMQ queue system
 */
export class LabelerWorker {
  private logger: Logger;
  private db: DatabasePool;
  private labeler: ReviewLabeler;

  constructor() {
    this.logger = new Logger('LabelerWorker');
    this.db = getDatabasePool();
    
    // Initialize the labeler with OpenAI API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    
    this.labeler = new ReviewLabeler({ apiKey });
  }

  /**
   * Process a single LABEL_REVIEWS job
   * This is the main worker processor function
   */
  async processLabelingJob(job: Job<LabelReviewsJob>): Promise<JobResult> {
    const startTime = Date.now();
    const { reviewIds, batchSize, model, correlationId } = job.data;

    this.logger.info(`Starting labeling job ${job.id}`, {
      reviewCount: reviewIds.length,
      batchSize,
      model,
      correlationId,
    });

    try {
      // Update job progress: Starting
      await job.updateProgress(10);

      // Fetch reviews from database
      const reviews = await this.fetchReviewsByIds(reviewIds);
      if (reviews.length === 0) {
        throw new Error(`No reviews found for provided IDs: ${reviewIds.slice(0, 5).join(', ')}...`);
      }

      await job.updateProgress(20);
      
      this.logger.info(`Found ${reviews.length}/${reviewIds.length} reviews to label`);

      // Process reviews with sentiment analysis
      const labelResults = await this.labeler.labelReviews(reviews, {
        batchSize: batchSize || 20,
        model: model || 'gpt-4o-mini',
      });

      await job.updateProgress(80);

      // Save results to database
      await this.labeler.saveLabelResults(labelResults);
      await job.updateProgress(95);

      // Job completed successfully
      await job.updateProgress(100);

      const processingTime = Date.now() - startTime;
      const result: JobResult = {
        success: true,
        message: `Successfully labeled ${labelResults.length} reviews`,
        data: {
          reviewsProcessed: labelResults.length,
          model: model || 'gpt-4o-mini',
          averageConfidence: this.calculateAverageConfidence(labelResults),
          sentimentBreakdown: this.getSentimentBreakdown(labelResults),
          correlationId,
        },
        processingTime,
        itemsProcessed: labelResults.length,
      };

      this.logger.info(`Completed labeling job ${job.id}`, result.data);
      return result;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.logger.error(`Labeling job ${job.id} failed:`, error);
      
      const result: JobResult = {
        success: false,
        error: errorMessage,
        data: { 
          reviewIds: reviewIds.slice(0, 10), // First 10 IDs for debugging
          correlationId 
        },
        processingTime,
        itemsProcessed: 0,
      };

      return result;
    }
  }

  /**
   * Fetch reviews from database by their IDs
   */
  private async fetchReviewsByIds(reviewIds: string[]): Promise<Review[]> {
    if (reviewIds.length === 0) {
      return [];
    }

    try {
      // Create placeholders for parameterized query
      const placeholders = reviewIds.map((_, i) => `$${i + 1}`).join(', ');
      
      const result = await this.db.query(`
        SELECT * FROM reviews 
        WHERE id IN (${placeholders})
        ORDER BY created_at DESC
      `, reviewIds);

      return result.rows.map(row => ({
        id: row.id,
        userName: row.user_name,
        userUrl: row.user_url,
        version: row.version,
        score: row.score,
        title: row.title,
        text: row.text,
        url: row.url,
        date: row.date,
        replyDate: row.reply_date,
        replyText: row.reply_text,
        helpfulVotes: row.helpful_votes,
        country: row.country,
      }));
    } catch (error) {
      this.logger.error('Failed to fetch reviews by IDs:', error);
      throw error;
    }
  }

  /**
   * Calculate average confidence score
   */
  private calculateAverageConfidence(results: LabelResult[]): number {
    if (results.length === 0) return 0;
    
    const total = results.reduce((sum, result) => sum + result.confidence, 0);
    return Math.round((total / results.length) * 100) / 100;
  }

  /**
   * Get sentiment distribution breakdown
   */
  private getSentimentBreakdown(results: LabelResult[]): Record<string, number> {
    const breakdown = { positive: 0, neutral: 0, negative: 0 };
    
    results.forEach(result => {
      breakdown[result.sentiment]++;
    });
    
    return breakdown;
  }

  /**
   * Process unlabeled reviews (for batch processing mode)
   */
  async processUnlabeledReviews(limit: number = 100): Promise<JobResult> {
    const startTime = Date.now();
    
    try {
      this.logger.info(`Processing up to ${limit} unlabeled reviews`);
      
      // Get unlabeled reviews
      const reviews = await this.labeler.getUnlabeledReviews(limit);
      
      if (reviews.length === 0) {
        return {
          success: true,
          message: 'No unlabeled reviews found',
          data: { reviewsProcessed: 0 },
          processingTime: Date.now() - startTime,
          itemsProcessed: 0,
        };
      }

      // Process with sentiment analysis
      const labelResults = await this.labeler.labelReviews(reviews);
      
      // Save to database
      await this.labeler.saveLabelResults(labelResults);

      const result: JobResult = {
        success: true,
        message: `Successfully labeled ${labelResults.length} previously unlabeled reviews`,
        data: {
          reviewsProcessed: labelResults.length,
          averageConfidence: this.calculateAverageConfidence(labelResults),
          sentimentBreakdown: this.getSentimentBreakdown(labelResults),
        },
        processingTime: Date.now() - startTime,
        itemsProcessed: labelResults.length,
      };

      this.logger.info('Completed processing unlabeled reviews', result.data);
      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to process unlabeled reviews:', error);
      
      return {
        success: false,
        error: errorMessage,
        processingTime: Date.now() - startTime,
        itemsProcessed: 0,
      };
    }
  }

  /**
   * Get worker concurrency settings based on environment
   */
  static getWorkerConfig() {
    const env = process.env.NODE_ENV || 'development';
    
    return {
      concurrency: env === 'production' ? 2 : 1, // Fewer concurrent workers for API rate limits
      limiter: {
        max: 5, // Max 5 jobs per duration (OpenAI API rate limiting)
        duration: 60000, // 1 minute
      },
    };
  }
}