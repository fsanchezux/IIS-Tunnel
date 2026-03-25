import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
export class Logger {
    entries = [];
    config = null;
    sessionId;
    constructor() {
        this.sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    }
    setConfig(config) {
        this.config = config;
    }
    info(message, details) {
        this.log('info', message, details);
    }
    success(message, details) {
        this.log('success', message, details);
    }
    warn(message, details) {
        this.log('warn', message, details);
    }
    error(message, details) {
        this.log('error', message, details);
    }
    log(level, message, details) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            details,
        };
        this.entries.push(entry);
    }
    async save() {
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
    getEntries() {
        return [...this.entries];
    }
    hasErrors() {
        return this.entries.some((e) => e.level === 'error');
    }
}
export const logger = new Logger();
//# sourceMappingURL=logger.js.map