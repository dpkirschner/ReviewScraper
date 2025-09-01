import { Pool, PoolClient, PoolConfig } from 'pg';
import { DatabaseConfig, DatabaseConfigSchema, DatabaseHealth } from './types.js';
import { Logger } from '../utils/logger.js';

export class DatabasePool {
  private pool: Pool | null = null;
  private config: DatabaseConfig;
  private logger: Logger;
  private healthCache: { data: DatabaseHealth; timestamp: number } | null = null;
  private readonly HEALTH_CACHE_TTL = 5000; // 5 seconds

  constructor(config: Partial<DatabaseConfig> = {}) {
    // Parse DATABASE_URL if provided, otherwise use individual config
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
      this.config = this.parseDatabaseUrl(databaseUrl, config);
    } else {
      this.config = DatabaseConfigSchema.parse({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ...config,
      });
    }
    
    this.logger = new Logger('DatabasePool');
  }

  private parseDatabaseUrl(url: string, overrides: Partial<DatabaseConfig>): DatabaseConfig {
    const parsed = new URL(url);
    
    const baseConfig = {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : 5432,
      database: parsed.pathname.slice(1), // Remove leading '/'
      user: parsed.username,
      password: parsed.password,
      ssl: parsed.searchParams.get('ssl') === 'true' || parsed.searchParams.get('sslmode') === 'require',
    };

    return DatabaseConfigSchema.parse({ ...baseConfig, ...overrides });
  }

  async initialize(): Promise<void> {
    if (this.pool) {
      this.logger.warn('Database pool already initialized');
      return;
    }

    const poolConfig: PoolConfig = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      max: this.config.max,
      min: this.config.min,
      idleTimeoutMillis: this.config.idleTimeoutMillis,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis,
      ssl: this.config.ssl,
      application_name: this.config.applicationName,
      statement_timeout: this.config.statementTimeout,
      query_timeout: this.config.queryTimeout,
    };

    this.pool = new Pool(poolConfig);

    // Set up event handlers
    this.pool.on('connect', (client: PoolClient) => {
      this.logger.debug('New client connected');
      // Set up client-specific configuration
      client.query('SET timezone TO UTC');
    });

    this.pool.on('error', (err: Error) => {
      this.logger.error('Database pool error:', err);
    });

    this.pool.on('remove', () => {
      this.logger.debug('Client removed from pool');
    });

    // Test connection
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1 as test');
      client.release();
      this.logger.info('Database pool initialized successfully', {
        host: this.config.host,
        database: this.config.database,
        maxConnections: this.config.max,
        minConnections: this.config.min,
      });
    } catch (error) {
      this.logger.error('Failed to initialize database pool:', error);
      throw error;
    }
  }

  async query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
    if (!this.pool) {
      throw new Error('Database pool not initialized');
    }

    const startTime = Date.now();
    
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - startTime;
      
      this.logger.debug('Query executed', {
        query: text.substring(0, 100),
        duration,
        rowCount: result.rowCount,
      });

      return {
        rows: result.rows,
        rowCount: result.rowCount || 0,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('Query failed', {
        query: text.substring(0, 100),
        duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async getClient(): Promise<PoolClient> {
    if (!this.pool) {
      throw new Error('Database pool not initialized');
    }

    return await this.pool.connect();
  }

  async health(): Promise<DatabaseHealth> {
    // Return cached health if still valid
    if (this.healthCache && Date.now() - this.healthCache.timestamp < this.HEALTH_CACHE_TTL) {
      return this.healthCache.data;
    }

    const startTime = Date.now();
    let status: DatabaseHealth['status'] = 'healthy';
    let lastError: string | undefined;

    try {
      if (!this.pool) {
        throw new Error('Database pool not initialized');
      }

      // Test connection with a simple query
      await this.query('SELECT 1 as health_check');
      
      const responseTime = Date.now() - startTime;
      
      // Check if response time indicates degraded performance
      if (responseTime > 1000) {
        status = 'degraded';
      }

      const health: DatabaseHealth = {
        status,
        connectionCount: this.pool.totalCount,
        idleConnectionCount: this.pool.idleCount,
        waitingCount: this.pool.waitingCount,
        responseTime,
        lastError,
      };

      // Cache the health result
      this.healthCache = {
        data: health,
        timestamp: Date.now(),
      };

      return health;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';
      
      const health: DatabaseHealth = {
        status: 'unhealthy',
        connectionCount: this.pool?.totalCount || 0,
        idleConnectionCount: this.pool?.idleCount || 0,
        waitingCount: this.pool?.waitingCount || 0,
        responseTime: Date.now() - startTime,
        lastError,
      };

      // Cache the unhealthy result for a shorter time
      this.healthCache = {
        data: health,
        timestamp: Date.now(),
      };

      return health;
    }
  }

  async close(): Promise<void> {
    if (!this.pool) {
      return;
    }

    try {
      await this.pool.end();
      this.pool = null;
      this.healthCache = null;
      this.logger.info('Database pool closed');
    } catch (error) {
      this.logger.error('Error closing database pool:', error);
      throw error;
    }
  }

  get isInitialized(): boolean {
    return this.pool !== null;
  }

  get stats() {
    if (!this.pool) {
      return null;
    }

    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }
}

// Singleton instance
let globalPool: DatabasePool | null = null;

export function createDatabasePool(config?: Partial<DatabaseConfig>): DatabasePool {
  if (globalPool) {
    throw new Error('Database pool already exists. Use getDatabasePool() to get the existing instance.');
  }
  
  globalPool = new DatabasePool(config);
  return globalPool;
}

export function getDatabasePool(): DatabasePool {
  if (!globalPool) {
    throw new Error('Database pool not initialized. Call createDatabasePool() first.');
  }
  
  return globalPool;
}

export async function closeDatabasePool(): Promise<void> {
  if (globalPool) {
    await globalPool.close();
    globalPool = null;
  }
}