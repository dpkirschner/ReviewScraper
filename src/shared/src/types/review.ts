import { z } from 'zod';

export const ReviewSchema = z.object({
  id: z.string(),
  userName: z.string(),
  userUrl: z.string().url().optional(),
  version: z.string(),
  score: z.number().min(1).max(5),
  title: z.string(),
  text: z.string(),
  url: z.string().url(),
  date: z.date(),
  replyDate: z.date().optional(),
  replyText: z.string().optional(),
  helpfulVotes: z.number().int().min(0).default(0),
  country: z.string().length(2).toUpperCase(),
});

export type Review = z.infer<typeof ReviewSchema>;

export const AppInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  developer: z.string().optional(),
  category: z.string().optional(),
});

export type AppInfo = z.infer<typeof AppInfoSchema>;

export const ScrapingConfigSchema = z.object({
  countries: z.array(z.string().length(2)).default(['US', 'CN', 'JP', 'GB', 'KR', 'DE', 'FR', 'CA', 'AU', 'IT', 'ES', 'BR', 'RU', 'IN', 'MX']),
  numPages: z.number().int().min(1).max(10).default(10),
  throttleMs: z.number().int().min(100).default(500),
});

export type ScrapingConfig = z.infer<typeof ScrapingConfigSchema>;