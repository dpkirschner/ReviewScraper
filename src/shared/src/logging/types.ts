import { z } from 'zod';

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogFormatSchema = z.enum(['json', 'pretty']);
export type LogFormat = z.infer<typeof LogFormatSchema>;

export const LogConfigSchema = z.object({
  level: LogLevelSchema.default('info'),
  format: LogFormatSchema.default('json'),
  service: z.string().optional(),
  version: z.string().optional(),
  environment: z.string().optional(),
  
  // File logging options
  file: z.object({
    enabled: z.boolean().default(false),
    path: z.string().optional(),
    maxSize: z.string().default('10MB'),
    maxFiles: z.number().int().min(1).default(5),
  }).optional(),
  
  // Performance options
  redact: z.array(z.string()).default([
    'password', 'token', 'secret', 'key', 'auth', 'authorization'
  ]),
  
  // Sampling for high-volume logs
  sampling: z.object({
    enabled: z.boolean().default(false),
    rate: z.number().min(0).max(1).default(0.1), // 10% sampling
  }).optional(),
});

export type LogConfig = z.infer<typeof LogConfigSchema>;

export interface LogContext {
  correlationId?: string;
  userId?: string;
  requestId?: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  operation?: string;
  component?: string;
  [key: string]: any;
}

export interface StructuredLogData {
  timestamp: string;
  level: LogLevel;
  message: string;
  service?: string;
  version?: string;
  environment?: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  performance?: {
    duration?: number;
    memory?: NodeJS.MemoryUsage;
  };
  metadata?: Record<string, any>;
}