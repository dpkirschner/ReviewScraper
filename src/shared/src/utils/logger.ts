import { StructuredLogger, createLogger } from '../logging/logger.js';

/**
 * @deprecated Use StructuredLogger from '../logging/logger.js' for new code
 * This class is maintained for backward compatibility
 */
export class Logger {
  private structuredLogger: StructuredLogger;

  constructor(context: string = 'App') {
    this.structuredLogger = createLogger(context);
  }

  info(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.structuredLogger.info(message, { args });
    } else {
      this.structuredLogger.info(message);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.structuredLogger.warn(message, { args });
    } else {
      this.structuredLogger.warn(message);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.structuredLogger.error(message, undefined, { args });
    } else {
      this.structuredLogger.error(message);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.structuredLogger.debug(message, { args });
    } else {
      this.structuredLogger.debug(message);
    }
  }

  /**
   * Get the underlying structured logger for advanced usage
   */
  getStructuredLogger(): StructuredLogger {
    return this.structuredLogger;
  }
}