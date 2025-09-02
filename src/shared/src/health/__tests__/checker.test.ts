import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HealthMonitor, createHealthMonitor, getHealthMonitor, closeHealthMonitor } from '../checker.js';
import { HealthChecker, DependencyHealth, ReadinessCheck, LivenessCheck } from '../types.js';

// Mock the database health checker
vi.mock('../../database/health.js', () => ({
  getDatabaseHealthChecker: vi.fn(() => ({
    check: vi.fn().mockResolvedValue({
      name: 'database',
      status: 'healthy',
      connectionCount: 5,
      idleConnectionCount: 3,
      waitingCount: 0,
      responseTime: 10,
      lastChecked: new Date(),
    }),
  })),
}));

describe('HealthMonitor', () => {
  let healthMonitor: HealthMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    healthMonitor = new HealthMonitor('test-service', '1.0.0');
  });

  afterEach(() => {
    healthMonitor.stopPeriodicChecking();
  });

  describe('constructor', () => {
    it('should create health monitor with service name and version', () => {
      expect(healthMonitor).toBeInstanceOf(HealthMonitor);
      
      const serviceInfo = healthMonitor.getServiceInfo();
      expect(serviceInfo.service).toBe('test-service');
      expect(serviceInfo.version).toBe('1.0.0');
      expect(serviceInfo.startTime).toBeInstanceOf(Date);
    });
  });

  describe('health checking', () => {
    it('should perform health check with default checkers', async () => {
      const health = await healthMonitor.checkHealth();
      
      expect(health.service).toBe('test-service');
      expect(health.version).toBe('1.0.0');
      expect(health.status).toBe('healthy');
      expect(health.dependencies).toBeDefined();
      expect(health.dependencies.length).toBeGreaterThan(0);
      
      // Should include database, memory, and eventloop checks
      const checkNames = health.dependencies.map(d => d.name);
      expect(checkNames).toContain('database');
      expect(checkNames).toContain('memory');
      expect(checkNames).toContain('eventloop');
    });

    it('should handle unhealthy critical dependencies', async () => {
      // Add a failing critical checker
      const failingChecker: HealthChecker = {
        name: 'critical-service',
        async check(): Promise<DependencyHealth> {
          throw new Error('Service unavailable');
        },
        options: { critical: true },
      };
      
      healthMonitor.addHealthChecker(failingChecker);
      
      const health = await healthMonitor.checkHealth();
      expect(health.status).toBe('unhealthy');
      
      const criticalCheck = health.dependencies.find(d => d.name === 'critical-service');
      expect(criticalCheck).toBeDefined();
      expect(criticalCheck!.status).toBe('unhealthy');
      expect(criticalCheck!.error).toContain('Service unavailable');
    });

    it('should handle degraded non-critical dependencies', async () => {
      const degradedChecker: HealthChecker = {
        name: 'slow-service',
        async check(): Promise<DependencyHealth> {
          return {
            name: 'slow-service',
            status: 'degraded',
            responseTime: 500,
            lastChecked: new Date(),
          };
        },
        options: { critical: false },
      };
      
      healthMonitor.addHealthChecker(degradedChecker);
      
      const health = await healthMonitor.checkHealth();
      expect(health.status).toBe('degraded');
      
      const degradedCheck = health.dependencies.find(d => d.name === 'slow-service');
      expect(degradedCheck!.status).toBe('degraded');
    });

    it('should handle checker timeouts', async () => {
      const slowChecker: HealthChecker = {
        name: 'slow-checker',
        async check(): Promise<DependencyHealth> {
          await new Promise(resolve => setTimeout(resolve, 200)); // Slow check
          return {
            name: 'slow-checker',
            status: 'healthy',
            responseTime: 200,
            lastChecked: new Date(),
          };
        },
        options: { timeout: 100 }, // Short timeout
      };
      
      healthMonitor.addHealthChecker(slowChecker);
      
      const health = await healthMonitor.checkHealth();
      
      const timeoutCheck = health.dependencies.find(d => d.name === 'slow-checker');
      expect(timeoutCheck!.status).toBe('unhealthy');
      expect(timeoutCheck!.error).toContain('timeout');
    });
  });

  describe('readiness checks', () => {
    it('should check readiness with all required checks passing', async () => {
      const readinessCheck: ReadinessCheck = {
        name: 'required-service',
        required: true,
        async check(): Promise<boolean> {
          return true;
        },
      };
      
      healthMonitor.addReadinessCheck(readinessCheck);
      
      const result = await healthMonitor.checkReadiness();
      
      expect(result.ready).toBe(true);
      expect(result.checks['required-service']).toBe(true);
    });

    it('should fail readiness when required check fails', async () => {
      const failingReadinessCheck: ReadinessCheck = {
        name: 'failing-required-service',
        required: true,
        async check(): Promise<boolean> {
          return false;
        },
      };
      
      healthMonitor.addReadinessCheck(failingReadinessCheck);
      
      const result = await healthMonitor.checkReadiness();
      
      expect(result.ready).toBe(false);
      expect(result.checks['failing-required-service']).toBe(false);
    });

    it('should pass readiness when optional check fails', async () => {
      const optionalCheck: ReadinessCheck = {
        name: 'optional-service',
        required: false,
        async check(): Promise<boolean> {
          return false;
        },
      };
      
      healthMonitor.addReadinessCheck(optionalCheck);
      
      const result = await healthMonitor.checkReadiness();
      
      expect(result.ready).toBe(true);
      expect(result.checks['optional-service']).toBe(false);
    });
  });

  describe('liveness checks', () => {
    it('should check liveness with default uptime check', async () => {
      // Create a monitor that's been running longer than 5 seconds
      const oldMonitor = new HealthMonitor('old-service', '1.0.0');
      // Mock the start time to be 6 seconds ago
      (oldMonitor as any).startTime = new Date(Date.now() - 6000);
      
      const result = await oldMonitor.checkLiveness();
      
      expect(result.alive).toBe(true);
      expect(result.checks.uptime).toBe(true);
      
      oldMonitor.stopPeriodicChecking();
    });

    it('should check liveness with custom checks', async () => {
      const livenessCheck: LivenessCheck = {
        name: 'custom-liveness',
        async check(): Promise<boolean> {
          return true;
        },
      };
      
      healthMonitor.addLivenessCheck(livenessCheck);
      
      const result = await healthMonitor.checkLiveness();
      
      expect(result.alive).toBe(true);
      expect(result.checks['custom-liveness']).toBe(true);
    });

    it('should fail liveness when any check fails', async () => {
      const failingLivenessCheck: LivenessCheck = {
        name: 'failing-liveness',
        async check(): Promise<boolean> {
          return false;
        },
      };
      
      healthMonitor.addLivenessCheck(failingLivenessCheck);
      
      const result = await healthMonitor.checkLiveness();
      
      expect(result.alive).toBe(false);
      expect(result.checks['failing-liveness']).toBe(false);
    });
  });

  describe('periodic checking', () => {
    it('should start and stop periodic checking', () => {
      expect(() => {
        healthMonitor.startPeriodicChecking(1000);
        healthMonitor.stopPeriodicChecking();
      }).not.toThrow();
    });

    it('should cache health check results', async () => {
      const health = await healthMonitor.checkHealth();
      const cachedHealth = healthMonitor.getCachedHealth();
      
      expect(cachedHealth).toBe(health);
    });
  });

  describe('service info', () => {
    it('should provide complete service information', () => {
      const info = healthMonitor.getServiceInfo();
      
      expect(info.service).toBe('test-service');
      expect(info.version).toBe('1.0.0');
      expect(info.startTime).toBeInstanceOf(Date);
      expect(info.uptime).toBeGreaterThanOrEqual(0);
      expect(info.environment).toBeDefined();
      expect(info.nodeVersion).toBeDefined();
      expect(info.platform).toBeDefined();
      expect(info.pid).toBeDefined();
    });
  });
});

describe('Health monitor factory functions', () => {
  afterEach(() => {
    // Clean up global instance
    closeHealthMonitor();
  });

  describe('createHealthMonitor', () => {
    it('should create global health monitor instance', () => {
      const monitor = createHealthMonitor('factory-test-service');
      
      expect(monitor).toBeInstanceOf(HealthMonitor);
      
      const sameMonitor = getHealthMonitor();
      expect(sameMonitor).toBe(monitor);
    });

    it('should throw error when creating monitor twice', () => {
      createHealthMonitor('factory-test-service');
      
      expect(() => createHealthMonitor('another-service')).toThrow(
        'Health monitor already exists. Use getHealthMonitor() to get the existing instance.'
      );
    });
  });
});