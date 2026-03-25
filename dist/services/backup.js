import fs from 'fs-extra';
import path from 'path';
import { logger } from './logger.js';
export class BackupService {
    fileOps;
    constructor(fileOps) {
        this.fileOps = fileOps;
    }
    async createBackup(source, backupConfig) {
        const sourceExists = await this.fileOps.exists(source);
        if (!sourceExists) {
            logger.warn(`Source directory ${source.path} does not exist. Skipping backup.`);
            return null;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `backup-${timestamp}`;
        // Create backup location config
        // Normalize to forward slashes for SFTP compatibility (works on both Unix and Windows SSH servers)
        const backupBasePath = backupConfig.path.replace(/\\/g, '/');
        const backupLocation = {
            type: source.type,
            path: source.type === 'local'
                ? path.join(backupConfig.path, backupName)
                : `${backupBasePath}/${backupName}`,
            ssh: source.ssh,
        };
        // Ensure backup directory exists
        const backupDir = {
            type: source.type,
            path: source.type === 'local' ? backupConfig.path : backupBasePath,
            ssh: source.ssh,
        };
        await this.fileOps.ensureDir(backupDir);
        logger.info(`Creating backup: ${backupLocation.path}`);
        const filesCount = await this.fileOps.copyFiles(source, backupLocation);
        logger.success(`Backup created with ${filesCount} files: ${backupLocation.path}`);
        // Rotate old backups
        await this.rotateBackups(backupDir, backupConfig.maxBackups);
        return backupLocation.path;
    }
    async rotateBackups(backupDir, maxBackups) {
        logger.info(`Rotating backups (keeping last ${maxBackups})`);
        const backups = await this.getBackupsList(backupDir);
        if (backups.length <= maxBackups) {
            logger.info(`Found ${backups.length} backups, no rotation needed`);
            return;
        }
        // Sort by date (oldest first based on backup name)
        backups.sort((a, b) => a.localeCompare(b));
        const toDelete = backups.slice(0, backups.length - maxBackups);
        for (const backup of toDelete) {
            const backupPath = backupDir.type === 'local'
                ? path.join(backupDir.path, backup)
                : `${backupDir.path}/${backup}`;
            logger.info(`Deleting old backup: ${backupPath}`);
            if (backupDir.type === 'local') {
                await fs.remove(backupPath);
            }
            else {
                const ssh = await this.fileOps.ensureSSHConnection(backupDir);
                if (ssh) {
                    await ssh.deleteDir(backupPath);
                }
            }
        }
        logger.success(`Deleted ${toDelete.length} old backup(s)`);
    }
    async getBackupsList(backupDir) {
        const files = await this.fileOps.listFiles(backupDir);
        return files.filter((f) => f.startsWith('backup-'));
    }
    async listBackups(backupDir) {
        return this.getBackupsList(backupDir);
    }
}
//# sourceMappingURL=backup.js.map