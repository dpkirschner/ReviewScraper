import store from 'app-store-scraper';
import { createObjectCsvWriter } from 'csv-writer';
import { join } from 'path';
import { Review, AppInfo, ScrapingConfig, Logger, sanitizeFilename } from '@review-scraper/shared';

export class ReviewScraper {
  private logger = new Logger('ReviewScraper');
  private config: ScrapingConfig = {
    countries: ['us', 'cn', 'jp', 'gb', 'kr', 'de', 'fr', 'ca', 'au', 'it', 'es', 'br', 'ru', 'in', 'mx'],
    numPages: 10,
    throttleMs: 500,
  };

  async scrapeReviews(appId: string): Promise<void> {
    this.logger.info(`Starting review scraping process for App ID: ${appId}`);
    this.logger.info(`Target Countries: ${this.config.countries.join(', ').toUpperCase()}`);
    this.logger.info(`Max Pages per Country: ${this.config.numPages}`);

    const appInfo = await this.getAppInfo(appId);
    const allReviews = new Map<string, Review>();

    const sortMethods = [store.sort.RECENT, store.sort.HELPFUL];
    
    for (const sortMethod of sortMethods) {
      const sortName = this.getSortMethodName(sortMethod);
      this.logger.info(`Processing Sort Method: ${sortName}`);
      
      for (const country of this.config.countries) {
        try {
          const reviews = await this.fetchReviewsForCountry(appId, country, sortMethod);
          reviews.forEach(review => allReviews.set(review.id, review));
          this.logger.info(`Finished processing ${country.toUpperCase()} (${sortName}). Total unique: ${allReviews.size}`);
        } catch (error) {
          this.logger.error(`Error processing country ${country.toUpperCase()}:`, error);
        }
      }
    }

    await this.saveReviewsToCsv(appInfo, Array.from(allReviews.values()));
  }

  private async getAppInfo(appId: string): Promise<AppInfo> {
    try {
      const primaryCountry = this.config.countries[0] || 'us';
      this.logger.info(`Fetching app data using country ${primaryCountry.toUpperCase()}`);
      
      const appData = await store.app({ id: appId, country: primaryCountry });
      
      return {
        id: appId,
        title: appData.title || 'Unknown App',
        description: appData.description,
        version: appData.version,
        developer: appData.developer,
        category: appData.genre,
      };
    } catch (error) {
      this.logger.warn('Could not fetch app data, using defaults:', error);
      return {
        id: appId,
        title: 'Unknown App',
      };
    }
  }

  private async fetchReviewsForCountry(
    appId: string,
    countryCode: string,
    sortMethod: number
  ): Promise<Review[]> {
    const sortName = this.getSortMethodName(sortMethod);
    this.logger.info(`Fetching reviews for ${countryCode.toUpperCase()} (${sortName})`);

    const allReviews: Review[] = [];
    const pagesToFetch = Math.min(this.config.numPages, 10);

    for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
      try {
        const reviews = await store.reviews({
          id: appId,
          country: countryCode,
          page: pageNum,
          sort: sortMethod,
          throttle: this.config.throttleMs,
        });

        if (reviews.length === 0) {
          this.logger.info(`No more reviews found on page ${pageNum}, stopping`);
          break;
        }

        const processedReviews = reviews.map((review: any): Review => ({
          id: review.id,
          userName: review.userName || 'Anonymous',
          userUrl: review.userUrl,
          version: review.version || 'Unknown',
          score: review.score,
          title: review.title || '',
          text: review.text || '',
          url: review.url,
          date: new Date(review.date),
          replyDate: review.replyDate ? new Date(review.replyDate) : undefined,
          replyText: review.replyText,
          helpfulVotes: review.helpfulVotes || 0,
          country: countryCode.toUpperCase(),
        }));

        allReviews.push(...processedReviews);
        this.logger.info(`Fetched ${reviews.length} reviews from page ${pageNum}`);

      } catch (error) {
        this.logger.error(`Error fetching page ${pageNum}:`, error);
        break;
      }
    }

    return allReviews;
  }

  private getSortMethodName(sortMethod: number): string {
    const sortNames: Record<number, string> = {
      [store.sort.RECENT]: 'RECENT',
      [store.sort.HELPFUL]: 'HELPFUL',
    };
    return sortNames[sortMethod] || 'UNKNOWN';
  }

  private async saveReviewsToCsv(appInfo: AppInfo, reviews: Review[]): Promise<void> {
    if (reviews.length === 0) {
      this.logger.warn('No reviews to save');
      return;
    }

    const safeAppTitle = sanitizeFilename(appInfo.title);
    const csvFilename = `${safeAppTitle}_ALL_SORTED_reviews.csv`;
    const csvPath = join(process.cwd(), csvFilename);

    this.logger.info(`Saving ${reviews.length} reviews to: ${csvPath}`);

    const csvWriter = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: 'id', title: 'Review ID' },
        { id: 'country', title: 'Country' },
        { id: 'userName', title: 'User Name' },
        { id: 'userUrl', title: 'User URL' },
        { id: 'version', title: 'App Version' },
        { id: 'score', title: 'Rating' },
        { id: 'title', title: 'Review Title' },
        { id: 'text', title: 'Review Text' },
        { id: 'url', title: 'Review URL' },
        { id: 'date', title: 'Review Date' },
        { id: 'replyDate', title: 'Developer Reply Date' },
        { id: 'replyText', title: 'Developer Reply Text' },
        { id: 'helpfulVotes', title: 'Helpful Votes' },
      ],
    });

    try {
      await csvWriter.writeRecords(reviews);
      this.logger.info(`Successfully saved ${reviews.length} reviews to ${csvPath}`);
    } catch (error) {
      this.logger.error(`Error writing CSV file:`, error);
      throw error;
    }
  }
}