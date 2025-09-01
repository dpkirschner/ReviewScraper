import { createLogger, StructuredLogger } from '../logging/logger.js';
import { closeDatabasePool } from '../database/pool.js';
import { getHealthMonitor } from './checker.js';

export interface ShutdownHandler {
  name: string;
  handler: () => Promise<void>;
  timeout?: number; // in milliseconds
  priority?: number; // lower numbers execute first
}

export class GracefulShutdown {
  private handlers = new Map<string, ShutdownHandler>();
  private logger: StructuredLogger;
  private isShuttingDown = false;
  private shutdownTimeoutMs = 30000; // 30 seconds default
  private forceExitTimeoutMs = 5000; // Force exit after this if graceful shutdown fails

  constructor(serviceName: string) {
    this.logger = createLogger(`${serviceName}:GracefulShutdown`);
    this.registerDefaultHandlers();
    this.setupSignalHandlers();
  }

  private registerDefaultHandlers(): void {
    // Stop health monitoring
    this.addHandler({
      name: 'health-monitor',
      priority: 1,
      timeout: 2000,
      handler: async () => {
        try {
          const healthMonitor = getHealthMonitor();
          healthMonitor.stopPeriodicChecking();
          this.logger.info('Stopped health monitoring');
        } catch (error) {
          // Health monitor might not be initialized
          this.logger.debug('Health monitor not initialized or already stopped');
        }
      },
    });

    // Close database connections
    this.addHandler({
      name: 'database',
      priority: 5,
      timeout: 10000,
      handler: async () => {
        try {
          await closeDatabasePool();
          this.logger.info('Closed database connections');
        } catch (error) {
          this.logger.error('Error closing database connections', error);
          throw error;
        }
      },
    });

    // Final cleanup
    this.addHandler({
      name: 'final-cleanup',
      priority: 10,
      timeout: 1000,
      handler: async () => {
        this.logger.info('Graceful shutdown completed');
        // Flush any remaining logs
        await this.logger.flush();
      },
    });
  }

  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
    
    signals.forEach((signal) => {
      process.on(signal, () => {
        this.logger.info(`Received ${signal}, initiating graceful shutdown`);
        this.shutdown().catch((error) => {
          this.logger.fatal('Graceful shutdown failed', error);
          process.exit(1);
        });
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.fatal('Uncaught exception, initiating emergency shutdown', error);
      this.emergencyShutdown();
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.fatal('Unhandled promise rejection, initiating emergency shutdown', {
        reason: reason instanceof Error ? reason.message : String(reason),
        promise: String(promise),
      });
      this.emergencyShutdown();
    });
  }

  /**
   * Add a shutdown handler
   */
  addHandler(handler: ShutdownHandler): void {
    this.handlers.set(handler.name, {
      priority: 5,
      timeout: 5000,
      ...handler,
    });
    
    this.logger.debug(`Added shutdown handler: ${handler.name}`);
  }

  /**
   * Remove a shutdown handler
   */
  removeHandler(name: string): boolean {
    const removed = this.handlers.delete(name);
    if (removed) {
      this.logger.debug(`Removed shutdown handler: ${name}`);
    }
    return removed;
  }

  /**
   * Initiate graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    const shutdownStart = Date.now();

    this.logger.info('Starting graceful shutdown', {
      handlers: Array.from(this.handlers.keys()),
      timeout: this.shutdownTimeoutMs,
    });

    // Set up force exit timeout
    const forceExitTimeout = setTimeout(() => {
      this.logger.error('Graceful shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, this.shutdownTimeoutMs);

    try {
      // Sort handlers by priority (lower numbers first)
      const sortedHandlers = Array.from(this.handlers.values()).sort(
        (a, b) => (a.priority || 5) - (b.priority || 5)
      );

      // Execute handlers in priority order
      for (const handler of sortedHandlers) {
        const handlerStart = Date.now();
        
        try {
          this.logger.info(`Executing shutdown handler: ${handler.name}`);
          
          const handlerTimeout = setTimeout(() => {
            throw new Error(`Handler timeout: ${handler.name}`);
          }, handler.timeout || 5000);

          await Promise.race([
            handler.handler(),
            new Promise<void>((_, reject) => {
              setTimeout(() => reject(new Error(`Handler timeout: ${handler.name}`)), handler.timeout);
            }),
          ]);

          clearTimeout(handlerTimeout);
          
          const handlerDuration = Date.now() - handlerStart;
          this.logger.info(`Shutdown handler completed: ${handler.name}`, {
            duration: handlerDuration,
          });
        } catch (error) {
          const handlerDuration = Date.now() - handlerStart;
          this.logger.error(`Shutdown handler failed: ${handler.name}`, error, {
            duration: handlerDuration,
          });
          
          // Continue with other handlers even if one fails
        }
      }

      const totalDuration = Date.now() - shutdownStart;
      this.logger.info('Graceful shutdown completed successfully', {
        duration: totalDuration,
        handlersExecuted: sortedHandlers.length,
      });

      clearTimeout(forceExitTimeout);
      
      // Give a moment for logs to flush before exit
      setTimeout(() => {
        process.exit(0);
      }, 100);
      
    } catch (error) {
      clearTimeout(forceExitTimeout);
      this.logger.fatal('Graceful shutdown failed', error);
      
      // Set a shorter timeout for emergency shutdown
      setTimeout(() => {
        process.exit(1);
      }, this.forceExitTimeoutMs);
    }
  }

  /**
   * Emergency shutdown (immediate)
   */
  private emergencyShutdown(): void {
    this.logger.fatal('Emergency shutdown initiated');
    
    // Try to close critical resources immediately
    try {
      closeDatabasePool().catch(() => {}); // Don't wait for this
    } catch (error) {
      // Ignore errors during emergency shutdown
    }
    
    // Force exit after brief delay
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }

  /**
   * Check if shutdown is in progress
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Set shutdown timeout
   */
  setShutdownTimeout(timeoutMs: number): void {
    this.shutdownTimeoutMs = timeoutMs;
  }

  /**
   * Set force exit timeout
   */
  setForceExitTimeout(timeoutMs: number): void {
    this.forceExitTimeoutMs = timeoutMs;
  }
}

// Global graceful shutdown instance
let globalGracefulShutdown: GracefulShutdown | null = null;

export function createGracefulShutdown(serviceName: string): GracefulShutdown {
  if (globalGracefulShutdown) {
    throw new Error('Graceful shutdown already exists. Use getGracefulShutdown() to get the existing instance.');
  }
  
  globalGracefulShutdown = new GracefulShutdown(serviceName);
  return globalGracefulShutdown;
}

export function getGracefulShutdown(): GracefulShutdown {
  if (!globalGracefulShutdown) {
    throw new Error('Graceful shutdown not initialized. Call createGracefulShutdown() first.');
  }
  
  return globalGracefulShutdown;
}