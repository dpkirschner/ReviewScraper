import { getDatabasePool } from './pool.js';
import { DatabaseHealth } from './types.js';
import { Logger } from '../utils/logger.js';

export class DatabaseHealthChecker {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('DatabaseHealthChecker');
  }

  /**
   * Comprehensive health check including connectivity, performance, and pool metrics
   */
  async check(): Promise<DatabaseHealth> {
    try {
      const pool = getDatabasePool();
      return await pool.health();
    } catch (error) {
      this.logger.error('Database health check failed:', error);
      
      return {
        status: 'unhealthy',
        connectionCount: 0,
        idleConnectionCount: 0,
        waitingCount: 0,
        responseTime: 0,
        lastError: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Simple connectivity check - returns true if database is reachable
   */
  async isConnected(): Promise<boolean> {
    try {
      const health = await this.check();
      return health.status !== 'unhealthy';
    } catch {
      return false;
    }
  }

  /**
   * Check if database performance is acceptable
   */
  async isPerformant(maxResponseTime = 1000): Promise<boolean> {
    try {
      const health = await this.check();
      return health.responseTime <= maxResponseTime;
    } catch {
      return false;
    }
  }

  /**
   * Get detailed pool metrics for monitoring
   */
  async getPoolMetrics() {
    try {
      const pool = getDatabasePool();
      const health = await pool.health();
      const stats = pool.stats;

      return {
        ...health,
        poolStats: stats,
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error('Failed to get pool metrics:', error);
      return null;
    }
  }

  /**
   * Run database maintenance queries (analyze, vacuum, etc.)
   * Should be run periodically to maintain performance
   */
  async runMaintenance(): Promise<void> {
    try {
      const pool = getDatabasePool();
      
      // Update table statistics
      await pool.query('ANALYZE');
      
      this.logger.info('Database maintenance completed');
    } catch (error) {
      this.logger.error('Database maintenance failed:', error);
      throw error;
    }
  }
}

// Singleton instance
let healthChecker: DatabaseHealthChecker | null = null;

export function getDatabaseHealthChecker(): DatabaseHealthChecker {
  if (!healthChecker) {
    healthChecker = new DatabaseHealthChecker();
  }
  return healthChecker;
}