import { z } from 'zod';
import { config } from 'dotenv';

config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
});

export const env = envSchema.parse(process.env);