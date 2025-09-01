import { PoolClient } from 'pg';
import { getDatabasePool } from './pool.js';
import { TransactionContext } from './types.js';
import { Logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

export class Transaction {
  private client: PoolClient | null = null;
  private context: TransactionContext;
  private logger: Logger;
  private isActive = false;

  constructor(isolationLevel?: TransactionContext['isolationLevel']) {
    this.context = {
      id: randomUUID(),
      startTime: new Date(),
      ...(isolationLevel !== undefined && { isolationLevel }),
    };
    this.logger = new Logger('Transaction');
  }

  async begin(): Promise<void> {
    if (this.isActive) {
      throw new Error('Transaction already active');
    }

    const pool = getDatabasePool();
    this.client = await pool.getClient();

    try {
      if (this.context.isolationLevel) {
        await this.client.query('BEGIN');
        await this.client.query(`SET TRANSACTION ISOLATION LEVEL ${this.context.isolationLevel}`);
      } else {
        await this.client.query('BEGIN');
      }

      this.isActive = true;
      this.logger.debug('Transaction started', {
        transactionId: this.context.id,
        isolationLevel: this.context.isolationLevel,
      });
    } catch (error) {
      this.client.release();
      this.client = null;
      throw error;
    }
  }

  async query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
    if (!this.isActive || !this.client) {
      throw new Error('Transaction not active');
    }

    const startTime = Date.now();

    try {
      const result = await this.client.query(text, params);
      const duration = Date.now() - startTime;

      this.logger.debug('Transaction query executed', {
        transactionId: this.context.id,
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
      this.logger.error('Transaction query failed', {
        transactionId: this.context.id,
        query: text.substring(0, 100),
        duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async commit(): Promise<void> {
    if (!this.isActive || !this.client) {
      throw new Error('Transaction not active');
    }

    try {
      await this.client.query('COMMIT');
      const duration = Date.now() - this.context.startTime.getTime();
      
      this.logger.debug('Transaction committed', {
        transactionId: this.context.id,
        duration,
      });
    } finally {
      await this.cleanup();
    }
  }

  async rollback(): Promise<void> {
    if (!this.isActive || !this.client) {
      throw new Error('Transaction not active');
    }

    try {
      await this.client.query('ROLLBACK');
      const duration = Date.now() - this.context.startTime.getTime();
      
      this.logger.debug('Transaction rolled back', {
        transactionId: this.context.id,
        duration,
      });
    } finally {
      await this.cleanup();
    }
  }

  private async cleanup(): Promise<void> {
    if (this.client) {
      this.client.release();
      this.client = null;
    }
    this.isActive = false;
  }

  get id(): string {
    return this.context.id;
  }

  get startTime(): Date {
    return this.context.startTime;
  }

  get active(): boolean {
    return this.isActive;
  }
}

/**
 * Execute a function within a database transaction
 * Automatically commits on success, rolls back on error
 */
export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  isolationLevel?: TransactionContext['isolationLevel']
): Promise<T> {
  const transaction = new Transaction(isolationLevel);
  
  try {
    await transaction.begin();
    const result = await fn(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    if (transaction.active) {
      await transaction.rollback();
    }
    throw error;
  }
}

/**
 * Repository base class that provides transaction-aware database operations
 */
export abstract class Repository {
  protected logger: Logger;

  constructor(name: string) {
    this.logger = new Logger(`Repository:${name}`);
  }

  protected async query<T = any>(
    text: string, 
    params?: any[], 
    transaction?: Transaction
  ): Promise<{ rows: T[]; rowCount: number }> {
    if (transaction) {
      return transaction.query<T>(text, params);
    } else {
      const pool = getDatabasePool();
      return pool.query<T>(text, params);
    }
  }

  protected async queryOne<T = any>(
    text: string,
    params?: any[],
    transaction?: Transaction
  ): Promise<T | null> {
    const result = await this.query<T>(text, params, transaction);
    return result.rows[0] || null;
  }

  protected async queryMany<T = any>(
    text: string,
    params?: any[],
    transaction?: Transaction
  ): Promise<T[]> {
    const result = await this.query<T>(text, params, transaction);
    return result.rows;
  }

  protected async exists(
    text: string,
    params?: any[],
    transaction?: Transaction
  ): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS(${text}) as exists`,
      params,
      transaction
    );
    return result.rows[0]?.exists || false;
  }
}