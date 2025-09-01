import { z } from 'zod';

export const DatabaseConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1),
  
  // Pool configuration
  max: z.number().int().min(1).max(100).default(20),
  min: z.number().int().min(0).max(10).default(2),
  idleTimeoutMillis: z.number().int().min(1000).default(30000),
  connectionTimeoutMillis: z.number().int().min(1000).default(10000),
  
  // Advanced options
  ssl: z.boolean().default(false),
  applicationName: z.string().default('review-scraper'),
  statementTimeout: z.number().int().min(1000).default(60000),
  queryTimeout: z.number().int().min(1000).default(30000),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export interface DatabaseHealth {
  status: 'healthy' | 'unhealthy' | 'degraded';
  connectionCount: number;
  idleConnectionCount: number;
  waitingCount: number;
  lastError?: string;
  responseTime: number;
}

export interface TransactionContext {
  id: string;
  startTime: Date;
  isolationLevel?: 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}