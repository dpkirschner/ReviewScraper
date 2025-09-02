import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock all external dependencies
vi.mock('../../utils/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  }
}));

vi.mock('../types.js', () => ({
  DatabaseConfigSchema: {
    parse: vi.fn().mockImplementation((config) => ({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
      max: 20,
      min: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: false,
      applicationName: 'test',
      statementTimeout: 60000,
      queryTimeout: 30000,
      ...config
    }))
  }
}));

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

import { DatabasePool, createDatabasePool, getDatabasePool, closeDatabasePool } from '../pool.js';

describe('DatabasePool', () => {
  afterEach(async () => {
    await DatabasePool.closeInstance();
  });

  describe('getInstance', () => {
    it('should create and return a singleton instance', async () => {
      const pool1 = await DatabasePool.getInstance();
      const pool2 = await DatabasePool.getInstance();

      expect(pool1).toBeInstanceOf(DatabasePool);
      expect(pool1).toBe(pool2);
    });

    it('should initialize the pool on first call', async () => {
      const pool = await DatabasePool.getInstance();
      expect(pool.isInitialized).toBe(true);
    });
  });

  describe('closeInstance', () => {
    it('should close the pool and reset the instance', async () => {
      const pool1 = await DatabasePool.getInstance();
      await DatabasePool.closeInstance();
      const pool2 = await DatabasePool.getInstance();

      expect(pool1).not.toBe(pool2);
    });
  });

  describe('query', () => {
    it('should execute a query on the initialized pool', async () => {
      const pool = await DatabasePool.getInstance();
      const result = await pool.query('SELECT * FROM test');

      expect(result.rowCount).toBe(1);
      expect(result.rows).toEqual([{ test: 1 }]);
    });
  });

  describe('constructor', () => {
    it('should create a database pool with default configuration', () => {
      const pool = new DatabasePool();
      expect(pool).toBeInstanceOf(DatabasePool);
      expect(pool.isInitialized).toBe(false);
    });
  });

  describe('basic operations', () => {
    it('should throw error when querying uninitialized pool', async () => {
      const pool = new DatabasePool();
      await expect(pool.query('SELECT 1')).rejects.toThrow('Database pool not initialized');
    });
  });

  describe('singleton functions', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(async () => {
      try {
        await closeDatabasePool();
      } catch {
        // Ignore errors during cleanup
      }
    });

    it('should create global pool instance', () => {
      const pool = createDatabasePool({
        host: 'localhost',
        database: 'test',
        user: 'test',
        password: 'test',
      });

      expect(pool).toBeInstanceOf(DatabasePool);
    });

    it('should throw error when getting uninitialized pool', async () => {
      await closeDatabasePool(); // Ensure no pool exists
      
      expect(() => getDatabasePool()).toThrow(
        'Database pool not initialized. Call createDatabasePool() first.'
      );
    });
  });
});