import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabasePool, createDatabasePool, getDatabasePool, closeDatabasePool } from './pool.js';

// Mock pg module
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ test: 1 }] }),
      release: vi.fn(),
    }),
    query: vi.fn().mockResolvedValue({ rows: [{ test: 1 }], rowCount: 1 }),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
  })),
}));

describe('DatabasePool', () => {
  beforeEach(() => {
    // Clear any existing global pool
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await closeDatabasePool();
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('constructor and initialization', () => {
    it('should create a database pool with default configuration', () => {
      const pool = new DatabasePool();
      expect(pool).toBeInstanceOf(DatabasePool);
      expect(pool.isInitialized).toBe(false);
    });

    it('should initialize pool successfully', async () => {
      const pool = new DatabasePool({
        host: 'localhost',
        database: 'test',
        user: 'test',
        password: 'test',
      });

      await pool.initialize();
      expect(pool.isInitialized).toBe(true);
    });

    it('should parse DATABASE_URL correctly', () => {
      const originalUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'postgresql://testuser:testpass@localhost:5432/testdb';

      const pool = new DatabasePool();
      expect(pool).toBeInstanceOf(DatabasePool);

      // Restore original value
      if (originalUrl) {
        process.env.DATABASE_URL = originalUrl;
      } else {
        delete process.env.DATABASE_URL;
      }
    });
  });

  describe('query operations', () => {
    it('should execute queries successfully', async () => {
      const pool = new DatabasePool({
        host: 'localhost',
        database: 'test',
        user: 'test',
        password: 'test',
      });

      await pool.initialize();
      const result = await pool.query('SELECT 1 as test');

      expect(result.rows).toEqual([{ test: 1 }]);
      expect(result.rowCount).toBe(1);
    });

    it('should throw error when querying uninitialized pool', async () => {
      const pool = new DatabasePool();
      
      await expect(pool.query('SELECT 1')).rejects.toThrow('Database pool not initialized');
    });
  });

  describe('health checks', () => {
    it('should return healthy status for working database', async () => {
      const pool = new DatabasePool({
        host: 'localhost',
        database: 'test',
        user: 'test',
        password: 'test',
      });

      await pool.initialize();
      const health = await pool.health();

      expect(health.status).toBe('healthy');
      expect(health.connectionCount).toBe(5);
      expect(health.idleConnectionCount).toBe(3);
      expect(health.waitingCount).toBe(0);
      expect(typeof health.responseTime).toBe('number');
    });

    it('should return unhealthy status for failed database', async () => {
      const pool = new DatabasePool();
      const health = await pool.health();

      expect(health.status).toBe('unhealthy');
      expect(health.lastError).toBeTruthy();
    });
  });

  describe('singleton functions', () => {
    it('should create and get global pool', () => {
      const pool = createDatabasePool({
        host: 'localhost',
        database: 'test',
        user: 'test',
        password: 'test',
      });

      expect(pool).toBeInstanceOf(DatabasePool);

      const samePool = getDatabasePool();
      expect(samePool).toBe(pool);
    });

    it('should throw error when creating pool twice', () => {
      createDatabasePool();
      
      expect(() => createDatabasePool()).toThrow(
        'Database pool already exists. Use getDatabasePool() to get the existing instance.'
      );
    });

    it('should throw error when getting uninitialized pool', async () => {
      await closeDatabasePool(); // Ensure no pool exists
      
      expect(() => getDatabasePool()).toThrow(
        'Database pool not initialized. Call createDatabasePool() first.'
      );
    });
  });
});