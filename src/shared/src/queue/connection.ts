import { Redis as IORedis } from 'ioredis';
import type { Redis } from 'ioredis';
import { Logger } from '../utils/index.js';
import { QueueConfig, QueueConfigSchema } from './types.js';

/**
 * Redis connection manager for queue operations
 * Handles connection pooling, retries, and health monitoring
 */
export class QueueConnection {
  private redis: Redis | null = null;
  private config: QueueConfig;
  private logger: Logger;
  private isConnecting = false;
  private connectionPromise: Promise<Redis> | null = null;

  constructor(config: Partial<QueueConfig> = {}) {
    // Parse Redis URL if provided, otherwise use individual config
    const redisUrl = process.env['REDIS_URL'];
    if (redisUrl) {
      this.config = this.parseRedisUrl(redisUrl, config);
    } else {
      this.config = QueueConfigSchema.parse({
        connection: {
          host: process.env['REDIS_HOST'] || 'localhost',
          port: process.env['REDIS_PORT'] ? parseInt(process.env['REDIS_PORT']) : 6379,
          password: process.env['REDIS_PASSWORD'],
          db: process.env['REDIS_DB'] ? parseInt(process.env['REDIS_DB']) : 0,
          ...config.connection,
        },
        defaultJobOptions: config.defaultJobOptions || {},
      });
    }

    this.logger = new Logger('QueueConnection');
  }

  private parseRedisUrl(url: string, overrides: Partial<QueueConfig>): QueueConfig {
    const parsed = new URL(url);
    
    const connectionConfig = {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : 6379,
      password: parsed.password || undefined,
      db: parsed.pathname && parsed.pathname.length > 1 
        ? parseInt(parsed.pathname.slice(1)) 
        : 0,
    };

    return QueueConfigSchema.parse({
      connection: { ...connectionConfig, ...overrides.connection },
      defaultJobOptions: overrides.defaultJobOptions,
    });
  }

  /**
   * Initialize Redis connection with retry logic
   */
  async connect(): Promise<Redis> {
    if (this.redis && this.redis.status === 'ready') {
      return this.redis;
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.connectionPromise = this.createConnection();

    try {
      this.redis = await this.connectionPromise;
      this.isConnecting = false;
      return this.redis;
    } catch (error) {
      this.isConnecting = false;
      this.connectionPromise = null;
      throw error;
    }
  }

  private async createConnection(): Promise<Redis> {
    const connectionConfig = {
      host: this.config.connection.host,
      port: this.config.connection.port,
      password: this.config.connection.password,
      db: this.config.connection.db,
      maxRetriesPerRequest: this.config.connection.maxRetriesPerRequest,
      retryDelayOnFailover: this.config.connection.retryDelayOnFailover,
      lazyConnect: this.config.connection.lazyConnect,
      maxmemoryPolicy: 'allkeys-lru', // Ensure Redis evicts keys when memory is full
    };

    this.logger.info('Creating Redis connection', {
      host: connectionConfig.host,
      port: connectionConfig.port,
      db: connectionConfig.db,
    });

    const redis = new IORedis(connectionConfig);

    // Set up event handlers
    redis.on('connect', () => {
      this.logger.info('Redis connected');
    });

    redis.on('ready', () => {
      this.logger.info('Redis ready for operations');
    });

    redis.on('error', (error: Error) => {
      this.logger.error('Redis connection error:', error);
    });

    redis.on('close', () => {
      this.logger.warn('Redis connection closed');
    });

    redis.on('reconnecting', (delay: number) => {
      this.logger.info(`Redis reconnecting in ${delay}ms`);
    });

    redis.on('end', () => {
      this.logger.warn('Redis connection ended');
    });

    // Test connection if not lazy
    if (!this.config.connection.lazyConnect) {
      try {
        await redis.ping();
        this.logger.info('Redis connection test successful');
      } catch (error) {
        this.logger.error('Redis connection test failed:', error);
        await redis.quit();
        throw error;
      }
    }

    return redis;
  }

  /**
   * Get the Redis instance, connecting if necessary
   */
  async getConnection(): Promise<Redis> {
    if (!this.redis || this.redis.status !== 'ready') {
      return await this.connect();
    }
    return this.redis;
  }

  /**
   * Health check for the Redis connection
   */
  async health(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    responseTime: number;
    error?: string;
  }> {
    const startTime = Date.now();
    
    try {
      if (!this.redis || this.redis.status !== 'ready') {
        return {
          status: 'unhealthy',
          responseTime: Date.now() - startTime,
          error: 'Redis not connected',
        };
      }

      // Test with ping
      await this.redis.ping();
      const responseTime = Date.now() - startTime;

      return {
        status: responseTime > 100 ? 'degraded' : 'healthy',
        responseTime,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get connection statistics
   */
  getStats() {
    if (!this.redis) {
      return null;
    }

    return {
      status: this.redis.status,
      options: {
        host: this.redis.options.host,
        port: this.redis.options.port,
        db: this.redis.options.db,
      },
    };
  }

  /**
   * Close the Redis connection
   */
  async close(): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      await this.redis.quit();
      this.redis = null;
      this.connectionPromise = null;
      this.logger.info('Redis connection closed');
    } catch (error) {
      this.logger.error('Error closing Redis connection:', error);
      // Force close if graceful quit fails
      if (this.redis) {
        this.redis.disconnect();
        this.redis = null;
      }
      throw error;
    }
  }

  get isConnected(): boolean {
    return this.redis !== null && this.redis.status === 'ready';
  }

  get connectionConfig(): QueueConfig {
    return this.config;
  }
}

// Singleton instance for the application
let globalConnection: QueueConnection | null = null;

/**
 * Create the global queue connection instance
 */
export function createQueueConnection(config?: Partial<QueueConfig>): QueueConnection {
  if (globalConnection) {
    throw new Error('Queue connection already exists. Use getQueueConnection() to get the existing instance.');
  }
  
  globalConnection = new QueueConnection(config);
  return globalConnection;
}

/**
 * Get the global queue connection instance
 */
export function getQueueConnection(): QueueConnection {
  if (!globalConnection) {
    throw new Error('Queue connection not initialized. Call createQueueConnection() first.');
  }
  
  return globalConnection;
}

/**
 * Close and cleanup the global queue connection
 */
export async function closeQueueConnection(): Promise<void> {
  if (globalConnection) {
    await globalConnection.close();
    globalConnection = null;
  }
}