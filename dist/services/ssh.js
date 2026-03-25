import { Client } from 'ssh2';
import fs from 'fs-extra';
import { createReadStream } from 'fs';
import { logger } from './logger.js';
export class SSHService {
    client = null;
    sftp = null;
    config = null;
    connected = false;
    async connect(config) {
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
            const connectionConfig = {
                host: config.host,
                port: config.port,
                username: config.username,
            };
            // Prefer faster ciphers (aes128-gcm) to improve transfer speed on some servers
            // These algorithm preferences can be adjusted if the server does not support them
            connectionConfig.algorithms = {
                cipher: ['aes128-gcm@openssh.com', 'aes128-ctr', 'aes128-cbc'],
                kex: ['curve25519-sha256', 'diffie-hellman-group14-sha1'],
                hmac: ['hmac-sha2-256', 'hmac-sha1']
            };
            if (config.privateKey) {
                connectionConfig.privateKey = fs.readFileSync(config.privateKey, 'utf-8');
            }
            else if (config.password) {
                connectionConfig.password = config.password;
            }
            this.client.connect(connectionConfig);
        });
    }
    getSFTP() {
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
    async readDir(remotePath) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        return new Promise((resolve, reject) => {
            this.sftp.readdir(remotePath, (err, list) => {
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
    async stat(remotePath) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        return new Promise((resolve, reject) => {
            this.sftp.stat(remotePath, (err, stats) => {
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
    async mkdir(remotePath, recursive = true) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        if (!recursive) {
            return this.mkdirSingle(remotePath);
        }
        const parts = remotePath.split('/').filter(Boolean);
        let currentPath = remotePath.startsWith('/') ? '' : '.';
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;
            const stats = await this.stat(currentPath);
            if (!stats) {
                await this.mkdirSingle(currentPath);
            }
        }
    }
    mkdirSingle(remotePath) {
        return new Promise((resolve, reject) => {
            this.sftp.mkdir(remotePath, (err) => {
                if (err && err.code !== 4) {
                    reject(new Error(`mkdir failed for "${remotePath}": ${err.message}`));
                    return;
                }
                resolve();
            });
        });
    }
    async uploadFile(localPath, remotePath) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        return new Promise((resolve, reject) => {
            this.sftp.fastPut(localPath, remotePath, (err) => {
                if (err)
                    reject(new Error(`uploadFile failed: "${localPath}" -> "${remotePath}": ${err.message}`));
                else
                    resolve();
            });
        });
    }
    async uploadFileWithProgress(localPath, remotePath, onProgress) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        const localStats = await fs.stat(localPath);
        const totalSize = localStats.size;
        let uploadedSize = 0;
        return new Promise((resolve, reject) => {
            const writeStream = this.sftp.createWriteStream(remotePath);
            writeStream.on('error', reject);
            writeStream.on('close', resolve);
            const readStream = createReadStream(localPath);
            readStream.on('data', (chunk) => {
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
    async downloadFile(remotePath, localPath) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        return new Promise((resolve, reject) => {
            this.sftp.fastGet(remotePath, localPath, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async deleteFile(remotePath) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        return new Promise((resolve, reject) => {
            this.sftp.unlink(remotePath, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async deleteDir(remotePath) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        const files = await this.readDir(remotePath);
        for (const file of files) {
            const filePath = `${remotePath}/${file}`;
            const stats = await this.stat(filePath);
            if (stats?.isDirectory) {
                await this.deleteDir(filePath);
            }
            else {
                await this.deleteFile(filePath);
            }
        }
        return new Promise((resolve, reject) => {
            this.sftp.rmdir(remotePath, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async copyDir(srcPath, destPath) {
        if (!this.sftp)
            throw new Error('SFTP not connected');
        await this.mkdir(destPath, true);
        const files = await this.readDir(srcPath);
        let count = 0;
        // SFTP uses forward slashes even on Windows SSH servers
        const joinSftp = (base, name) => `${base.replace(/\\/g, '/')}/${name}`;
        for (const file of files) {
            const srcFilePath = joinSftp(srcPath, file);
            const destFilePath = joinSftp(destPath, file);
            const stats = await this.stat(srcFilePath);
            if (stats?.isDirectory) {
                count += await this.copyDir(srcFilePath, destFilePath);
            }
            else {
                await this.copyFile(srcFilePath, destFilePath);
                count++;
            }
        }
        return count;
    }
    async copyFile(srcPath, destPath) {
        if (!this.client)
            throw new Error('SSH client not connected');
        const isWindowsPath = /^[A-Za-z]:/.test(srcPath);
        const command = isWindowsPath
            ? `cmd.exe /c copy /y "${srcPath.replace(/\//g, '\\')}" "${destPath.replace(/\//g, '\\')}"`
            : `cp "${srcPath}" "${destPath}"`;
        return new Promise((resolve, reject) => {
            this.client.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }
                stream.on('close', () => resolve());
                stream.on('error', reject);
            });
        });
    }
    async exec(command) {
        if (!this.client)
            throw new Error('SSH client not connected');
        return new Promise((resolve, reject) => {
            this.client.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }
                let stdout = '';
                let stderr = '';
                stream.on('data', (data) => {
                    stdout += data.toString();
                });
                stream.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                stream.on('close', (code) => {
                    if (code !== 0) {
                        reject(new Error(stderr || stdout || `Command exited with code ${code}`));
                    }
                    else {
                        resolve(stdout);
                    }
                });
            });
        });
    }
    // Clear all files and subdirectories inside a Windows remote directory using cmd.exe exec
    // (bypasses SFTP which has restricted permissions on Windows SSH servers)
    async clearWindowsDirContents(remotePath) {
        const winPath = remotePath.replace(/\//g, '\\');
        // Use PowerShell to delete all contents without removing the root directory.
        // -ErrorAction SilentlyContinue handles locked files and always exits 0.
        await this.exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ` +
            `"Get-ChildItem -LiteralPath '${winPath}' -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"`);
    }
    async disconnect() {
        if (this.client && this.connected) {
            this.client.end();
            this.connected = false;
            logger.info('SSH connection closed');
        }
    }
    isConnected() {
        return this.connected;
    }
}
export const sshService = new SSHService();
//# sourceMappingURL=ssh.js.map