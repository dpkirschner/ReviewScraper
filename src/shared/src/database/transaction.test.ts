import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Transaction, withTransaction, Repository } from './transaction.js';
import { createDatabasePool, closeDatabasePool } from './pool.js';

// Mock the pool module
vi.mock('./pool.js', () => ({
  getDatabasePool: vi.fn(),
  createDatabasePool: vi.fn(),
  closeDatabasePool: vi.fn(),
}));

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

const mockPool = {
  getClient: vi.fn().mockResolvedValue(mockClient),
  close: vi.fn(),
};

describe('Transaction', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getDatabasePool } = await import('./pool.js');
    vi.mocked(getDatabasePool).mockReturnValue(mockPool as any);
  });

  afterEach(async () => {
    try {
      await closeDatabasePool();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Transaction lifecycle', () => {
    it('should begin, commit, and cleanup transaction', async () => {
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const transaction = new Transaction();
      expect(transaction.active).toBe(false);

      await transaction.begin();
      expect(transaction.active).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');

      await transaction.commit();
      expect(transaction.active).toBe(false);
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should begin, rollback, and cleanup transaction', async () => {
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const transaction = new Transaction();
      await transaction.begin();
      
      await transaction.rollback();
      expect(transaction.active).toBe(false);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should set isolation level when specified', async () => {
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const transaction = new Transaction('SERIALIZABLE');
      await transaction.begin();

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    });

    it('should execute queries within transaction', async () => {
      mockClient.query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

      const transaction = new Transaction();
      await transaction.begin();

      const result = await transaction.query('SELECT * FROM test WHERE id = $1', [1]);
      
      expect(result.rows).toEqual([{ id: 1 }]);
      expect(result.rowCount).toBe(1);
      expect(mockClient.query).toHaveBeenCalledWith('SELECT * FROM test WHERE id = $1', [1]);
    });

    it('should throw error when querying inactive transaction', async () => {
      const transaction = new Transaction();
      
      await expect(transaction.query('SELECT 1')).rejects.toThrow('Transaction not active');
    });
  });

  describe('withTransaction helper', () => {
    it('should auto-commit on successful execution', async () => {
      mockClient.query.mockResolvedValue({ rows: [{ result: 'success' }], rowCount: 1 });

      const result = await withTransaction(async (tx) => {
        const queryResult = await tx.query('SELECT $1 as result', ['success']);
        return queryResult.rows[0].result;
      });

      expect(result).toBe('success');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should auto-rollback on error', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed'))  // User query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

      await expect(
        withTransaction(async (tx) => {
          await tx.query('SELECT * FROM nonexistent_table');
          return 'success';
        })
      ).rejects.toThrow('Query failed');

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('Repository base class', () => {
    class TestRepository extends Repository {
      constructor() {
        super('Test');
      }

      async findById(id: number, transaction?: Transaction) {
        return this.queryOne('SELECT * FROM test WHERE id = $1', [id], transaction);
      }

      async findAll(transaction?: Transaction) {
        return this.queryMany('SELECT * FROM test', [], transaction);
      }

      async exists(id: number, transaction?: Transaction) {
        return super.exists('SELECT 1 FROM test WHERE id = $1', [id], transaction);
      }
    }

    it('should execute queries through repository', async () => {
      mockClient.query.mockResolvedValue({ rows: [{ id: 1, name: 'test' }], rowCount: 1 });
      mockPool.query = vi.fn().mockResolvedValue({ rows: [{ id: 1, name: 'test' }], rowCount: 1 });

      const repo = new TestRepository();
      const result = await repo.findById(1);

      expect(result).toEqual({ id: 1, name: 'test' });
      expect(mockPool.query).toHaveBeenCalledWith('SELECT * FROM test WHERE id = $1', [1]);
    });

    it('should use transaction when provided', async () => {
      mockClient.query.mockResolvedValue({ rows: [{ id: 1, name: 'test' }], rowCount: 1 });

      const transaction = new Transaction();
      await transaction.begin();

      const repo = new TestRepository();
      const result = await repo.findById(1, transaction);

      expect(result).toEqual({ id: 1, name: 'test' });
      expect(mockClient.query).toHaveBeenCalledWith('SELECT * FROM test WHERE id = $1', [1]);
    });

    it('should handle exists queries', async () => {
      mockPool.query = vi.fn().mockResolvedValue({ rows: [{ exists: true }], rowCount: 1 });

      const repo = new TestRepository();
      const exists = await repo.exists(1);

      expect(exists).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith('SELECT EXISTS(SELECT 1 FROM test WHERE id = $1) as exists', [1]);
    });
  });
});