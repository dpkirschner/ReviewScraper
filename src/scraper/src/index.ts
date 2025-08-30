import { ReviewScraper } from './scraper.js';
import { env } from '@review-scraper/shared';

const APP_IDS = ['737534985', '991473495', '1154059529', '349866256'];

async function main() {
  const scraper = new ReviewScraper();
  
  for (const appId of APP_IDS) {
    await scraper.scrapeReviews(appId);
  }
}

main().catch(console.error);