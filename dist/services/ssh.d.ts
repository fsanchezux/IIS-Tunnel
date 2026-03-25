import type { SSHConfig } from '../types/config.types.js';
export declare class SSHService {
    private client;
    private sftp;
    private config;
    private connected;
    connect(config: SSHConfig): Promise<void>;
    private getSFTP;
    readDir(remotePath: string): Promise<string[]>;
    stat(remotePath: string): Promise<{
        isDirectory: boolean;
        isFile: boolean;
    } | null>;
    mkdir(remotePath: string, recursive?: boolean): Promise<void>;
    private mkdirSingle;
    uploadFile(localPath: string, remotePath: string): Promise<void>;
    uploadFileWithProgress(localPath: string, remotePath: string, onProgress?: (progress: number) => void): Promise<void>;
    downloadFile(remotePath: string, localPath: string): Promise<void>;
    deleteFile(remotePath: string): Promise<void>;
    deleteDir(remotePath: string): Promise<void>;
    copyDir(srcPath: string, destPath: string): Promise<number>;
    private copyFile;
    exec(command: string): Promise<string>;
    clearWindowsDirContents(remotePath: string): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
}
export declare const sshService: SSHService;
//# sourceMappingURL=ssh.d.ts.map