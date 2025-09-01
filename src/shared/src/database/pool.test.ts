import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock all external dependencies
vi.mock('../utils/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  }
}));

vi.mock('./types.js', () => ({
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
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await closeDatabasePool();
    } catch {
      // Ignore errors during cleanup
    }
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