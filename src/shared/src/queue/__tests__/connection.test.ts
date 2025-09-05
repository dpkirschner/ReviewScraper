import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueueConnection, createQueueConnection, getQueueConnection, closeQueueConnection } from '../connection.js';

// Mock IORedis
vi.mock('ioredis', () => {
  const mockRedis = {
    status: 'ready',
    options: {
      host: 'localhost',
      port: 6379,
      db: 0,
    },
    on: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  };

  const RedisMock = vi.fn(() => mockRedis);

  return {
    default: RedisMock,
    Redis: RedisMock,
  };
});

describe('QueueConnection', () => {
  let connection: QueueConnection;

  beforeEach(() => {
    // Clear any global instances
    closeQueueConnection();
    // Clear Redis URL from environment to ensure clean state
    delete process.env.REDIS_URL;
  });

  afterEach(async () => {
    if (connection) {
      await connection.close();
    }
    await closeQueueConnection();
  });

  describe('Constructor and Configuration', () => {
    it('should create connection with default config', () => {
      connection = new QueueConnection();
      expect(connection).toBeInstanceOf(QueueConnection);
      expect(connection.isConnected).toBe(false);
    });

    it('should parse Redis URL from environment', () => {
      const originalRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://user:pass@localhost:6380/1';

      try {
        connection = new QueueConnection();
        const config = connection.connectionConfig;
        
        expect(config.connection.host).toBe('localhost');
        expect(config.connection.port).toBe(6380);
        expect(config.connection.password).toBe('pass');
        expect(config.connection.db).toBe(1);
      } finally {
        process.env.REDIS_URL = originalRedisUrl;
      }
    });

    it('should use individual environment variables when no Redis URL', () => {
      const originalEnv = { ...process.env };
      delete process.env.REDIS_URL;
      process.env.REDIS_HOST = 'redis.example.com';
      process.env.REDIS_PORT = '6380';
      process.env.REDIS_PASSWORD = 'secret';
      process.env.REDIS_DB = '2';

      try {
        connection = new QueueConnection();
        const config = connection.connectionConfig;
        
        expect(config.connection.host).toBe('redis.example.com');
        expect(config.connection.port).toBe(6380);
        expect(config.connection.password).toBe('secret');
        expect(config.connection.db).toBe(2);
      } finally {
        process.env = originalEnv;
      }
    });

    it('should merge custom config with defaults', () => {
      connection = new QueueConnection({
        connection: {
          host: 'custom.redis.com',
          maxRetriesPerRequest: 5,
        },
        defaultJobOptions: {
          attempts: 5,
        },
      });

      const config = connection.config;
      expect(config.connection.host).toBe('custom.redis.com');
      expect(config.connection.port).toBe(6379); // Default
      expect(config.connection.maxRetriesPerRequest).toBe(5);
      expect(config.defaultJobOptions.attempts).toBe(5);
    });
  });

  describe('Connection Management', () => {
    beforeEach(() => {
      connection = new QueueConnection();
    });

    it('should connect to Redis successfully', async () => {
      const redis = await connection.connect();
      expect(redis).toBeDefined();
      expect(connection.isConnected).toBe(true);
    });

    it('should return same connection on multiple connect calls', async () => {
      const redis1 = await connection.connect();
      const redis2 = await connection.connect();
      expect(redis1).toBe(redis2);
    });

    it('should get connection stats', async () => {
      await connection.connect();
      const stats = connection.getStats();
      
      expect(stats).toBeDefined();
      expect(stats?.status).toBe('ready');
      expect(stats?.options.host).toBe('localhost');
      expect(stats?.options.port).toBe(6379);
    });

    it('should return null stats when not connected', () => {
      const stats = connection.getStats();
      expect(stats).toBeNull();
    });

    it('should close connection properly', async () => {
      await connection.connect();
      expect(connection.isConnected).toBe(true);
      
      await connection.close();
      expect(connection.isConnected).toBe(false);
    });
  });

  describe('Health Checks', () => {
    beforeEach(() => {
      connection = new QueueConnection();
    });

    it('should report healthy when connected', async () => {
      await connection.connect();
      const health = await connection.health();
      
      expect(health.status).toBe('healthy');
      expect(health.responseTime).toBeGreaterThanOrEqual(0);
      expect(health.error).toBeUndefined();
    });

    it('should report unhealthy when not connected', async () => {
      const health = await connection.health();
      
      expect(health.status).toBe('unhealthy');
      expect(health.error).toBe('Redis not connected');
    });
  });

  describe('Global Instance Management', () => {
    it('should create global instance', () => {
      const globalConnection = createQueueConnection();
      expect(globalConnection).toBeInstanceOf(QueueConnection);
      
      const retrieved = getQueueConnection();
      expect(retrieved).toBe(globalConnection);
    });

    it('should throw when creating duplicate global instance', () => {
      createQueueConnection();
      expect(() => createQueueConnection()).toThrow(
        'Queue connection already exists. Use getQueueConnection() to get the existing instance.'
      );
    });

    it('should throw when getting non-existent global instance', async () => {
      await closeQueueConnection(); // Ensure clean state
      expect(() => getQueueConnection()).toThrow(
        'Queue connection not initialized. Call createQueueConnection() first.'
      );
    });

    it('should close global instance', async () => {
      createQueueConnection();
      await closeQueueConnection();
      
      expect(() => getQueueConnection()).toThrow(
        'Queue connection not initialized. Call createQueueConnection() first.'
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle Redis connection errors gracefully', async () => {
      // Mock Redis constructor to throw
      const IORedis = await import('ioredis');
      const mockConstructor = vi.mocked(IORedis.Redis);
      mockConstructor.mockImplementationOnce(() => {
        throw new Error('Connection failed');
      });

      connection = new QueueConnection();
      
      await expect(connection.connect()).rejects.toThrow('Connection failed');
      expect(connection.isConnected).toBe(false);
    });
  });
});