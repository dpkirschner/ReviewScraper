export class Logger {
  constructor(private context: string = 'App') {}

  info(message: string, ...args: unknown[]): void {
    console.log(`[${new Date().toISOString()}] [${this.context}] INFO: ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`[${new Date().toISOString()}] [${this.context}] WARN: ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`[${new Date().toISOString()}] [${this.context}] ERROR: ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[${new Date().toISOString()}] [${this.context}] DEBUG: ${message}`, ...args);
    }
  }
}