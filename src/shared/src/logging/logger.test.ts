import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StructuredLogger, createLogger, getLogger } from './logger.js';
import { CorrelationManager } from './correlation.js';

// Mock pino
vi.mock('pino', () => ({
  default: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    })),
    flush: vi.fn((cb: () => void) => cb()),
  })),
}));

describe('StructuredLogger', () => {
  let logger: StructuredLogger;
  let mockPino: any;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = new StructuredLogger('test-service');
    mockPino = logger.getRawLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('basic logging methods', () => {
    it('should log debug messages', () => {
      logger.debug('Test debug message', { extra: 'data' });
      
      expect(mockPino.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'debug',
          msg: 'Test debug message',
          metadata: { extra: 'data' },
        })
      );
    });

    it('should log info messages', () => {
      logger.info('Test info message');
      
      expect(mockPino.info).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          msg: 'Test info message',
        })
      );
    });

    it('should log warnings', () => {
      logger.warn('Test warning', { someField: 'test' });
      
      expect(mockPino.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          msg: 'Test warning',
          metadata: { someField: 'test' },
        })
      );
    });

    it('should log errors with error objects', () => {
      const error = new Error('Test error');
      error.stack = 'Error stack trace';
      
      logger.error('Something went wrong', error);
      
      expect(mockPino.error).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          msg: 'Something went wrong',
          error: {
            name: 'Error',
            message: 'Test error',
            stack: 'Error stack trace',
          },
        })
      );
    });

    it('should log fatal errors', () => {
      const error = new Error('Fatal error');
      
      logger.fatal('System failure', error, { system: 'database' });
      
      expect(mockPino.fatal).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'fatal',
          msg: 'System failure',
          error: expect.objectContaining({
            name: 'Error',
            message: 'Fatal error',
          }),
          metadata: { system: 'database' },
        })
      );
    });
  });

  describe('correlation context integration', () => {
    it('should include correlation context in logs', async () => {
      const testContext = {
        correlationId: 'test-correlation-id',
        userId: 'user-123',
        operation: 'test-operation',
      };

      await CorrelationManager.run(testContext, async () => {
        logger.info('Test with correlation');
      });

      expect(mockPino.info).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'test-correlation-id',
          userId: 'user-123',
        })
      );
    });

    it('should include duration when available', async () => {
      await CorrelationManager.run(
        { correlationId: 'test-id', startTime: Date.now() - 100 },
        async () => {
          logger.info('Test with duration');
        }
      );

      expect(mockPino.info).toHaveBeenCalledWith(
        expect.objectContaining({
          duration: expect.any(Number),
        })
      );
    });
  });

  describe('performance timing', () => {
    it('should time async operations', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');
      
      const result = await logger.time('test-operation', mockFn);
      
      expect(result).toBe('result');
      expect(mockPino.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'Starting operation: test-operation',
        })
      );
      expect(mockPino.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'Operation completed: test-operation',
          performance: expect.objectContaining({
            duration: expect.any(Number),
            operation: 'test-service.test-operation',
          }),
        })
      );
    });

    it('should log errors in timed operations', async () => {
      const error = new Error('Operation failed');
      const mockFn = vi.fn().mockRejectedValue(error);
      
      await expect(logger.time('failing-operation', mockFn)).rejects.toThrow('Operation failed');
      
      expect(mockPino.error).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'Operation failed: failing-operation',
          performance: expect.objectContaining({
            duration: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('child loggers', () => {
    it('should create child logger with additional context', () => {
      const childLogger = logger.child({ component: 'database' });
      
      expect(childLogger).toBeInstanceOf(StructuredLogger);
      expect(mockPino.child).toHaveBeenCalledWith({ component: 'database' });
    });
  });

  describe('custom log levels', () => {
    it('should support custom log levels', () => {
      logger.log('warn', 'Custom warning', { custom: 'metadata' });
      
      expect(mockPino.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          msg: 'Custom warning',
          metadata: { custom: 'metadata' },
        })
      );
    });
  });
});

describe('Logger factory functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createLogger', () => {
    it('should create logger with service name', () => {
      const logger = createLogger('my-service');
      
      expect(logger).toBeInstanceOf(StructuredLogger);
    });

    it('should create logger with custom config', () => {
      const logger = createLogger('my-service', { level: 'debug' });
      
      expect(logger).toBeInstanceOf(StructuredLogger);
    });

    it('should return same instance for same service name and config', () => {
      const logger1 = createLogger('same-service');
      const logger2 = createLogger('same-service');
      
      expect(logger1).toBe(logger2);
    });
  });

  describe('getLogger', () => {
    it('should get or create logger for service', () => {
      const logger = getLogger('another-service');
      
      expect(logger).toBeInstanceOf(StructuredLogger);
    });

    it('should return same instance for same service name', () => {
      const logger1 = getLogger('same-service');
      const logger2 = getLogger('same-service');
      
      expect(logger1).toBe(logger2);
    });
  });
});