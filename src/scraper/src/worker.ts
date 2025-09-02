import store from 'app-store-scraper';
import { Job } from 'bullmq';
import { 
  JobTypes, 
  ScrapeReviewsJob, 
  JobResult,
  Review, 
  AppInfo,
  Logger,
  getDatabasePool,
  DatabasePool
} from '@review-scraper/shared';

/**
 * Worker-based scraper that processes SCRAPE_REVIEWS jobs from the queue
 * Transforms the existing direct scraper logic into job-based processing
 */
export class ScraperWorker {
  private logger: Logger;
  private db: DatabasePool;

  constructor() {
    this.logger = new Logger('ScraperWorker');
    this.db = getDatabasePool();
  }

  /**
   * Process a single SCRAPE_REVIEWS job
   * This is the main worker processor function
   */
  async processScrapingJob(job: Job<ScrapeReviewsJob>): Promise<JobResult> {
    const startTime = Date.now();
    const { appId, countries, pages, sortMethods, throttleMs, correlationId } = job.data;

    this.logger.info(`Starting scraping job ${job.id}`, {
      appId,
      countries,
      pages,
      sortMethods,
      correlationId,
    });

    try {
      // Update job progress: Starting
      await job.updateProgress(10);

      // Get app information first
      const appInfo = await this.getAppInfo(appId, countries[0] || 'us');
      await job.updateProgress(20);

      // Ensure app exists in database
      await this.ensureAppInDatabase(appInfo);
      await job.updateProgress(30);

      // Process each sort method and country combination
      const allReviews = new Map<string, Review>();
      const totalCombinations = sortMethods.length * countries.length;
      let completedCombinations = 0;

      const sortMethodMap = {
        'recent': store.sort.RECENT,
        'helpful': store.sort.HELPFUL,
      };

      for (const sortMethodName of sortMethods) {
        const sortMethod = sortMethodMap[sortMethodName as keyof typeof sortMethodMap];
        
        for (const country of countries) {
          try {
            this.logger.info(`Processing ${country.toUpperCase()} (${sortMethodName}) for app ${appId}`);
            
            const reviews = await this.fetchReviewsForCountry(
              appId, 
              country, 
              sortMethod, 
              pages,
              throttleMs || 500,
              job
            );

            // Add to unique review collection
            reviews.forEach(review => allReviews.set(review.id, review));
            
            completedCombinations++;
            const progress = 30 + (completedCombinations / totalCombinations) * 60; // 30-90% for scraping
            await job.updateProgress(Math.round(progress));

            this.logger.info(`Finished ${country.toUpperCase()} (${sortMethodName}). Total unique: ${allReviews.size}`);
          } catch (error) {
            this.logger.error(`Error processing country ${country.toUpperCase()} (${sortMethodName}):`, error);
            // Continue with other countries/methods instead of failing the entire job
          }
        }
      }

      // Save reviews to database
      const reviewsToSave = Array.from(allReviews.values());
      if (reviewsToSave.length > 0) {
        await this.saveReviewsToDatabase(appInfo.id, reviewsToSave);
        await job.updateProgress(95);
      }

      // Job completed successfully
      await job.updateProgress(100);

      const processingTime = Date.now() - startTime;
      const result: JobResult = {
        success: true,
        message: `Successfully scraped ${reviewsToSave.length} unique reviews for app ${appId}`,
        data: {
          appId,
          appTitle: appInfo.title,
          reviewsScraped: reviewsToSave.length,
          countriesProcessed: countries.length,
          sortMethodsUsed: sortMethods.length,
        },
        processingTime,
        itemsProcessed: reviewsToSave.length,
      };

      this.logger.info(`Completed scraping job ${job.id}`, result.data);
      return result;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.logger.error(`Scraping job ${job.id} failed:`, error);
      
      const result: JobResult = {
        success: false,
        error: errorMessage,
        data: { appId },
        processingTime,
        itemsProcessed: 0,
      };

      return result;
    }
  }

  /**
   * Get app information from app store
   * Reused from original scraper with error handling improvements
   */
  private async getAppInfo(appId: string, country: string = 'us'): Promise<AppInfo> {
    try {
      this.logger.info(`Fetching app data for ${appId} using country ${country.toUpperCase()}`);
      
      const appData = await store.app({ id: appId, country });
      
      return {
        id: appId,
        title: appData.title || 'Unknown App',
        description: appData.description || null,
        version: appData.version || null,
        developer: appData.developer || null,
        category: appData.genre || null,
      };
    } catch (error) {
      this.logger.warn(`Could not fetch app data for ${appId}, using defaults:`, error);
      return {
        id: appId,
        title: 'Unknown App',
        description: null,
        version: null,
        developer: null,
        category: null,
      };
    }
  }

  /**
   * Ensure app exists in database, create if necessary
   */
  private async ensureAppInDatabase(appInfo: AppInfo): Promise<void> {
    try {
      // Check if app already exists
      const existingApp = await this.db.query(
        'SELECT id FROM apps WHERE id = $1',
        [appInfo.id]
      );

      if (existingApp.rows.length === 0) {
        // Insert new app
        await this.db.query(`
          INSERT INTO apps (id, title, description, version, developer, category, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            version = EXCLUDED.version,
            developer = EXCLUDED.developer,
            category = EXCLUDED.category,
            updated_at = NOW()
        `, [appInfo.id, appInfo.title, appInfo.description, appInfo.version, appInfo.developer, appInfo.category]);

        this.logger.info(`Created/updated app record for ${appInfo.id}: ${appInfo.title}`);
      }
    } catch (error) {
      this.logger.error(`Failed to ensure app ${appInfo.id} in database:`, error);
      throw error;
    }
  }

  /**
   * Fetch reviews for a specific country and sort method
   * Enhanced with job progress reporting
   */
  private async fetchReviewsForCountry(
    appId: string,
    countryCode: string,
    sortMethod: number,
    maxPages: number,
    throttleMs: number,
    job: Job
  ): Promise<Review[]> {
    const sortName = this.getSortMethodName(sortMethod);
    this.logger.info(`Fetching reviews for ${countryCode.toUpperCase()} (${sortName})`);

    const allReviews: Review[] = [];
    const pagesToFetch = Math.min(maxPages, 10); // Safety limit

    for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
      try {
        const reviews = await store.reviews({
          id: appId,
          country: countryCode,
          page: pageNum,
          sort: sortMethod,
          throttle: throttleMs,
        });

        if (reviews.length === 0) {
          this.logger.info(`No more reviews found on page ${pageNum} for ${countryCode.toUpperCase()}, stopping`);
          break;
        }

        const processedReviews = reviews.map((review: any): Review => ({
          id: review.id,
          userName: review.userName || 'Anonymous',
          userUrl: review.userUrl || null,
          version: review.version || 'Unknown',
          score: review.score,
          title: review.title || '',
          text: review.text || '',
          url: review.url || null,
          date: new Date(review.date),
          replyDate: review.replyDate ? new Date(review.replyDate) : null,
          replyText: review.replyText || null,
          helpfulVotes: review.helpfulVotes || 0,
          country: countryCode.toUpperCase(),
        }));

        allReviews.push(...processedReviews);
        this.logger.debug(`Fetched ${reviews.length} reviews from page ${pageNum} for ${countryCode.toUpperCase()}`);

        // Small delay between pages to be respectful
        if (pageNum < pagesToFetch && throttleMs > 0) {
          await new Promise(resolve => setTimeout(resolve, throttleMs));
        }

      } catch (error) {
        this.logger.error(`Error fetching page ${pageNum} for ${countryCode.toUpperCase()}:`, error);
        break; // Stop processing this country on error
      }
    }

    return allReviews;
  }

  /**
   * Save reviews to database instead of CSV
   * This replaces the CSV saving with database persistence
   */
  private async saveReviewsToDatabase(appId: string, reviews: Review[]): Promise<void> {
    if (reviews.length === 0) {
      this.logger.warn(`No reviews to save for app ${appId}`);
      return;
    }

    this.logger.info(`Saving ${reviews.length} reviews to database for app ${appId}`);

    try {
      // Insert reviews in batches to avoid memory issues
      const batchSize = 50;
      let savedCount = 0;

      for (let i = 0; i < reviews.length; i += batchSize) {
        const batch = reviews.slice(i, i + batchSize);
        
        for (const review of batch) {
          try {
            await this.db.query(`
              INSERT INTO reviews (
                id, app_id, user_name, user_url, version, score, title, text, 
                url, date, reply_date, reply_text, helpful_votes, country, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
              ON CONFLICT (id) DO UPDATE SET
                score = EXCLUDED.score,
                title = EXCLUDED.title,
                text = EXCLUDED.text,
                helpful_votes = EXCLUDED.helpful_votes,
                updated_at = NOW()
            `, [
              review.id,
              appId,
              review.userName,
              review.userUrl,
              review.version,
              review.score,
              review.title,
              review.text,
              review.url,
              review.date,
              review.replyDate,
              review.replyText,
              review.helpfulVotes,
              review.country
            ]);
            savedCount++;
          } catch (error) {
            this.logger.error(`Failed to save review ${review.id}:`, error);
            // Continue with other reviews
          }
        }

        this.logger.debug(`Saved batch of ${batch.length} reviews (${savedCount}/${reviews.length} total)`);
      }

      this.logger.info(`Successfully saved ${savedCount} reviews to database for app ${appId}`);
    } catch (error) {
      this.logger.error(`Error saving reviews to database for app ${appId}:`, error);
      throw error;
    }
  }

  /**
   * Helper method to get human-readable sort method name
   */
  private getSortMethodName(sortMethod: number): string {
    const sortNames: Record<number, string> = {
      [store.sort.RECENT]: 'RECENT',
      [store.sort.HELPFUL]: 'HELPFUL',
    };
    return sortNames[sortMethod] || 'UNKNOWN';
  }

  /**
   * Get worker concurrency settings based on environment
   */
  static getWorkerConfig() {
    const env = process.env.NODE_ENV || 'development';
    
    return {
      concurrency: env === 'production' ? 3 : 1, // More concurrent workers in production
      limiter: {
        max: 10, // Max 10 jobs per duration
        duration: 60000, // 1 minute
      },
    };
  }
}