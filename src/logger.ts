export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

/** Default logger writing to the platform console. */
export const consoleLogger: Logger = {
  debug: (message, details) => {
    console.debug(message, details);
  },
  info: (message, details) => {
    console.info(message, details);
  },
  warn: (message, details) => {
    console.warn(message, details);
  },
  error: (message, details) => {
    console.error(message, details);
  },
};

/** Logger that discards everything; useful in tests and quiet pipelines. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
