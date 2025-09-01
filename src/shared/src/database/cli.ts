#!/usr/bin/env node

import { createDatabasePool, runMigrations, rollbackMigrations, getMigrationStatus, createMigration } from './migrate.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('DB-CLI');

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  // Initialize database pool
  const pool = createDatabasePool();
  await pool.initialize();

  try {
    switch (command) {
      case 'migrate': {
        logger.info('Running database migrations...');
        await runMigrations();
        logger.info('Migrations completed successfully');
        break;
      }

      case 'rollback': {
        const steps = args[0] ? parseInt(args[0]) : 1;
        logger.info(`Rolling back ${steps} migration(s)...`);
        await rollbackMigrations(steps);
        logger.info('Rollback completed successfully');
        break;
      }

      case 'status': {
        logger.info('Checking migration status...');
        const migrations = await getMigrationStatus();
        if (migrations.length === 0) {
          logger.info('No migrations have been run');
        } else {
          logger.info(`Migrations run: ${migrations.length}`);
          migrations.forEach(migration => {
            logger.info(`  - ${migration.name} (${migration.run_on})`);
          });
        }
        break;
      }

      case 'create': {
        const name = args[0];
        if (!name) {
          logger.error('Migration name is required');
          process.exit(1);
        }
        logger.info(`Creating migration: ${name}`);
        const filename = await createMigration(name);
        logger.info(`Migration created: ${filename}`);
        break;
      }

      default: {
        logger.error('Unknown command. Available commands: migrate, rollback, status, create');
        process.exit(1);
      }
    }
  } catch (error) {
    logger.error('Command failed:', error);
    process.exit(1);
  } finally {
    await pool.close();
  }
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('CLI error:', error);
    process.exit(1);
  });
}