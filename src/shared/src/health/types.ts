import { z } from 'zod';

export const HealthStatusSchema = z.enum(['healthy', 'unhealthy', 'degraded']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const DependencyHealthSchema = z.object({
  name: z.string(),
  status: HealthStatusSchema,
  responseTime: z.number().min(0),
  error: z.string().optional(),
  details: z.record(z.any()).optional(),
  lastChecked: z.date(),
});

export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

export const ServiceHealthSchema = z.object({
  service: z.string(),
  version: z.string(),
  status: HealthStatusSchema,
  timestamp: z.date(),
  uptime: z.number().min(0),
  dependencies: z.array(DependencyHealthSchema),
  checks: z.record(z.any()).optional(),
  metadata: z.record(z.any()).optional(),
});

export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

export interface HealthCheckOptions {
  timeout?: number;
  interval?: number;
  enabled?: boolean;
  critical?: boolean; // If true, failure affects overall service health
}

export interface HealthChecker {
  name: string;
  check(): Promise<DependencyHealth>;
  options?: HealthCheckOptions;
}

export interface MetricsData {
  timestamp: Date;
  service: string;
  version: string;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  cpu: {
    user: number;
    system: number;
  };
  eventLoop: {
    delay: number;
  };
  gc?: {
    count: number;
    duration: number;
  };
  custom?: Record<string, number>;
}

export interface ReadinessCheck {
  name: string;
  check(): Promise<boolean>;
  required: boolean;
}

export interface LivenessCheck {
  name: string;
  check(): Promise<boolean>;
}