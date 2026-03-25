import type { LocationConfig } from '../types/config.types.js';
import { SSHService } from './ssh.js';
export declare class FileOpsService {
    private sshConnections;
    private toSshPath;
    private joinPath;
    ensureSSHConnection(location: LocationConfig): Promise<SSHService | null>;
    copyFiles(source: LocationConfig, dest: LocationConfig, folders?: (string | {
        [key: string]: string[];
    })[] | null): Promise<number>;
    private copySpecificFolders;
    private copySpecificFiles;
    private copyLocalToLocal;
    private copyLocalToSSH;
    private uploadDirectory;
    private copySSHToLocal;
    private downloadDirectory;
    deleteContents(location: LocationConfig): Promise<void>;
    private deleteLocalContents;
    private deleteSSHContents;
    listFiles(location: LocationConfig): Promise<string[]>;
    exists(location: LocationConfig): Promise<boolean>;
    ensureDir(location: LocationConfig): Promise<void>;
    private countFiles;
    countFilesInDirectory(dirPath: string): Promise<number>;
    closeAllConnections(): Promise<void>;
    compressFiles(sourcePath: string, outputPath: string, onProgress?: (progress: number) => void): Promise<void>;
    private compressWithPowerShell;
    private compressWithArchiver;
    private compressWith7Zip;
    private getDirectorySize;
    decompressFiles(zipPath: string, outputPath: string): Promise<void>;
    copyToTemp(source: LocationConfig, staging: LocationConfig, folders: (string | {
        [key: string]: string[];
    })[] | null | undefined, tempDir: string, files?: string[] | null): Promise<number>;
    private copyLooseFiles;
    transferFile(localZipPath: string, stagingLocation: LocationConfig, fileName: string, onProgress?: (progress: number) => void): Promise<void>;
    decompressFilesRemote(stagingLocation: LocationConfig, zipFileName: string): Promise<void>;
    generateUpdateBat(staging: LocationConfig, destination: LocationConfig, backup: {
        path: string;
        maxBackups?: number;
    }, sourceFolders?: (string | {
        [key: string]: string[];
    })[] | null): string;
    generateRestoreBat(staging: LocationConfig, destination: LocationConfig, backup: {
        path: string;
        maxBackups?: number;
    }): string;
    uploadWindowsBats(localTempDir: string, staging: LocationConfig, destination: LocationConfig, backup: {
        path: string;
        maxBackups?: number;
    }, sourceFolders?: (string | {
        [key: string]: string[];
    })[] | null): Promise<void>;
    uploadAndExecuteRestoreBat(staging: LocationConfig, destination: LocationConfig, backup: {
        path: string;
        maxBackups?: number;
    }): Promise<void>;
    deleteRestoreBat(staging: LocationConfig): Promise<void>;
    private generateCopyCommands;
    private isSameSSHServer;
    copyFilesOnRemoteServer(stagingPath: string, destinationPath: string, ssh: SSHService): Promise<number>;
    canUseSameSSHConnection(staging: LocationConfig, destination: LocationConfig): Promise<boolean>;
}
export declare const fileOpsService: FileOpsService;
//# sourceMappingURL=file-ops.d.ts.map