import { MetricsData } from './types.js';
import { createLogger, StructuredLogger } from '../logging/logger.js';

export class MetricsCollector {
  private logger: StructuredLogger;
  private serviceName: string;
  private version: string;
  private startTime: Date;
  private customMetrics = new Map<string, number>();
  private lastGCStats: any = null;
  private collectionInterval?: NodeJS.Timeout;

  constructor(serviceName: string, version: string = '1.0.0') {
    this.serviceName = serviceName;
    this.version = version;
    this.startTime = new Date();
    this.logger = createLogger(`${serviceName}:MetricsCollector`);
    
    // Try to enable GC monitoring if available
    this.setupGCMonitoring();
  }

  private setupGCMonitoring(): void {
    try {
      // This requires running Node.js with --expose-gc flag
      if (global.gc && typeof global.gc === 'function') {
        const { PerformanceObserver, performance } = require('perf_hooks');
        
        let gcCount = 0;
        let gcDuration = 0;

        const observer = new PerformanceObserver((list: any) => {
          const entries = list.getEntries();
          for (const entry of entries) {
            if (entry.entryType === 'gc') {
              gcCount++;
              gcDuration += entry.duration;
            }
          }
        });

        observer.observe({ entryTypes: ['gc'] });

        this.lastGCStats = {
          getStats: () => ({ count: gcCount, duration: gcDuration }),
        };

        this.logger.debug('GC monitoring enabled');
      }
    } catch (error) {
      this.logger.debug('GC monitoring not available', { error: (error as Error).message });
    }
  }

  /**
   * Collect current system metrics
   */
  collectMetrics(): MetricsData {
    const now = new Date();
    const uptime = now.getTime() - this.startTime.getTime();
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    // Calculate event loop delay
    const eventLoopDelay = this.measureEventLoopDelay();

    const metrics: MetricsData = {
      timestamp: now,
      service: this.serviceName,
      version: this.version,
      uptime,
      memory: memoryUsage,
      cpu: {
        user: cpuUsage.user / 1000, // Convert to milliseconds
        system: cpuUsage.system / 1000,
      },
      eventLoop: {
        delay: eventLoopDelay,
      },
    };

    // Add GC stats if available
    if (this.lastGCStats) {
      try {
        metrics.gc = this.lastGCStats.getStats();
      } catch (error) {
        // GC stats might not be available
      }
    }

    // Add custom metrics
    if (this.customMetrics.size > 0) {
      metrics.custom = Object.fromEntries(this.customMetrics);
    }

    return metrics;
  }

  private measureEventLoopDelay(): number {
    // Simple event loop delay measurement
    const start = process.hrtime.bigint();
    
    return new Promise<number>((resolve) => {
      setImmediate(() => {
        const delay = Number(process.hrtime.bigint() - start) / 1e6; // Convert to milliseconds
        resolve(delay);
      });
    }) as any; // Return synchronously for simplicity
  }

  /**
   * Set a custom metric
   */
  setCustomMetric(name: string, value: number): void {
    this.customMetrics.set(name, value);
  }

  /**
   * Increment a custom metric
   */
  incrementCustomMetric(name: string, delta: number = 1): void {
    const current = this.customMetrics.get(name) || 0;
    this.customMetrics.set(name, current + delta);
  }

  /**
   * Get a custom metric value
   */
  getCustomMetric(name: string): number | undefined {
    return this.customMetrics.get(name);
  }

  /**
   * Remove a custom metric
   */
  removeCustomMetric(name: string): boolean {
    return this.customMetrics.delete(name);
  }

  /**
   * Get all custom metrics
   */
  getAllCustomMetrics(): Record<string, number> {
    return Object.fromEntries(this.customMetrics);
  }

  /**
   * Start periodic metrics collection
   */
  startPeriodicCollection(intervalMs: number = 60000, callback?: (metrics: MetricsData) => void): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }

    this.collectionInterval = setInterval(() => {
      try {
        const metrics = this.collectMetrics();
        
        if (callback) {
          callback(metrics);
        } else {
          // Default: log metrics at debug level
          this.logger.debug('System metrics collected', {
            memory: {
              heapUsed: Math.round(metrics.memory.heapUsed / 1024 / 1024), // MB
              heapTotal: Math.round(metrics.memory.heapTotal / 1024 / 1024), // MB
              external: Math.round(metrics.memory.external / 1024 / 1024), // MB
            },
            cpu: metrics.cpu,
            uptime: Math.round(metrics.uptime / 1000), // seconds
            eventLoopDelay: metrics.eventLoop.delay,
            customMetrics: Object.keys(metrics.custom || {}).length,
          });
        }
      } catch (error) {
        this.logger.error('Failed to collect metrics', error);
      }
    }, intervalMs);

    this.logger.info(`Started periodic metrics collection (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop periodic metrics collection
   */
  stopPeriodicCollection(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = undefined;
      this.logger.info('Stopped periodic metrics collection');
    }
  }

  /**
   * Get Prometheus-format metrics (basic implementation)
   */
  getPrometheusMetrics(): string {
    const metrics = this.collectMetrics();
    const lines: string[] = [];

    // Helper function to add metric
    const addMetric = (name: string, value: number, help: string, labels: Record<string, string> = {}) => {
      const labelString = Object.entries(labels)
        .map(([key, val]) => `${key}="${val}"`)
        .join(',');
      
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}{${labelString}} ${value}`);
    };

    const commonLabels = {
      service: this.serviceName,
      version: this.version,
    };

    // System metrics
    addMetric('nodejs_memory_heap_used_bytes', metrics.memory.heapUsed, 'Process heap memory used', commonLabels);
    addMetric('nodejs_memory_heap_total_bytes', metrics.memory.heapTotal, 'Process heap memory total', commonLabels);
    addMetric('nodejs_memory_external_bytes', metrics.memory.external, 'Process external memory', commonLabels);
    addMetric('nodejs_memory_rss_bytes', metrics.memory.rss, 'Process resident memory size', commonLabels);
    
    addMetric('nodejs_cpu_user_seconds_total', metrics.cpu.user / 1000, 'Process CPU user time', commonLabels);
    addMetric('nodejs_cpu_system_seconds_total', metrics.cpu.system / 1000, 'Process CPU system time', commonLabels);
    
    addMetric('nodejs_eventloop_delay_seconds', metrics.eventLoop.delay / 1000, 'Event loop delay', commonLabels);
    addMetric('nodejs_uptime_seconds', metrics.uptime / 1000, 'Process uptime', commonLabels);

    // GC metrics if available
    if (metrics.gc) {
      addMetric('nodejs_gc_runs_total', metrics.gc.count, 'Number of GC runs', commonLabels);
      addMetric('nodejs_gc_duration_seconds_total', metrics.gc.duration / 1000, 'Total GC duration', commonLabels);
    }

    // Custom metrics
    if (metrics.custom) {
      Object.entries(metrics.custom).forEach(([name, value]) => {
        addMetric(`custom_${name}`, value, `Custom metric: ${name}`, commonLabels);
      });
    }

    return lines.join('\n') + '\n';
  }
}

// Global metrics collector instance
let globalMetricsCollector: MetricsCollector | null = null;

export function createMetricsCollector(serviceName: string, version?: string): MetricsCollector {
  if (globalMetricsCollector) {
    throw new Error('Metrics collector already exists. Use getMetricsCollector() to get the existing instance.');
  }
  
  globalMetricsCollector = new MetricsCollector(serviceName, version);
  return globalMetricsCollector;
}

export function getMetricsCollector(): MetricsCollector {
  if (!globalMetricsCollector) {
    throw new Error('Metrics collector not initialized. Call createMetricsCollector() first.');
  }
  
  return globalMetricsCollector;
}