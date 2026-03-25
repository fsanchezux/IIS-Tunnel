import type { LocationConfig, BackupConfig } from '../types/config.types.js';
import { FileOpsService } from './file-ops.js';
export declare class BackupService {
    private fileOps;
    constructor(fileOps: FileOpsService);
    createBackup(source: LocationConfig, backupConfig: BackupConfig): Promise<string | null>;
    private rotateBackups;
    private getBackupsList;
    listBackups(backupDir: LocationConfig): Promise<string[]>;
}
//# sourceMappingURL=backup.d.ts.map