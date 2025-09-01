import { QueueFactory } from './factory.js';
import { QueueConnection } from './connection.js';
import { DeadLetterQueueManager } from './deadletter.js';
import { JobTypes, JobType } from './types.js';
import { Logger } from '../utils/index.js';

/**
 * Queue monitoring utilities for health checks and metrics
 */
export class QueueMonitor {
  private factory: QueueFactory;
  private connection: QueueConnection;
  private dlqManager: DeadLetterQueueManager;
  private logger: Logger;

  constructor(factory: QueueFactory, connection: QueueConnection) {
    this.factory = factory;
    this.connection = connection;
    this.dlqManager = new DeadLetterQueueManager(factory);
    this.logger = new Logger('QueueMonitor');
  }

  /**
   * Get comprehensive health status of all queue components
   */
  async getHealthStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: string;
    connection: {
      status: 'healthy' | 'degraded' | 'unhealthy';
      responseTime: number;
      error?: string;
    };
    queues: Record<string, {
      status: 'healthy' | 'degraded' | 'unhealthy';
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      paused: boolean;
    }>;
    deadLetterQueues: Record<string, {
      total: number;
      byFailureReason: Record<string, number>;
    }>;
    summary: {
      totalActiveJobs: number;
      totalWaitingJobs: number;
      totalFailedJobs: number;
      totalDLQJobs: number;
    };
  }> {
    const timestamp = new Date().toISOString();

    // Check connection health
    const connectionHealth = await this.connection.health();

    // Get all queue stats
    const queueStats = await this.factory.getAllQueueStats();
    const queues: Record<string, any> = {};
    
    let totalActiveJobs = 0;
    let totalWaitingJobs = 0;
    let totalFailedJobs = 0;

    for (const [jobType, stats] of Object.entries(queueStats)) {
      const queueStatus = stats.failed > 10 ? 'degraded' : 
                         stats.active === 0 && stats.waiting === 0 ? 'healthy' : 'healthy';
      
      queues[jobType] = {
        status: queueStatus,
        ...stats,
      };

      totalActiveJobs += stats.active;
      totalWaitingJobs += stats.waiting;
      totalFailedJobs += stats.failed;
    }

    // Get dead letter queue stats
    const deadLetterQueues: Record<string, any> = {};
    let totalDLQJobs = 0;

    for (const jobType of Object.values(JobTypes)) {
      try {
        const dlqStats = await this.dlqManager.getDLQStats(jobType);
        deadLetterQueues[jobType] = {
          total: dlqStats.total,
          byFailureReason: dlqStats.byFailureReason,
        };
        totalDLQJobs += dlqStats.total;
      } catch (error) {
        this.logger.warn(`Failed to get DLQ stats for ${jobType}:`, error);
        deadLetterQueues[jobType] = { total: 0, byFailureReason: {} };
      }
    }

    // Determine overall status
    const overallStatus = connectionHealth.status === 'unhealthy' || totalDLQJobs > 50 ? 'unhealthy' :
                         connectionHealth.status === 'degraded' || totalFailedJobs > 20 ? 'degraded' : 'healthy';

    return {
      status: overallStatus,
      timestamp,
      connection: connectionHealth,
      queues,
      deadLetterQueues,
      summary: {
        totalActiveJobs,
        totalWaitingJobs,
        totalFailedJobs,
        totalDLQJobs,
      },
    };
  }

  /**
   * Get performance metrics for monitoring dashboards
   */
  async getMetrics(): Promise<{
    timestamp: string;
    connection: {
      responseTime: number;
      status: string;
    };
    queues: Record<string, {
      jobs_waiting: number;
      jobs_active: number;
      jobs_completed: number;
      jobs_failed: number;
      jobs_delayed: number;
      queue_paused: boolean;
    }>;
    deadLetterQueues: Record<string, {
      dlq_total: number;
      dlq_recent_24h?: number;
    }>;
    system: {
      total_jobs_processed: number;
      total_jobs_failed: number;
      total_active_jobs: number;
      average_processing_time?: number;
    };
  }> {
    const timestamp = new Date().toISOString();
    
    const connectionHealth = await this.connection.health();
    const queueStats = await this.factory.getAllQueueStats();
    
    const queues: Record<string, any> = {};
    const deadLetterQueues: Record<string, any> = {};
    
    let totalJobsProcessed = 0;
    let totalJobsFailed = 0;
    let totalActiveJobs = 0;

    // Process queue metrics
    for (const [jobType, stats] of Object.entries(queueStats)) {
      queues[jobType] = {
        jobs_waiting: stats.waiting,
        jobs_active: stats.active,
        jobs_completed: stats.completed,
        jobs_failed: stats.failed,
        jobs_delayed: stats.delayed,
        queue_paused: stats.paused,
      };

      totalJobsProcessed += stats.completed;
      totalJobsFailed += stats.failed;
      totalActiveJobs += stats.active;
    }

    // Process DLQ metrics
    for (const jobType of Object.values(JobTypes)) {
      try {
        const dlqStats = await this.dlqManager.getDLQStats(jobType);
        deadLetterQueues[jobType] = {
          dlq_total: dlqStats.total,
        };
      } catch (error) {
        deadLetterQueues[jobType] = { dlq_total: 0 };
      }
    }

    return {
      timestamp,
      connection: {
        responseTime: connectionHealth.responseTime,
        status: connectionHealth.status,
      },
      queues,
      deadLetterQueues,
      system: {
        total_jobs_processed: totalJobsProcessed,
        total_jobs_failed: totalJobsFailed,
        total_active_jobs: totalActiveJobs,
      },
    };
  }

  /**
   * Get detailed information about a specific queue
   */
  async getQueueDetails(jobType: JobType): Promise<{
    jobType: string;
    stats: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      paused: boolean;
    };
    recentJobs: Array<{
      id: string;
      data: any;
      progress: number;
      createdAt?: string;
      processedOn?: string;
      finishedOn?: string;
      failedReason?: string;
    }>;
    deadLetterQueue: {
      total: number;
      byFailureReason: Record<string, number>;
      recentFailures: Array<{
        id: string;
        failureReason: string;
        failedAt: string;
      }>;
    };
  }> {
    const stats = await this.factory.getQueueStats(jobType);
    const queue = await this.factory.getQueue(jobType);
    
    // Get recent jobs from different states
    const [activeJobs, completedJobs, failedJobs] = await Promise.all([
      queue.getActive(0, 4), // Last 5 active jobs
      queue.getCompleted(0, 4), // Last 5 completed jobs  
      queue.getFailed(0, 4), // Last 5 failed jobs
    ]);

    const recentJobs = [...activeJobs, ...completedJobs, ...failedJobs]
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 10)
      .map(job => ({
        id: job.id?.toString() || '',
        data: job.data,
        progress: job.progress || 0,
        createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : undefined,
        processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
        finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
        failedReason: job.failedReason,
      }));

    // Get DLQ information
    const dlqStats = await this.dlqManager.getDLQStats(jobType);
    const dlqJobs = await this.dlqManager.getDeadLetterJobs(jobType, 0, 4);
    
    return {
      jobType,
      stats,
      recentJobs,
      deadLetterQueue: {
        total: dlqStats.total,
        byFailureReason: dlqStats.byFailureReason,
        recentFailures: dlqJobs.map(job => ({
          id: job.id?.toString() || '',
          failureReason: job.data.failureReason || 'Unknown',
          failedAt: job.data.failedAt || '',
        })),
      },
    };
  }

  /**
   * Simple health check endpoint suitable for load balancers
   */
  async getSimpleHealthCheck(): Promise<{
    status: 'ok' | 'error';
    timestamp: string;
    message?: string;
  }> {
    try {
      const connectionHealth = await this.connection.health();
      
      if (connectionHealth.status === 'unhealthy') {
        return {
          status: 'error',
          timestamp: new Date().toISOString(),
          message: connectionHealth.error || 'Redis connection unhealthy',
        };
      }

      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'error',
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get current queue processing statistics
   */
  async getProcessingStats(timeWindowMs: number = 60000): Promise<{
    processingRates: Record<string, {
      jobsPerMinute: number;
      averageProcessingTime: number;
      successRate: number;
    }>;
    systemLoad: {
      totalActiveWorkers: number;
      averageQueueDepth: number;
      oldestWaitingJob: string | null;
    };
  }> {
    const processingRates: Record<string, any> = {};
    let totalActiveWorkers = 0;
    let totalQueueDepth = 0;
    let queueCount = 0;
    let oldestWaitingJob: string | null = null;

    for (const jobType of Object.values(JobTypes)) {
      try {
        const stats = await this.factory.getQueueStats(jobType);
        const queue = await this.factory.getQueue(jobType);
        
        // Get waiting jobs to find oldest
        const waitingJobs = await queue.getWaiting(0, 0);
        if (waitingJobs.length > 0) {
          const oldest = waitingJobs[0];
          const oldestTime = oldest.timestamp ? new Date(oldest.timestamp).toISOString() : null;
          if (oldestTime && (!oldestWaitingJob || oldestTime < oldestWaitingJob)) {
            oldestWaitingJob = oldestTime;
          }
        }

        // Calculate basic rates (this could be enhanced with Redis metrics)
        const totalJobs = stats.completed + stats.failed;
        const successRate = totalJobs > 0 ? stats.completed / totalJobs : 1;
        
        processingRates[jobType] = {
          jobsPerMinute: Math.round((stats.completed + stats.failed) / (timeWindowMs / 60000)),
          averageProcessingTime: 0, // Could be calculated from job timestamps
          successRate: Math.round(successRate * 100) / 100,
        };

        totalActiveWorkers += stats.active;
        totalQueueDepth += stats.waiting;
        queueCount++;
      } catch (error) {
        this.logger.warn(`Failed to get processing stats for ${jobType}:`, error);
        processingRates[jobType] = {
          jobsPerMinute: 0,
          averageProcessingTime: 0,
          successRate: 0,
        };
      }
    }

    return {
      processingRates,
      systemLoad: {
        totalActiveWorkers,
        averageQueueDepth: queueCount > 0 ? Math.round(totalQueueDepth / queueCount) : 0,
        oldestWaitingJob,
      },
    };
  }

  /**
   * Get DLQ manager for advanced dead letter queue operations
   */
  getDeadLetterQueueManager(): DeadLetterQueueManager {
    return this.dlqManager;
  }
}