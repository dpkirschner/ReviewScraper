import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface CorrelationContext {
  correlationId: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  parentId?: string;
  startTime: number;
  metadata?: Record<string, any>;
}

// AsyncLocalStorage for correlation context
const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Correlation manager for tracking request/operation context across async boundaries
 */
export class CorrelationManager {
  /**
   * Get the current correlation context
   */
  static getContext(): CorrelationContext | undefined {
    return correlationStorage.getStore();
  }

  /**
   * Get the current correlation ID
   */
  static getId(): string | undefined {
    return correlationStorage.getStore()?.correlationId;
  }

  /**
   * Set correlation context for the current async scope
   */
  static setContext(context: Partial<CorrelationContext>): CorrelationContext {
    const existing = correlationStorage.getStore();
    const newContext: CorrelationContext = {
      correlationId: context.correlationId || existing?.correlationId || randomUUID(),
      requestId: context.requestId || existing?.requestId,
      userId: context.userId || existing?.userId,
      sessionId: context.sessionId || existing?.sessionId,
      traceId: context.traceId || existing?.traceId,
      spanId: context.spanId || existing?.spanId,
      parentId: context.parentId || existing?.correlationId,
      startTime: context.startTime || existing?.startTime || Date.now(),
      metadata: { ...existing?.metadata, ...context.metadata },
    };

    return newContext;
  }

  /**
   * Run a function within a correlation context
   */
  static async run<T>(
    context: Partial<CorrelationContext>,
    fn: () => Promise<T>
  ): Promise<T> {
    const newContext = this.setContext(context);
    return correlationStorage.run(newContext, fn);
  }

  /**
   * Run a function within a correlation context (synchronous)
   */
  static runSync<T>(
    context: Partial<CorrelationContext>,
    fn: () => T
  ): T {
    const newContext = this.setContext(context);
    return correlationStorage.run(newContext, fn);
  }

  /**
   * Create a child correlation context
   */
  static createChild(additionalContext?: Partial<CorrelationContext>): CorrelationContext {
    const parent = correlationStorage.getStore();
    
    return {
      correlationId: randomUUID(),
      requestId: parent?.requestId,
      userId: parent?.userId,
      sessionId: parent?.sessionId,
      traceId: parent?.traceId || randomUUID(),
      spanId: randomUUID(),
      parentId: parent?.correlationId,
      startTime: Date.now(),
      metadata: { ...parent?.metadata, ...additionalContext?.metadata },
      ...additionalContext,
    };
  }

  /**
   * Bind a function to the current correlation context
   */
  static bind<T extends (...args: any[]) => any>(fn: T): T {
    const context = correlationStorage.getStore();
    if (!context) {
      return fn;
    }

    return ((...args: Parameters<T>) => {
      return correlationStorage.run(context, () => fn(...args));
    }) as T;
  }

  /**
   * Get formatted context for logging
   */
  static getLogContext(): Record<string, any> {
    const context = correlationStorage.getStore();
    if (!context) {
      return {};
    }

    return {
      correlationId: context.correlationId,
      requestId: context.requestId,
      userId: context.userId,
      sessionId: context.sessionId,
      traceId: context.traceId,
      spanId: context.spanId,
      parentId: context.parentId,
      ...(context.metadata || {}),
    };
  }

  /**
   * Add metadata to the current context
   */
  static addMetadata(metadata: Record<string, any>): void {
    const context = correlationStorage.getStore();
    if (context) {
      context.metadata = { ...context.metadata, ...metadata };
    }
  }

  /**
   * Get operation duration in milliseconds
   */
  static getDuration(): number {
    const context = correlationStorage.getStore();
    if (!context) {
      return 0;
    }

    return Date.now() - context.startTime;
  }
}

/**
 * Decorator for automatically creating correlation context
 */
export function withCorrelation(target: any, propertyName: string, descriptor: PropertyDescriptor) {
  const method = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    const context = CorrelationManager.createChild({
      operation: `${target.constructor.name}.${propertyName}`,
      component: target.constructor.name,
    });

    return CorrelationManager.run(context, () => method.apply(this, args));
  };

  return descriptor;
}

/**
 * Express middleware for correlation context
 */
export function correlationMiddleware() {
  return (req: any, res: any, next: any) => {
    const correlationId = req.headers['x-correlation-id'] || randomUUID();
    const requestId = req.headers['x-request-id'] || randomUUID();
    const userId = req.headers['x-user-id'] || req.user?.id;
    const sessionId = req.headers['x-session-id'] || req.sessionID;

    const context: Partial<CorrelationContext> = {
      correlationId,
      requestId,
      userId,
      sessionId,
      metadata: {
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      },
    };

    // Add correlation ID to response headers
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('x-request-id', requestId);

    CorrelationManager.run(context, () => next());
  };
}