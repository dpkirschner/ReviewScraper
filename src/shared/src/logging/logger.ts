import pino from 'pino';
import { LogConfig, LogConfigSchema, LogLevel, LogContext, StructuredLogData } from './types.js';
import { CorrelationManager } from './correlation.js';
import { env } from '../config/environment.js';

export class StructuredLogger {
  private pino: pino.Logger;
  private config: LogConfig;
  private serviceName: string;

  constructor(serviceName: string, config: Partial<LogConfig> = {}) {
    this.serviceName = serviceName;
    this.config = LogConfigSchema.parse({
      level: env.LOG_LEVEL || 'info',
      format: env.LOG_FORMAT || (env.NODE_ENV === 'development' ? 'pretty' : 'json'),
      service: serviceName,
      version: process.env.npm_package_version || '1.0.0',
      environment: env.NODE_ENV,
      ...config,
    });

    this.pino = this.createPinoLogger();
  }

  private createPinoLogger(): pino.Logger {
    const pinoConfig: pino.LoggerOptions = {
      name: this.serviceName,
      level: this.config.level,
      
      // Base fields included in every log
      base: {
        service: this.config.service,
        version: this.config.version,
        environment: this.config.environment,
        hostname: process.env.HOSTNAME || require('os').hostname(),
        pid: process.pid,
      },

      // Redact sensitive fields
      redact: {
        paths: this.config.redact,
        remove: true,
      },

      // Custom timestamp format
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,

      // Format configuration
      ...(this.config.format === 'pretty' && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: '{service}/{component} [{correlationId}] {msg}',
          },
        },
      }),
    };

    // Add file transport if configured
    if (this.config.file?.enabled && this.config.file.path) {
      pinoConfig.transport = {
        targets: [
          // Console transport
          ...(this.config.format === 'pretty' ? [{
            target: 'pino-pretty',
            level: this.config.level,
            options: {
              colorize: true,
              translateTime: 'yyyy-mm-dd HH:MM:ss',
              ignore: 'pid,hostname',
            },
          }] : [{
            target: 'pino/file',
            level: this.config.level,
            options: { destination: 1 }, // stdout
          }]),
          
          // File transport
          {
            target: 'pino/file',
            level: this.config.level,
            options: {
              destination: this.config.file.path,
              mkdir: true,
            },
          },
        ],
      };
    }

    return pino(pinoConfig);
  }

  private enrichLogData(level: LogLevel, message: string, metadata?: any, error?: Error): any {
    const correlation = CorrelationManager.getLogContext();
    const duration = CorrelationManager.getDuration();

    const logData: any = {
      level,
      msg: message,
      ...correlation,
      ...(duration > 0 && { duration }),
    };

    // Add error information
    if (error) {
      logData.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error as any).code && { code: (error as any).code },
      };
    }

    // Add metadata
    if (metadata && typeof metadata === 'object') {
      // Handle different metadata types
      if (metadata.performance) {
        logData.performance = metadata.performance;
      }
      
      if (metadata.context) {
        logData.context = { ...logData.context, ...metadata.context };
      }
      
      // Add remaining fields as metadata
      const { performance, context, ...rest } = metadata;
      if (Object.keys(rest).length > 0) {
        logData.metadata = rest;
      }
    }

    // Apply sampling if configured
    if (this.config.sampling?.enabled) {
      const shouldSample = Math.random() < (this.config.sampling.rate || 0.1);
      if (!shouldSample && level === 'debug') {
        return null; // Skip this log entry
      }
    }

    return logData;
  }

  debug(message: string, metadata?: any): void {
    const logData = this.enrichLogData('debug', message, metadata);
    if (logData) {
      this.pino.debug(logData);
    }
  }

  info(message: string, metadata?: any): void {
    const logData = this.enrichLogData('info', message, metadata);
    if (logData) {
      this.pino.info(logData);
    }
  }

  warn(message: string, metadata?: any): void {
    const logData = this.enrichLogData('warn', message, metadata);
    if (logData) {
      this.pino.warn(logData);
    }
  }

  error(message: string, error?: Error | any, metadata?: any): void {
    // Handle different parameter combinations
    let errorObj: Error | undefined;
    let metadataObj: any = metadata;

    if (error instanceof Error) {
      errorObj = error;
    } else if (error && typeof error === 'object') {
      metadataObj = { ...error, ...metadata };
      errorObj = undefined;
    }

    const logData = this.enrichLogData('error', message, metadataObj, errorObj);
    if (logData) {
      this.pino.error(logData);
    }
  }

  fatal(message: string, error?: Error | any, metadata?: any): void {
    let errorObj: Error | undefined;
    let metadataObj: any = metadata;

    if (error instanceof Error) {
      errorObj = error;
    } else if (error && typeof error === 'object') {
      metadataObj = { ...error, ...metadata };
      errorObj = undefined;
    }

    const logData = this.enrichLogData('fatal', message, metadataObj, errorObj);
    if (logData) {
      this.pino.fatal(logData);
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): StructuredLogger {
    const childLogger = new StructuredLogger(this.serviceName, this.config);
    childLogger.pino = this.pino.child(context);
    return childLogger;
  }

  /**
   * Log with custom level
   */
  log(level: LogLevel, message: string, metadata?: any, error?: Error): void {
    switch (level) {
      case 'debug':
        this.debug(message, metadata);
        break;
      case 'info':
        this.info(message, metadata);
        break;
      case 'warn':
        this.warn(message, metadata);
        break;
      case 'error':
        this.error(message, error, metadata);
        break;
      case 'fatal':
        this.fatal(message, error, metadata);
        break;
    }
  }

  /**
   * Time a function execution and log the duration
   */
  async time<T>(
    operation: string,
    fn: () => Promise<T>,
    level: LogLevel = 'debug'
  ): Promise<T> {
    const start = Date.now();
    const operationId = `${this.serviceName}.${operation}`;
    
    this.debug(`Starting operation: ${operation}`);
    
    try {
      const result = await fn();
      const duration = Date.now() - start;
      
      this.log(level, `Operation completed: ${operation}`, {
        performance: { duration, operation: operationId },
      });
      
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      
      this.error(`Operation failed: ${operation}`, error, {
        performance: { duration, operation: operationId },
      });
      
      throw error;
    }
  }

  /**
   * Flush any buffered logs (useful for testing)
   */
  async flush(): Promise<void> {
    return new Promise((resolve) => {
      this.pino.flush(() => resolve());
    });
  }

  /**
   * Get the underlying pino logger (for advanced use cases)
   */
  getRawLogger(): pino.Logger {
    return this.pino;
  }
}

// Singleton logger instances by service name
const loggerInstances = new Map<string, StructuredLogger>();

/**
 * Create or get a logger instance for a service
 */
export function createLogger(serviceName: string, config?: Partial<LogConfig>): StructuredLogger {
  const key = `${serviceName}:${JSON.stringify(config || {})}`;
  
  if (!loggerInstances.has(key)) {
    loggerInstances.set(key, new StructuredLogger(serviceName, config));
  }
  
  return loggerInstances.get(key)!;
}

/**
 * Get logger for a service (creates with defaults if not exists)
 */
export function getLogger(serviceName: string): StructuredLogger {
  if (!loggerInstances.has(serviceName)) {
    loggerInstances.set(serviceName, new StructuredLogger(serviceName));
  }
  
  return loggerInstances.get(serviceName)!;
}

/**
 * Default logger instance
 */
export const logger = createLogger('review-scraper');