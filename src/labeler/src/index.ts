import { LabelerService } from './service.js';
import { Logger } from '@review-scraper/shared';

const logger = new Logger('LabelerMain');

/**
 * Main entry point for the queue-based labeler service
 * Can run in two modes:
 * 1. Worker mode (default): Starts worker to process jobs from queue
 * 2. Job creation mode: Adds jobs to queue for unlabeled reviews
 */
async function main() {
  const service = new LabelerService();
  
  try {
    // Initialize the service (database, queue, worker)
    await service.initialize();
    
    const mode = process.env['LABELER_MODE'] || 'worker';
    
    if (mode === 'process-unlabeled') {
      // Mode: Find and process unlabeled reviews
      logger.info('Running in batch processing mode for unlabeled reviews');
      
      // Get unlabeled reviews and create labeling jobs
      const worker = service.getQueueWorker();
      const result = await worker['labelerWorker'].processUnlabeledReviews(200); // Process up to 200 unlabeled reviews
      
      logger.info('Batch processing result:', result);
      
      // Show queue status
      const stats = await service.getQueueStats();
      logger.info('Queue status:', stats);
      
      await service.shutdown();
      
    } else {
      // Mode: Run worker to process jobs (default)
      logger.info('Running in worker mode - processing labeling jobs from queue');
      
      // Check queue status
      const stats = await service.getQueueStats();
      logger.info('Initial queue status:', {
        waiting: stats.waiting,
        active: stats.active,
        completed: stats.completed,
        failed: stats.failed,
      });
      
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
      logger.info('Labeler service health:', {
        status: health.status,
        worker: health.worker,
        workerHealth: health.workerHealth,
      });
      
      logger.info('Labeler service is running. Press Ctrl+C to stop.');
      
      // Keep the process alive and log periodic stats
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
    logger.error('Failed to start labeler service:', error);
    
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