import { ScraperService } from './service.js';
import { Logger } from '@review-scraper/shared';

const logger = new Logger('ScraperMain');

// Example app IDs - these would typically come from configuration or API
const APP_IDS = ['737534985', '991473495', '1154059529', '349866256'];

/**
 * Main entry point for the queue-based scraper service
 * Can run in two modes:
 * 1. Worker mode (default): Starts worker to process jobs from queue
 * 2. Job creation mode: Adds jobs to queue and exits
 */
async function main() {
  const service = new ScraperService();
  
  try {
    // Initialize the service (database, queue, worker)
    await service.initialize();
    
    const mode = process.env['SCRAPER_MODE'] || 'worker';
    
    if (mode === 'create-jobs') {
      // Mode: Create jobs and exit
      logger.info('Running in job creation mode');
      
      const jobIds = await service.queueMultipleScrapingJobs(APP_IDS, {
        countries: ['us', 'gb', 'ca'], // Multiple countries
        pages: 5,
        sortMethods: ['recent', 'helpful'],
        throttleMs: 500,
      });
      
      logger.info(`Created ${jobIds.length} scraping jobs:`, jobIds);
      
      // Show queue status
      const stats = await service.getQueueStats();
      logger.info('Queue status:', stats);
      
      await service.shutdown();
      
    } else {
      // Mode: Run worker to process jobs (default)
      logger.info('Running in worker mode - processing jobs from queue');
      
      // Optional: Create some initial jobs if queue is empty
      const stats = await service.getQueueStats();
      if (stats.waiting === 0 && stats.active === 0) {
        logger.info('Queue is empty, adding sample jobs...');
        await service.queueMultipleScrapingJobs(APP_IDS.slice(0, 2), {
          countries: ['us'],
          pages: 3,
          sortMethods: ['recent'],
        });
      }
      
      // Setup graceful shutdown
      const shutdown = async () => {
        logger.info('Received shutdown signal, gracefully shutting down...');
        await service.shutdown();
        process.exit(0);
      };
      
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      
      // Log service status
      const health = await service.getHealthStatus();
      logger.info('Scraper service health:', {
        status: health.status,
        queueStats: stats,
      });
      
      logger.info('Scraper service is running. Press Ctrl+C to stop.');
      
      // Keep the process alive
      setInterval(async () => {
        try {
          const currentStats = await service.getQueueStats();
          if (currentStats.active > 0 || currentStats.waiting > 0) {
            logger.info('Queue activity:', {
              active: currentStats.active,
              waiting: currentStats.waiting,
              completed: currentStats.completed,
              failed: currentStats.failed,
            });
          }
        } catch (error) {
          logger.error('Error checking queue stats:', error);
        }
      }, 30000); // Check every 30 seconds
    }
    
  } catch (error) {
    logger.error('Failed to start scraper service:', error);
    
    try {
      await service.shutdown();
    } catch (shutdownError) {
      logger.error('Error during shutdown:', shutdownError);
    }
    
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Unhandled error in main:', error);
  process.exit(1);
});