import { join } from 'path';
import { getDatabasePool } from './pool.js';
import { Logger } from '../utils/logger.js';

export interface MigrationOptions {
  migrationsPath?: string;
  tableName?: string;
  createSchema?: boolean;
  dryRun?: boolean;
}

export class MigrationRunner {
  private logger: Logger;
  private options: Required<MigrationOptions>;

  constructor(options: MigrationOptions = {}) {
    this.logger = new Logger('MigrationRunner');
    this.options = {
      migrationsPath: options.migrationsPath || join(process.cwd(), 'migrations'),
      tableName: options.tableName || 'pgmigrations',
      createSchema: options.createSchema ?? true,
      dryRun: options.dryRun ?? false,
    };
  }

  async runMigrations(): Promise<void> {
    const pool = getDatabasePool();
    
    if (!pool.isInitialized) {
      throw new Error('Database pool must be initialized before running migrations');
    }

    this.logger.info('Starting database migrations', {
      migrationsPath: this.options.migrationsPath,
      dryRun: this.options.dryRun,
    });

    try {
      if (this.options.dryRun) {
        this.logger.info('DRY RUN MODE - No changes will be applied');
      }

      // Import node-pg-migrate dynamically to avoid issues with ESM
      const { default: migrate } = await import('node-pg-migrate');

      // Get a client from the pool for migrations
      const client = await pool.getClient();
      
      try {
        const migrationResults = await migrate({
          dbClient: client,
          dir: this.options.migrationsPath,
          direction: 'up',
          migrationsTable: this.options.tableName,
          createSchema: this.options.createSchema,
          dryRun: this.options.dryRun,
          verbose: true,
          log: (msg: string) => this.logger.info(msg),
        });

        this.logger.info('Migrations completed successfully', {
          migrationsRun: migrationResults.length,
          migrations: migrationResults,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      this.logger.error('Migration failed:', error);
      throw error;
    }
  }

  async rollbackMigrations(steps = 1): Promise<void> {
    const pool = getDatabasePool();
    
    if (!pool.isInitialized) {
      throw new Error('Database pool must be initialized before rolling back migrations');
    }

    this.logger.info('Rolling back database migrations', {
      steps,
      dryRun: this.options.dryRun,
    });

    try {
      const { default: migrate } = await import('node-pg-migrate');
      const client = await pool.getClient();
      
      try {
        const migrationResults = await migrate({
          dbClient: client,
          dir: this.options.migrationsPath,
          direction: 'down',
          count: steps,
          migrationsTable: this.options.tableName,
          dryRun: this.options.dryRun,
          verbose: true,
          log: (msg: string) => this.logger.info(msg),
        });

        this.logger.info('Rollback completed successfully', {
          migrationsRolledBack: migrationResults.length,
          migrations: migrationResults,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      this.logger.error('Rollback failed:', error);
      throw error;
    }
  }

  async getMigrationStatus(): Promise<any[]> {
    const pool = getDatabasePool();
    
    try {
      const result = await pool.query(`
        SELECT name, run_on 
        FROM ${this.options.tableName} 
        ORDER BY run_on DESC
      `);
      
      return result.rows;
    } catch (error) {
      // If table doesn't exist, no migrations have been run
      if (error instanceof Error && error.message.includes('does not exist')) {
        return [];
      }
      throw error;
    }
  }

  async createMigration(name: string): Promise<string> {
    try {
      const { default: migrate } = await import('node-pg-migrate');
      
      const migrationName = await migrate({
        dir: this.options.migrationsPath,
        name,
        'create-only': true,
      });

      this.logger.info('Migration created', { name, file: migrationName });
      return migrationName as string;
    } catch (error) {
      this.logger.error('Failed to create migration:', error);
      throw error;
    }
  }
}

// Convenience functions
export async function runMigrations(options?: MigrationOptions): Promise<void> {
  const runner = new MigrationRunner(options);
  await runner.runMigrations();
}

export async function rollbackMigrations(steps = 1, options?: MigrationOptions): Promise<void> {
  const runner = new MigrationRunner(options);
  await runner.rollbackMigrations(steps);
}

export async function getMigrationStatus(options?: MigrationOptions): Promise<any[]> {
  const runner = new MigrationRunner(options);
  return runner.getMigrationStatus();
}

export async function createMigration(name: string, options?: MigrationOptions): Promise<string> {
  const runner = new MigrationRunner(options);
  return runner.createMigration(name);
}