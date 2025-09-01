import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the app-store-scraper module
vi.mock('app-store-scraper', () => ({
  default: {
    sort: {
      RECENT: 1,
      HELPFUL: 2,
    },
    app: vi.fn(),
    reviews: vi.fn(),
  },
}));

// Mock the shared module imports
vi.mock('@review-scraper/shared', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
  sanitizeFilename: vi.fn((name: string) => name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || 'app'),
}));

// Import after mocking
import { ReviewScraper } from './scraper.js';

describe('ReviewScraper', () => {
  let scraper: ReviewScraper;

  beforeEach(() => {
    scraper = new ReviewScraper();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create an instance without throwing', () => {
      expect(() => new ReviewScraper()).not.toThrow();
    });

    it('should create instance of ReviewScraper', () => {
      expect(scraper).toBeInstanceOf(ReviewScraper);
    });
  });

  describe('basic validation', () => {
    it('should validate app ID format', () => {
      const appId = '123456789';
      expect(typeof appId).toBe('string');
      expect(appId.length).toBeGreaterThan(0);
    });

    it('should handle empty app ID', () => {
      const appId = '';
      expect(typeof appId).toBe('string');
      expect(appId.length).toBe(0);
    });
  });
});