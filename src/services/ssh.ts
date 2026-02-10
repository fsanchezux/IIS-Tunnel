import { Client, SFTPWrapper } from 'ssh2';
import fs from 'fs-extra';
import { createReadStream } from 'fs';
import type { SSHConfig } from '../types/config.types.js';
import { logger } from './logger.js';

interface SFTPError extends Error {
  code?: number;
}

export class SSHService {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private config: SSHConfig | null = null;
  private connected = false;

  async connect(config: SSHConfig): Promise<void> {
    this.config = config;

    return new Promise((resolve, reject) => {
      this.client = new Client();

      this.client.on('ready', () => {
        logger.info(`SSH connected to ${config.host}:${config.port}`);
        this.connected = true;
        this.getSFTP().then(resolve).catch(reject);
      });

      this.client.on('error', (err) => {
        logger.error(`SSH connection error: ${err.message}`);
        reject(err);
      });

      const connectionConfig: Record<string, unknown> = {
        host: config.host,
        port: config.port,
        username: config.username,
      };

      // Prefer faster ciphers (aes128-gcm) to improve transfer speed on some servers
      // These algorithm preferences can be adjusted if the server does not support them
      (connectionConfig as any).algorithms = {
        cipher: ['aes128-gcm@openssh.com', 'aes128-ctr', 'aes128-cbc'],
        kex: ['curve25519-sha256', 'diffie-hellman-group14-sha1'],
        hmac: ['hmac-sha2-256', 'hmac-sha1']
      };

      if (config.privateKey) {
        connectionConfig.privateKey = fs.readFileSync(config.privateKey, 'utf-8');
      } else if (config.password) {
        connectionConfig.password = config.password;
      }

      this.client.connect(connectionConfig as Parameters<Client['connect']>[0]);
    });
  }

  private getSFTP(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('SSH client not initialized'));
        return;
      }

      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        this.sftp = sftp;
        resolve();
      });
    });
  }

  async readDir(remotePath: string): Promise<string[]> {
    if (!this.sftp) throw new Error('SFTP not connected');

    return new Promise((resolve, reject) => {
      this.sftp!.readdir(remotePath, (err: SFTPError | null | undefined, list) => {
        if (err) {
          if (err.code === 2) {
            resolve([]);
            return;
          }
          reject(new Error(`readDir failed for "${remotePath}": ${err.message}`));
          return;
        }
        resolve(list.map((item) => item.filename));
      });
    });
  }

  async stat(remotePath: string): Promise<{ isDirectory: boolean; isFile: boolean } | null> {
    if (!this.sftp) throw new Error('SFTP not connected');

    return new Promise((resolve, reject) => {
      this.sftp!.stat(remotePath, (err: SFTPError | null | undefined, stats) => {
        if (err) {
          if (err.code === 2) {
            resolve(null);
            return;
          }
          reject(new Error(`stat failed for "${remotePath}": ${err.message}`));
          return;
        }
        resolve({
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
        });
      });
    });
  }

  async mkdir(remotePath: string, recursive = true): Promise<void> {
    if (!this.sftp) throw new Error('SFTP not connected');

    if (recursive) {
      // Handle Windows-style paths (C:/Users/...) on Windows SSH servers
      const isWindowsPath = /^[A-Za-z]:/.test(remotePath);
      const parts = remotePath.split('/').filter(Boolean);
      let currentPath = '';

      if (isWindowsPath) {
        // For Windows paths, start with the drive letter
        currentPath = parts[0]; // e.g., "C:"
        parts.shift(); // Remove drive from parts
      } else if (remotePath.startsWith('/')) {
        currentPath = '';
      } else {
        currentPath = '.';
      }

      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;
        const stats = await this.stat(currentPath);
        if (!stats) {
          await this.mkdirSingle(currentPath);
        }
      }
    } else {
      await this.mkdirSingle(remotePath);
    }
  }

  private mkdirSingle(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp!.mkdir(remotePath, (err: SFTPError | null | undefined) => {
        if (err && err.code !== 4) {
          reject(new Error(`mkdir failed for "${remotePath}": ${err.message}`));
          return;
        }
        resolve();
      });
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    if (!this.sftp) throw new Error('SFTP not connected');

    return new Promise((resolve, reject) => {
      this.sftp!.fastPut(localPath, remotePath, (err) => {
        if (err) reject(new Error(`uploadFile failed: "${localPath}" -> "${remotePath}": ${err.message}`));
        else resolve();
      });
    });
  }

  async uploadFileWithProgress(
    localPath: string,
    remotePath: string,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    if (!this.sftp) throw new Error('SFTP not connected');

    // Get local file size using fs (was incorrectly using sftp.stat on local path)
    const localStats = await fs.stat(localPath);
    const totalSize = localStats.size;
    let uploadedSize = 0;

    return new Promise((resolve, reject) => {
      const writeStream = this.sftp!.createWriteStream(remotePath);

      writeStream.on('error', reject);
      writeStream.on('close', resolve);

      const readStream = createReadStream(localPath);
      readStream.on('data', (chunk: Buffer) => {
        uploadedSize += chunk.length;
        if (onProgress) {
          const percentage = Math.round((uploadedSize / totalSize) * 100);
          onProgress(percentage);
        }
      });

      readStream.on('error', reject);
      readStream.pipe(writeStream);
    });
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    if (!this.sftp) throw new Error('SFTP not connected');

    return new Promise((resolve, reject) => {
      this.sftp!.fastGet(remotePath, localPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.sftp) throw new Error('SFTP not connected');

    return new Promise((resolve, reject) => {
      this.sftp!.unlink(remotePath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async deleteDir(remotePath: string): Promise<void> {
    if (!this.sftp) throw new Error('SFTP not connected');

    const files = await this.readDir(remotePath);

    for (const file of files) {
      const filePath = `${remotePath}/${file}`;
      const stats = await this.stat(filePath);

      if (stats?.isDirectory) {
        await this.deleteDir(filePath);
      } else {
        await this.deleteFile(filePath);
      }
    }

    return new Promise((resolve, reject) => {
      this.sftp!.rmdir(remotePath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async copyDir(srcPath: string, destPath: string): Promise<number> {
    if (!this.sftp) throw new Error('SFTP not connected');

    await this.mkdir(destPath, true);
    const files = await this.readDir(srcPath);
    let count = 0;

    // SFTP uses forward slashes even on Windows SSH servers
    const joinSftp = (base: string, name: string) => `${base.replace(/\\/g, '/')}/${name}`;

    for (const file of files) {
      const srcFilePath = joinSftp(srcPath, file);
      const destFilePath = joinSftp(destPath, file);
      const stats = await this.stat(srcFilePath);

      if (stats?.isDirectory) {
        count += await this.copyDir(srcFilePath, destFilePath);
      } else {
        await this.copyFile(srcFilePath, destFilePath);
        count++;
      }
    }

    return count;
  }

  private async copyFile(srcPath: string, destPath: string): Promise<void> {
    if (!this.client) throw new Error('SSH client not connected');

    const isWindowsPath = /^[A-Za-z]:/.test(srcPath);
    const command = isWindowsPath
      ? `cmd.exe /c copy /y "${srcPath.replace(/\//g, '\\')}" "${destPath.replace(/\//g, '\\')}"`
      : `cp "${srcPath}" "${destPath}"`;

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        stream.on('close', () => resolve());
        stream.on('error', reject);
      });
    });
  }

  async exec(command: string): Promise<string> {
    if (!this.client) throw new Error('SSH client not connected');

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          if (code !== 0 && stderr) {
            reject(new Error(stderr));
          } else {
            resolve(stdout);
          }
        });
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      this.client.end();
      this.connected = false;
      logger.info('SSH connection closed');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export const sshService = new SSHService();
