import { 
  HealthChecker, 
  DependencyHealth, 
  ServiceHealth, 
  HealthStatus, 
  HealthCheckOptions,
  ReadinessCheck,
  LivenessCheck
} from './types.js';
import { createLogger, StructuredLogger } from '../logging/logger.js';
import { getDatabaseHealthChecker } from '../database/health.js';

export class HealthMonitor {
  private checkers = new Map<string, HealthChecker>();
  private readinessChecks = new Map<string, ReadinessCheck>();
  private livenessChecks = new Map<string, LivenessCheck>();
  private logger: StructuredLogger;
  private serviceName: string;
  private version: string;
  private startTime: Date;
  private lastHealthCheck: ServiceHealth | null = null;
  private checkInterval?: NodeJS.Timeout;

  constructor(serviceName: string, version: string = '1.0.0') {
    this.serviceName = serviceName;
    this.version = version;
    this.startTime = new Date();
    this.logger = createLogger(`${serviceName}:HealthMonitor`);
    
    // Register default checks
    this.registerDefaultChecks();
  }

  private registerDefaultChecks(): void {
    // Database health check
    this.addHealthChecker({
      name: 'database',
      async check(): Promise<DependencyHealth> {
        const startTime = Date.now();
        try {
          const dbHealthChecker = getDatabaseHealthChecker();
          const health = await dbHealthChecker.check();
          
          return {
            name: 'database',
            status: health.status === 'healthy' ? 'healthy' : 
                   health.status === 'degraded' ? 'degraded' : 'unhealthy',
            responseTime: Date.now() - startTime,
            details: {
              connectionCount: health.connectionCount,
              idleConnectionCount: health.idleConnectionCount,
              waitingCount: health.waitingCount,
            },
            error: health.lastError,
            lastChecked: new Date(),
          };
        } catch (error) {
          return {
            name: 'database',
            status: 'unhealthy',
            responseTime: Date.now() - startTime,
            error: error instanceof Error ? error.message : 'Unknown error',
            lastChecked: new Date(),
          };
        }
      },
      options: { critical: true, timeout: 5000 },
    });

    // Memory health check
    this.addHealthChecker({
      name: 'memory',
      async check(): Promise<DependencyHealth> {
        const startTime = Date.now();
        const memUsage = process.memoryUsage();
        const memLimit = parseInt(process.env.MEMORY_LIMIT || '0') || 1024 * 1024 * 1024; // 1GB default
        
        const heapUsedPercent = (memUsage.heapUsed / memLimit) * 100;
        const status: HealthStatus = heapUsedPercent > 90 ? 'unhealthy' :
                                   heapUsedPercent > 75 ? 'degraded' : 'healthy';
        
        return {
          name: 'memory',
          status,
          responseTime: Date.now() - startTime,
          details: {
            ...memUsage,
            heapUsedPercent,
            memLimit,
          },
          lastChecked: new Date(),
        };
      },
      options: { critical: false, timeout: 1000 },
    });

    // Event loop lag check
    this.addHealthChecker({
      name: 'eventloop',
      async check(): Promise<DependencyHealth> {
        const startTime = Date.now();
        
        return new Promise((resolve) => {
          const start = process.hrtime.bigint();
          setImmediate(() => {
            const lag = Number(process.hrtime.bigint() - start) / 1e6; // Convert to milliseconds
            const status: HealthStatus = lag > 100 ? 'unhealthy' :
                                       lag > 50 ? 'degraded' : 'healthy';
            
            resolve({
              name: 'eventloop',
              status,
              responseTime: Date.now() - startTime,
              details: { lag },
              lastChecked: new Date(),
            });
          });
        });
      },
      options: { critical: false, timeout: 2000 },
    });
  }

  /**
   * Add a custom health checker
   */
  addHealthChecker(checker: HealthChecker): void {
    this.checkers.set(checker.name, checker);
    this.logger.debug(`Added health checker: ${checker.name}`);
  }

  /**
   * Remove a health checker
   */
  removeHealthChecker(name: string): boolean {
    const removed = this.checkers.delete(name);
    if (removed) {
      this.logger.debug(`Removed health checker: ${name}`);
    }
    return removed;
  }

  /**
   * Add a readiness check
   */
  addReadinessCheck(check: ReadinessCheck): void {
    this.readinessChecks.set(check.name, check);
    this.logger.debug(`Added readiness check: ${check.name}`);
  }

  /**
   * Add a liveness check
   */
  addLivenessCheck(check: LivenessCheck): void {
    this.livenessChecks.set(check.name, check);
    this.logger.debug(`Added liveness check: ${check.name}`);
  }

  /**
   * Run all health checks and return overall service health
   */
  async checkHealth(): Promise<ServiceHealth> {
    const checkStartTime = Date.now();
    const dependencies: DependencyHealth[] = [];
    let overallStatus: HealthStatus = 'healthy';

    // Run all health checkers
    const checkPromises = Array.from(this.checkers.values()).map(async (checker) => {
      const timeout = checker.options?.timeout || 5000;
      
      try {
        const timeoutPromise = new Promise<DependencyHealth>((_, reject) => {
          setTimeout(() => reject(new Error(`Health check timeout: ${checker.name}`)), timeout);
        });
        
        const checkPromise = checker.check();
        const result = await Promise.race([checkPromise, timeoutPromise]);
        
        // Update overall status based on critical dependencies
        if (checker.options?.critical && result.status === 'unhealthy') {
          overallStatus = 'unhealthy';
        } else if (result.status === 'degraded' && overallStatus === 'healthy') {
          overallStatus = 'degraded';
        }
        
        return result;
      } catch (error) {
        const failedCheck: DependencyHealth = {
          name: checker.name,
          status: 'unhealthy',
          responseTime: timeout,
          error: error instanceof Error ? error.message : 'Unknown error',
          lastChecked: new Date(),
        };
        
        if (checker.options?.critical) {
          overallStatus = 'unhealthy';
        }
        
        return failedCheck;
      }
    });

    dependencies.push(...(await Promise.all(checkPromises)));

    const health: ServiceHealth = {
      service: this.serviceName,
      version: this.version,
      status: overallStatus,
      timestamp: new Date(),
      uptime: Date.now() - this.startTime.getTime(),
      dependencies,
      checks: {
        totalDuration: Date.now() - checkStartTime,
        checkCount: this.checkers.size,
      },
    };

    this.lastHealthCheck = health;
    
    if (overallStatus !== 'healthy') {
      this.logger.warn('Service health degraded', {
        status: overallStatus,
        failedChecks: dependencies
          .filter(d => d.status !== 'healthy')
          .map(d => ({ name: d.name, status: d.status, error: d.error })),
      });
    }

    return health;
  }

  /**
   * Check readiness (all required dependencies are available)
   */
  async checkReadiness(): Promise<{ ready: boolean; checks: Record<string, boolean> }> {
    const checkResults: Record<string, boolean> = {};
    let ready = true;

    const readinessPromises = Array.from(this.readinessChecks.values()).map(async (check) => {
      try {
        const result = await Promise.race([
          check.check(),
          new Promise<boolean>((_, reject) => 
            setTimeout(() => reject(new Error('Readiness check timeout')), 5000)
          ),
        ]);
        
        checkResults[check.name] = result;
        
        if (!result && check.required) {
          ready = false;
        }
        
        return { name: check.name, result, required: check.required };
      } catch (error) {
        checkResults[check.name] = false;
        if (check.required) {
          ready = false;
        }
        
        this.logger.error(`Readiness check failed: ${check.name}`, error);
        return { name: check.name, result: false, required: check.required };
      }
    });

    await Promise.all(readinessPromises);

    return { ready, checks: checkResults };
  }

  /**
   * Check liveness (service is alive and responsive)
   */
  async checkLiveness(): Promise<{ alive: boolean; checks: Record<string, boolean> }> {
    const checkResults: Record<string, boolean> = {};
    let alive = true;

    if (this.livenessChecks.size === 0) {
      // Default liveness check: service has been running for at least 5 seconds
      const uptimeSeconds = (Date.now() - this.startTime.getTime()) / 1000;
      alive = uptimeSeconds > 5;
      checkResults['uptime'] = alive;
      return { alive, checks: checkResults };
    }

    const livenessPromises = Array.from(this.livenessChecks.values()).map(async (check) => {
      try {
        const result = await Promise.race([
          check.check(),
          new Promise<boolean>((_, reject) => 
            setTimeout(() => reject(new Error('Liveness check timeout')), 3000)
          ),
        ]);
        
        checkResults[check.name] = result;
        
        if (!result) {
          alive = false;
        }
        
        return { name: check.name, result };
      } catch (error) {
        checkResults[check.name] = false;
        alive = false;
        
        this.logger.error(`Liveness check failed: ${check.name}`, error);
        return { name: check.name, result: false };
      }
    });

    await Promise.all(livenessPromises);

    return { alive, checks: checkResults };
  }

  /**
   * Start periodic health checking
   */
  startPeriodicChecking(intervalMs = 30000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      try {
        await this.checkHealth();
      } catch (error) {
        this.logger.error('Periodic health check failed', error);
      }
    }, intervalMs);

    this.logger.info(`Started periodic health checking (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop periodic health checking
   */
  stopPeriodicChecking(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
      this.logger.info('Stopped periodic health checking');
    }
  }

  /**
   * Get cached health status (from last check)
   */
  getCachedHealth(): ServiceHealth | null {
    return this.lastHealthCheck;
  }

  /**
   * Get service info
   */
  getServiceInfo() {
    return {
      service: this.serviceName,
      version: this.version,
      startTime: this.startTime,
      uptime: Date.now() - this.startTime.getTime(),
      environment: process.env.NODE_ENV || 'development',
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
    };
  }
}

// Global health monitor instance
let globalHealthMonitor: HealthMonitor | null = null;

export function createHealthMonitor(serviceName: string, version?: string): HealthMonitor {
  if (globalHealthMonitor) {
    throw new Error('Health monitor already exists. Use getHealthMonitor() to get the existing instance.');
  }
  
  globalHealthMonitor = new HealthMonitor(serviceName, version);
  return globalHealthMonitor;
}

export function getHealthMonitor(): HealthMonitor {
  if (!globalHealthMonitor) {
    throw new Error('Health monitor not initialized. Call createHealthMonitor() first.');
  }
  
  return globalHealthMonitor;
}