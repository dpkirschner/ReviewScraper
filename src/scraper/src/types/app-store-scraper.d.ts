declare module 'app-store-scraper' {
  interface AppStoreOptions {
    id: string;
    country?: string;
    page?: number;
    sort?: number;
    throttle?: number;
  }

  interface Review {
    id: string;
    userName: string;
    userUrl: string;
    version: string;
    score: number;
    title: string;
    text: string;
    url: string;
    date: Date;
  }

  export const sort: {
    RECENT: number;
    HELPFUL: number;
  };

  export function reviews(options: AppStoreOptions): Promise<Review[]>;
  export function app(options: { id: string; country?: string }): Promise<any>;
  export function search(options: { term: string; country?: string; num?: number }): Promise<any[]>;
  export function suggest(options: { term: string; country?: string }): Promise<string[]>;
  export function similar(options: { id: string; country?: string }): Promise<any[]>;
}