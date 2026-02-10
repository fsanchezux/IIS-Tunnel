import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import type { LogEntry, LoggingConfig } from '../types/config.types.js';

export class Logger {
  private entries: LogEntry[] = [];
  private config: LoggingConfig | null = null;
  private sessionId: string;

  constructor() {
    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  }

  setConfig(config: LoggingConfig): void {
    this.config = config;
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.log('info', message, details);
  }

  success(message: string, details?: Record<string, unknown>): void {
    this.log('success', message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.log('warn', message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.log('error', message, details);
  }

  private log(level: LogEntry['level'], message: string, details?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      details,
    };
    this.entries.push(entry);
  }

  async save(): Promise<void> {
    if (!this.config) {
      throw new Error('Logger configuration not set. Call setConfig() first.');
    }

    await fs.ensureDir(this.config.path);

    const logFilePath = path.join(this.config.path, `${this.config.filename}-${this.sessionId}.log`);
    const jsonFilePath = path.join(this.config.path, `${this.config.filename}-${this.sessionId}.json`);

    // Save text log
    const textContent = this.entries
      .map((entry) => {
        const levelTag = `[${entry.level.toUpperCase()}]`.padEnd(9);
        const detailsStr = entry.details ? ` | ${JSON.stringify(entry.details)}` : '';
        return `${entry.timestamp} ${levelTag} ${entry.message}${detailsStr}`;
      })
      .join('\n');

    await fs.writeFile(logFilePath, textContent + '\n', 'utf-8');

    // Save JSON log
    const jsonContent = {
      sessionId: this.sessionId,
      startTime: this.entries[0]?.timestamp || new Date().toISOString(),
      endTime: this.entries[this.entries.length - 1]?.timestamp || new Date().toISOString(),
      totalEntries: this.entries.length,
      entries: this.entries,
    };

    await fs.writeFile(jsonFilePath, JSON.stringify(jsonContent, null, 2), 'utf-8');

    console.log(chalk.gray(`Logs saved to: ${logFilePath}`));
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  hasErrors(): boolean {
    return this.entries.some((e) => e.level === 'error');
  }
}

export const logger = new Logger();
