import type { LogEntry, LoggingConfig } from '../types/config.types.js';
export declare class Logger {
    private entries;
    private config;
    private sessionId;
    constructor();
    setConfig(config: LoggingConfig): void;
    info(message: string, details?: Record<string, unknown>): void;
    success(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
    error(message: string, details?: Record<string, unknown>): void;
    private log;
    save(): Promise<void>;
    getEntries(): LogEntry[];
    hasErrors(): boolean;
}
export declare const logger: Logger;
//# sourceMappingURL=logger.d.ts.map