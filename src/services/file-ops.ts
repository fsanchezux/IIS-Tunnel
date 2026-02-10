import fs from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import extractZip from 'extract-zip';
import type { LocationConfig } from '../types/config.types.js';
import { SSHService } from './ssh.js';
import { logger } from './logger.js';

export class FileOpsService {
  private sshConnections: Map<string, SSHService> = new Map();

  // Convert Windows path to POSIX for SSH
  private toSshPath(inputPath: string): string {
    return inputPath.replace(/\\/g, '/');
  }

  // Join paths correctly based on location type
  private joinPath(basePath: string, ...segments: string[]): string {
    // Use forward slashes for joining, then normalize
    const joined = [basePath, ...segments].join('/');
    return joined.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  async ensureSSHConnection(location: LocationConfig): Promise<SSHService | null> {
    if (location.type !== 'ssh' || !location.ssh) {
      return null;
    }

    const key = `${location.ssh.host}:${location.ssh.port}`;

    if (this.sshConnections.has(key)) {
      return this.sshConnections.get(key)!;
    }

    const ssh = new SSHService();
    await ssh.connect(location.ssh);
    this.sshConnections.set(key, ssh);
    return ssh;
  }

  async copyFiles(source: LocationConfig, dest: LocationConfig, folders?: (string | { [key: string]: string[] }) [] | null): Promise<number> {
    // If specific folders are provided, copy only those
    if (folders && folders.length > 0) {
      return this.copySpecificFolders(source, dest, folders);
    }

    // Local to Local
    if (source.type === 'local' && dest.type === 'local') {
      return this.copyLocalToLocal(source.path, dest.path);
    }

    // Local to SSH
    if (source.type === 'local' && dest.type === 'ssh') {
      const ssh = await this.ensureSSHConnection(dest);
      if (!ssh) throw new Error('SSH connection required for destination');
      return this.copyLocalToSSH(source.path, dest.path, ssh);
    }

    // SSH to Local
    if (source.type === 'ssh' && dest.type === 'local') {
      const ssh = await this.ensureSSHConnection(source);
      if (!ssh) throw new Error('SSH connection required for source');
      return this.copySSHToLocal(source.path, dest.path, ssh);
    }

    // SSH to SSH (same connection)
    if (source.type === 'ssh' && dest.type === 'ssh') {
      const srcSSH = await this.ensureSSHConnection(source);
      if (!srcSSH) throw new Error('SSH connection required for source');
      return srcSSH.copyDir(source.path, dest.path);
    }

    throw new Error('Unsupported copy operation');
  }

  private async copySpecificFolders(
    source: LocationConfig,
    dest: LocationConfig,
    folders: (string | { [key: string]: string[] })[]
  ): Promise<number> {
    let totalCount = 0;

    for (const folderSpec of folders) {
      if (typeof folderSpec === 'string') {
        // Simple folder copy (all files)
        const srcPath = source.type === 'local'
          ? path.join(source.path, folderSpec)
          : this.joinPath(source.path, folderSpec);
        const destPath = dest.type === 'local'
          ? path.join(dest.path, folderSpec)
          : this.joinPath(dest.path, folderSpec);

        const srcFolder: LocationConfig = {
          ...source,
          path: srcPath,
        };
        const destFolder: LocationConfig = {
          ...dest,
          path: destPath,
        };

        if (!(await this.exists(srcFolder))) {
          throw new Error(`Source folder does not exist: ${srcFolder.path}`);
        }

        const count = await this.copyFiles(srcFolder, destFolder, null);
        totalCount += count;
      } else {
        // Specific files in folder
        for (const [folderName, files] of Object.entries(folderSpec)) {
          const srcFolderPath = source.type === 'local'
            ? path.join(source.path, folderName)
            : this.joinPath(source.path, folderName);
          const destFolderPath = dest.type === 'local'
            ? path.join(dest.path, folderName)
            : this.joinPath(dest.path, folderName);

          // Verify source folder exists
          const srcFolderConfig: LocationConfig = {
            ...source,
            path: srcFolderPath,
          };
          if (!(await this.exists(srcFolderConfig))) {
            throw new Error(`Source folder does not exist: ${srcFolderPath}`);
          }

          // Copy specific files from this folder
          totalCount += await this.copySpecificFiles(
            source,
            dest,
            folderName,
            files
          );
        }
      }
    }

    return totalCount;
  }

  private async copySpecificFiles(
    source: LocationConfig,
    dest: LocationConfig,
    folderName: string,
    files: string[]
  ): Promise<number> {
    let count = 0;

    const srcFolderPath = source.type === 'local'
      ? path.join(source.path, folderName)
      : this.joinPath(source.path, folderName);
    const destFolderPath = dest.type === 'local'
      ? path.join(dest.path, folderName)
      : this.joinPath(dest.path, folderName);

    // Ensure destination folder exists
    const destFolderConfig: LocationConfig = {
      ...dest,
      path: destFolderPath,
    };
    await this.ensureDir(destFolderConfig);

    for (const file of files) {
      const srcFile = source.type === 'local'
        ? path.join(srcFolderPath, file)
        : this.joinPath(srcFolderPath, file);
      const destFile = dest.type === 'local'
        ? path.join(destFolderPath, file)
        : this.joinPath(destFolderPath, file);

      const srcFileConfig: LocationConfig = {
        ...source,
        path: srcFile,
      };

      if (!(await this.exists(srcFileConfig))) {
        throw new Error(`Source file does not exist: ${srcFile}`);
      }

      if (source.type === 'local' && dest.type === 'local') {
        await fs.copy(srcFile, destFile, { overwrite: true });
        count++;
      } else if (source.type === 'local' && dest.type === 'ssh') {
        const ssh = await this.ensureSSHConnection(dest);
        if (!ssh) throw new Error('SSH connection required for destination');
        await ssh.uploadFile(srcFile, destFile);
        count++;
      } else if (source.type === 'ssh' && dest.type === 'local') {
        const ssh = await this.ensureSSHConnection(source);
        if (!ssh) throw new Error('SSH connection required for source');
        await ssh.downloadFile(srcFile, destFile);
        count++;
      } else if (source.type === 'ssh' && dest.type === 'ssh') {
        const ssh = await this.ensureSSHConnection(source);
        if (!ssh) throw new Error('SSH connection required for source');
        await ssh.exec(`cp "${srcFile}" "${destFile}"`);
        count++;
      }
    }

    return count;
  }

  private async copyLocalToLocal(srcPath: string, destPath: string): Promise<number> {
    // Verify source exists
    if (!(await fs.pathExists(srcPath))) {
      throw new Error(`Source path does not exist: ${srcPath}`);
    }
    // Ensure destination directory exists
    await fs.ensureDir(destPath);
    await fs.copy(srcPath, destPath, { overwrite: true });
    return this.countFiles(srcPath);
  }

  private async copyLocalToSSH(srcPath: string, destPath: string, ssh: SSHService): Promise<number> {
    // Verify source exists
    if (!(await fs.pathExists(srcPath))) {
      throw new Error(`Source path does not exist: ${srcPath}`);
    }
    // Ensure destination directory exists on SSH
    const sshDestPath = this.toSshPath(destPath);
    await ssh.mkdir(sshDestPath, true);
    return this.uploadDirectory(srcPath, sshDestPath, ssh);
  }

  private async uploadDirectory(localPath: string, remotePath: string, ssh: SSHService): Promise<number> {
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      const localFilePath = path.join(localPath, entry.name);
      const remoteFilePath = this.joinPath(remotePath, entry.name);

      if (entry.isDirectory()) {
        // For subdirectories, we create them since the parent was verified to exist
        await ssh.mkdir(remoteFilePath, true);
        count += await this.uploadDirectory(localFilePath, remoteFilePath, ssh);
      } else {
        await ssh.uploadFile(localFilePath, remoteFilePath);
        count++;
      }
    }

    return count;
  }

  private async copySSHToLocal(srcPath: string, destPath: string, ssh: SSHService): Promise<number> {
    // Verify source exists on SSH
    const sshSrcPath = this.toSshPath(srcPath);
    const srcStats = await ssh.stat(sshSrcPath);
    if (!srcStats) {
      throw new Error(`Source path does not exist on remote: ${sshSrcPath}`);
    }
    // Ensure destination directory exists locally
    await fs.ensureDir(destPath);
    return this.downloadDirectory(sshSrcPath, destPath, ssh);
  }

  private async downloadDirectory(remotePath: string, localPath: string, ssh: SSHService): Promise<number> {
    const files = await ssh.readDir(remotePath);
    let count = 0;

    for (const file of files) {
      const remoteFilePath = this.joinPath(remotePath, file);
      const localFilePath = path.join(localPath, file);
      const stats = await ssh.stat(remoteFilePath);

      if (stats?.isDirectory) {
        // For subdirectories, we create them since the parent was verified to exist
        await fs.ensureDir(localFilePath);
        count += await this.downloadDirectory(remoteFilePath, localFilePath, ssh);
      } else {
        await ssh.downloadFile(remoteFilePath, localFilePath);
        count++;
      }
    }

    return count;
  }

  async deleteContents(location: LocationConfig): Promise<void> {

    if (location.type === 'local') {
      await this.deleteLocalContents(location.path);
    } else {
      const ssh = await this.ensureSSHConnection(location);
      if (!ssh) throw new Error('SSH connection required');
      await this.deleteSSHContents(location.path, ssh);
    }
  }

  private async deleteLocalContents(dirPath: string): Promise<void> {
    if (!(await fs.pathExists(dirPath))) return;

    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      await fs.remove(fullPath);
    }
  }

  private async deleteSSHContents(dirPath: string, ssh: SSHService): Promise<void> {
    const sshDirPath = this.toSshPath(dirPath);
    const files = await ssh.readDir(sshDirPath);

    for (const file of files) {
      const filePath = this.joinPath(sshDirPath, file);
      const stats = await ssh.stat(filePath);

      if (stats?.isDirectory) {
        await ssh.deleteDir(filePath);
      } else {
        await ssh.deleteFile(filePath);
      }
    }
  }

  async listFiles(location: LocationConfig): Promise<string[]> {
    if (location.type === 'local') {
      if (!(await fs.pathExists(location.path))) return [];
      return fs.readdir(location.path);
    } else {
      const ssh = await this.ensureSSHConnection(location);
      if (!ssh) throw new Error('SSH connection required');
      return ssh.readDir(location.path);
    }
  }

  async exists(location: LocationConfig): Promise<boolean> {
    if (location.type === 'local') {
      return fs.pathExists(location.path);
    } else {
      const ssh = await this.ensureSSHConnection(location);
      if (!ssh) throw new Error('SSH connection required');
      const stats = await ssh.stat(location.path);
      return stats !== null;
    }
  }

  async ensureDir(location: LocationConfig): Promise<void> {
    // This method now VERIFIES the directory exists, does NOT create it
    if (location.type === 'local') {
      if (!(await fs.pathExists(location.path))) {
        throw new Error(`Directory does not exist: ${location.path}`);
      }
    } else {
      const ssh = await this.ensureSSHConnection(location);
      if (!ssh) throw new Error('SSH connection required');
      const sshPath = this.toSshPath(location.path);
      const stats = await ssh.stat(sshPath);
      if (!stats) {
        throw new Error(`Directory does not exist on remote: ${sshPath}`);
      }
    }
  }

  private async countFiles(dirPath: string): Promise<number> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await this.countFiles(path.join(dirPath, entry.name));
      } else {
        count++;
      }
    }

    return count;
  }

  async countFilesInDirectory(dirPath: string): Promise<number> {
    return this.countFiles(dirPath);
  }

  async closeAllConnections(): Promise<void> {
    for (const [key, ssh] of this.sshConnections) {
      await ssh.disconnect();
      this.sshConnections.delete(key);
    }
  }

  async compressFiles(sourcePath: string, outputPath: string, onProgress?: (progress: number) => void): Promise<void> {
    if (onProgress) onProgress(5);

    try {
      logger.info(`Compression started`, { source: sourcePath, output: outputPath });
      
      // Verify source exists
      const sourceExists = await fs.pathExists(sourcePath);
      logger.info(`Source path check`, { path: sourcePath, exists: sourceExists });
      
      if (!sourceExists) {
        throw new Error(`Source path does not exist: ${sourcePath}`);
      }

      // Create output directory if it doesn't exist
      const outputDir = path.dirname(outputPath);
      await fs.ensureDir(outputDir);
      logger.info(`Output directory ensured`, { outputDir });

      // Remove any existing zip files in the sourcePath to avoid including previous archives
      try {
        const entries = await fs.readdir(sourcePath);
        for (const e of entries) {
          if (e.toLowerCase().endsWith('.zip')) {
            const zipFile = path.join(sourcePath, e);
            try {
              await fs.remove(zipFile);
              logger.info(`Removed old zip from temp`, { zipFile });
            } catch (rmErr) {
              logger.warn(`Failed to remove old zip`, { zipFile, error: rmErr instanceof Error ? rmErr.message : String(rmErr) });
            }
          }
        }
      } catch (e) {
        logger.warn(`Could not scan temp directory for old zips`, { error: e instanceof Error ? e.message : String(e) });
      }

      // Count files in source
      const files = await this.countFilesInDirectory(sourcePath);
      logger.info(`Source files count`, { path: sourcePath, fileCount: files });

      // Get source size
      const sourceStats = await this.getDirectorySize(sourcePath);
      logger.info(`Source directory size`, { path: sourcePath, sizeInMB: sourceStats.toFixed(2) });

      logger.info(`Starting 7-Zip compression`, { sourcePath, outputPath });

      const startTime = Date.now();

      // Use 7-Zip; if it fails, propagate the error (no fallback)
      await this.compressWith7Zip(sourcePath, outputPath);

      const duration = (Date.now() - startTime) / 1000;

      // Verify output
      const outputExists = await fs.pathExists(outputPath);
      logger.info(`Output file check`, { path: outputPath, exists: outputExists });

      if (outputExists) {
        const outputFileStats = await fs.stat(outputPath);
        const outputSizeInMB = (outputFileStats.size / 1024 / 1024).toFixed(2);
        logger.success(`Compression completed`, { 
          outputPath, 
          sizeInMB: outputSizeInMB, 
          durationInSeconds: duration.toFixed(2),
          compressionRatio: ((1 - outputFileStats.size / (sourceStats * 1024 * 1024)) * 100).toFixed(2)
        });
      } else {
        throw new Error(`Output file was not created: ${outputPath}`);
      }

      if (onProgress) onProgress(100);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Compression failed`, { error: errorMsg, source: sourcePath, output: outputPath });
      throw new Error(`Compression failed: ${errorMsg}`);
    }
  }

  private compressWithPowerShell(sourcePath: string, outputPath: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Create a temporary PowerShell script file to avoid long command line issues
        const scriptDir = path.dirname(outputPath);
        const scriptFile = path.join(scriptDir, `compress-${Date.now()}.ps1`);
        
        // Write PowerShell script to file
        const scriptContent = `$ProgressPreference = 'SilentlyContinue'
Compress-Archive -Path "${sourcePath}\\*" -DestinationPath "${outputPath}" -Force
exit 0
`;
        
        await fs.writeFile(scriptFile, scriptContent, 'utf8');
        logger.info(`PowerShell script created`, { scriptFile });

        // Execute the script
        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-NoLogo',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptFile
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: 300000
        });

        let output = '';
        let closed = false;

        const safetyTimeout = setTimeout(() => {
          if (!closed) {
            logger.warn(`PowerShell timeout - killing process`);
            ps.kill();
          }
        }, 300000);

        const cleanup = async () => {
          clearTimeout(safetyTimeout);
          try {
            await fs.remove(scriptFile);
          } catch (e) {
            // Ignore cleanup errors
          }
        };

        if (ps.stdout) {
          ps.stdout.on('data', (data) => {
            output += data.toString();
          });
        }

        if (ps.stderr) {
          ps.stderr.on('data', (data) => {
            output += data.toString();
          });
        }

        ps.on('close', async (code) => {
          closed = true;
          // Wait a tick to allow file system to settle
          await new Promise((r) => setTimeout(r, 100));
          // Collect diagnostics
          let found = false;
          try {
            const exists = await fs.pathExists(outputPath);
            if (exists) {
              found = true;
              logger.success(`PowerShell compression succeeded and output file exists`, { outputPath });
              await cleanup();
              return resolve();
            }

            // If not found, list files in the script directory and cwd for debugging
            const scriptDir = path.dirname(outputPath);
            let dirListing: string[] = [];
            try {
              dirListing = await fs.readdir(scriptDir);
            } catch (e) {
              // ignore
            }

            let cwdListing: string[] = [];
            try {
              cwdListing = await fs.readdir(process.cwd());
            } catch (e) {
              // ignore
            }

            await cleanup();

            const diagnostic = {
              exitCode: code,
              output,
              scriptDir,
              scriptDirFiles: dirListing,
              cwd: process.cwd(),
              cwdFiles: cwdListing
            };

            logger.error(`PowerShell compression finished but output ZIP not found`, diagnostic);
            return reject(new Error(`PowerShell completed (code ${code}) but output file not found: ${outputPath}. Diagnostic: ${JSON.stringify(diagnostic)}`));
          } catch (err) {
            await cleanup();
            logger.error(`Error during post-compression diagnostics`, { error: err instanceof Error ? err.message : String(err) });
            return reject(err);
          }
        });

        ps.on('error', async (err) => {
          closed = true;
          await cleanup();
          logger.error(`PowerShell spawn error`, { error: err.message });
          reject(err);
        });
      } catch (err) {
        logger.error(`PowerShell script creation error`, { error: err instanceof Error ? err.message : String(err) });
        reject(err);
      }
    });
  }

  private compressWithArchiver(sourcePath: string, outputPath: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        await fs.ensureDir(path.dirname(outputPath));
        const output = createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 4 } });

        output.on('close', () => {
          logger.info(`Archiver finished`, { bytes: archive.pointer() });
          resolve();
        });

        output.on('error', (err) => {
          reject(err);
        });

        archive.on('warning', (err) => {
          logger.warn(`Archiver warning`, { message: err instanceof Error ? err.message : String(err) });
        });

        archive.on('error', (err) => {
          reject(err);
        });

        archive.pipe(output);
        // Add entire source directory contents
        archive.directory(sourcePath, false);
        await archive.finalize();
      } catch (err) {
        reject(err);
      }
    });
  }

  private compressWith7Zip(sourcePath: string, outputPath: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        await fs.ensureDir(path.dirname(outputPath));

        // Prefer bundled 7z from 7zip-bin if installed, otherwise fallback to system 7z
        let sevenCmd = process.platform === 'win32' ? '7z.exe' : '7z';
        try {
          // @ts-ignore - optional dependency providing bundled 7z binaries
          const sevenBin = await import('7zip-bin');
          // common exports may vary; use any to access available keys
          const b: any = sevenBin;
          sevenCmd = (b.path7za || b.path7x || b.path7z || sevenCmd) as string;
        } catch (e) {
          // ignore - fall back to system 7z
        }

        // Run 7z from the sourcePath to avoid wildcard/path issues; archive '.'
        const args = ['a', '-tzip', outputPath, '.', '-r'];

        const proc = spawn(sevenCmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          cwd: sourcePath
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (d) => {
          const s = d.toString();
          stdout += s;
          logger.info('7z stdout', { data: s.trim() });
        });

        proc.stderr?.on('data', (d) => {
          const s = d.toString();
          stderr += s;
          logger.warn('7z stderr', { data: s.trim() });
        });

        proc.on('close', (code) => {
          if (code === 0) {
            return resolve();
          }
          const msg = stderr || stdout || `7z exited with code ${code}`;
          return reject(new Error(msg));
        });

        proc.on('error', (err: any) => {
          if (err && (err.code === 'ENOENT' || /not found/i.test(String(err.message)))) {
            return reject(new Error('7z executable not found in PATH. Install 7-Zip or add to PATH.'));
          }
          return reject(err);
        });
      } catch (err) {
        return reject(err);
      }
    });
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await this.getDirectorySize(fullPath);
      } else {
        const stats = await fs.stat(fullPath);
        totalSize += stats.size;
      }
    }

    return totalSize / 1024 / 1024; // Return in MB
  }

  async decompressFiles(zipPath: string, outputPath: string): Promise<void> {
    await extractZip(zipPath, { dir: outputPath });
  }

  async copyToTemp(
    source: LocationConfig,
    staging: LocationConfig,
    folders: (string | { [key: string]: string[] })[] | null | undefined,
    tempDir: string
  ): Promise<number> {
    // Copy only the files we need to a temp directory for compression
    if (folders && folders.length > 0) {
      let totalCount = 0;
      for (const folderSpec of folders) {
        if (typeof folderSpec === 'string') {
          // Copy entire folder
          const srcPath = source.type === 'local'
            ? path.join(source.path, folderSpec)
            : this.joinPath(source.path, folderSpec);

          if (!(await this.exists({ ...source, path: srcPath }))) {
            throw new Error(`Source folder does not exist: ${srcPath}`);
          }

          const destPath = path.join(tempDir, folderSpec);
          await fs.ensureDir(destPath);

          if (source.type === 'local') {
            await fs.copy(srcPath, destPath, { overwrite: true });
            totalCount += await this.countFiles(srcPath);
          } else {
            const ssh = await this.ensureSSHConnection(source);
            if (!ssh) throw new Error('SSH connection required for source');
            totalCount += await this.downloadDirectory(srcPath, destPath, ssh);
          }
        } else {
          // Copy specific files from folder
          for (const [folderName, files] of Object.entries(folderSpec)) {
            const srcFolderPath = source.type === 'local'
              ? path.join(source.path, folderName)
              : this.joinPath(source.path, folderName);

            if (!(await this.exists({ ...source, path: srcFolderPath }))) {
              throw new Error(`Source folder does not exist: ${srcFolderPath}`);
            }

            const destFolderPath = path.join(tempDir, folderName);
            await fs.ensureDir(destFolderPath);

            for (const file of files) {
              const srcFile = source.type === 'local'
                ? path.join(srcFolderPath, file)
                : this.joinPath(srcFolderPath, file);
              const destFile = path.join(destFolderPath, file);

              if (!(await this.exists({ ...source, path: srcFile }))) {
                throw new Error(`Source file does not exist: ${srcFile}`);
              }

              if (source.type === 'local') {
                await fs.copy(srcFile, destFile, { overwrite: true });
                totalCount++;
              } else {
                const ssh = await this.ensureSSHConnection(source);
                if (!ssh) throw new Error('SSH connection required for source');
                await ssh.downloadFile(srcFile, destFile);
                totalCount++;
              }
            }
          }
        }
      }
      return totalCount;
    } else {
      // Copy all files
      if (source.type === 'local') {
        await fs.copy(source.path, tempDir, { overwrite: true });
        return this.countFiles(source.path);
      } else {
        const ssh = await this.ensureSSHConnection(source);
        if (!ssh) throw new Error('SSH connection required for source');
        return this.downloadDirectory(source.path, tempDir, ssh);
      }
    }
  }

  async transferFile(
    localZipPath: string,
    stagingLocation: LocationConfig,
    fileName: string,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    if (stagingLocation.type === 'local') {
      const destPath = path.join(stagingLocation.path, fileName);
      const stats = await fs.stat(localZipPath);
      const totalSize = stats.size;
      let copiedSize = 0;
      
      await fs.copy(localZipPath, destPath, {
        overwrite: true,
        filter: () => {
          copiedSize += 1024 * 1024; // Simulated progress
          if (onProgress) {
            const percentage = Math.min(100, Math.round((copiedSize / totalSize) * 100));
            onProgress(percentage);
          }
          return true;
        }
      });
      if (onProgress) onProgress(100);
    } else {
      const ssh = await this.ensureSSHConnection(stagingLocation);
      if (!ssh) throw new Error('SSH connection required for staging');
      const remotePath = this.joinPath(stagingLocation.path, fileName);
      await ssh.uploadFileWithProgress(localZipPath, remotePath, onProgress);
    }
  }

  async decompressFilesRemote(
    stagingLocation: LocationConfig,
    zipFileName: string
  ): Promise<void> {
    if (stagingLocation.type === 'local') {
      const zipPath = path.join(stagingLocation.path, zipFileName);
      await extractZip(zipPath, { dir: stagingLocation.path });
      // Remove zip file after extraction
      await fs.remove(zipPath);
    } else {
      const ssh = await this.ensureSSHConnection(stagingLocation);
      if (!ssh) throw new Error('SSH connection required for staging');
      const remotePath = this.joinPath(stagingLocation.path, zipFileName);
      const remoteDir = stagingLocation.path;

      const isWindowsRemote = /^[A-Za-z]:[\\/]/.test(remoteDir);
      if (isWindowsRemote) {
        // Use PowerShell Expand-Archive on Windows remote
        const psCommand = `powershell.exe -NoProfile -NonInteractive -Command "Expand-Archive -Path '${remotePath}' -DestinationPath '${remoteDir}' -Force; Remove-Item -Path '${remotePath}' -Force"`;
        await ssh.exec(psCommand);
      } else {
        // Unix-like remote
        await ssh.exec(`cd "${remoteDir}" && unzip -o "${zipFileName}" && rm "${zipFileName}"`);
      }
    }
  }

  generateUpdateBat(
    staging: LocationConfig,
    destination: LocationConfig,
    backup: { path: string; maxBackups?: number },
    sourceFolders?: (string | { [key: string]: string[] })[] | null
  ): string {
    const sourceDir = staging.path;
    const destDir = destination.path;
    const backupDir = backup.path;
    const logfile = path.join(sourceDir, 'update.log').replace(/\//g, '\\');
    const maxBackups = backup.maxBackups ?? 3;

    const lines = [
      '@echo off',
      'setlocal enabledelayedexpansion',
      'set "source_dir=' + sourceDir + '"',
      'set "dest_dir=' + destDir + '"',
      'set "backup_dir=' + backupDir + '"',
      'set "logfile=' + logfile + '"',
      'set "max_backups=' + maxBackups + '"',
      '',
      'echo ============================================',
      'echo FILE UPDATE SCRIPT',
      'echo ============================================',
      'echo.',
      'echo This script will perform the following actions:',
      'echo.',
      'echo - Create backup of: %dest_dir%',
      'echo - Copy files from: %source_dir%',
      'echo - Keep %max_backups% most recent backups',
      'echo - Save log to: %logfile%',
      'echo.',
      'echo ============================================',
      'echo.',
      'echo Proceeding with update...',
      'echo.',
      '',
      'for /f %%I in (\'powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"\') do set "date_str=%%I"',
      'for /f %%I in (\'powershell -NoProfile -Command "Get-Date -Format HH:mm:ss"\') do set "time_str=%%I"',
      'for /f %%I in (\'powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"\') do set "timestamp=%%I"',
      '',
      'echo ============================================',
      'echo Starting update process...',
      'echo Date: %date_str% %time_str%',
      'echo ============================================',
      'echo.',
      '',
      'if not exist "%backup_dir%" (',
      'mkdir "%backup_dir%"',
      'echo Backup folder created: %backup_dir%',
      ')',
      '',
      'echo.',
      'echo [1/4] Creating backup of destination folder...',
      'set "current_backup=%backup_dir%\\backup_%timestamp%"',
      'if exist "%dest_dir%" (',
      'xcopy "%dest_dir%\\*" "%current_backup%\\" /E /I /Q /Y',
      'if !errorlevel! equ 0 (',
      'echo Backup created successfully: %current_backup%',
      ') else (',
      'echo ERROR: Could not create backup',
      'goto :error',
      ')',
      ') else (',
      'echo Destination folder does not exist. Nothing to back up.',
      ')',
      '',
      'echo.',
      'echo [2/4] Copying new files...',
      ...this.generateCopyCommands(sourceDir, destDir, sourceFolders),
      '',
      'echo.',
      'echo [3/4] Managing old backups...',
      'set /a counter=0',
      'for /f "tokens=*" %%F in (\'dir /b /ad /o-d "%backup_dir%\\backup_*" 2^>nul\') do (',
      'set /a counter+=1',
      'if !counter! gtr %max_backups% (',
      'rd /s /q "%backup_dir%\\%%F"',
      'echo Old backup deleted: %%F',
      ')',
      ')',
      'echo Total backups kept: %max_backups%',
      '',
      'echo.',
      'echo [4/4] Saving log entry...',
      'echo ============================================ >> "%logfile%"',
      'echo Update completed: %date_str% %time_str% >> "%logfile%"',
      'echo User: %USERNAME% >> "%logfile%"',
      'echo Computer: %COMPUTERNAME% >> "%logfile%"',
      'echo Source: %source_dir% >> "%logfile%"',
      'echo Destination: %dest_dir% >> "%logfile%"',
      'echo Backup saved to: %current_backup% >> "%logfile%"',
      'echo ============================================ >> "%logfile%"',
      'echo. >> "%logfile%"',
      '',
      'echo.',
      'echo ============================================',
      'echo PROCESS COMPLETED SUCCESSFULLY',
      'echo ============================================',
      'echo Files copied from: %source_dir%',
      'echo Destination: %dest_dir%',
      'echo Backup saved to: %current_backup%',
      'echo Log saved to: %logfile%',
      'echo.',
      'exit /b 0',
      '',
      ':error',
      'echo.',
      'echo ============================================',
      'echo ERROR: Process did not complete successfully',
      'echo ============================================',
      'echo Please review the error messages above',
      'echo.',
      'echo ============================================ >> "%logfile%"',
      'echo ERROR in update: %date_str% %time_str% >> "%logfile%"',
      'echo User: %USERNAME% >> "%logfile%"',
      'echo Computer: %COMPUTERNAME% >> "%logfile%"',
      'echo Process failed - review details >> "%logfile%"',
      'echo ============================================ >> "%logfile%"',
      'echo. >> "%logfile%"',
      'exit /b 1',
    ];
    return lines.join('\r\n');
  }

  generateRestoreBat(
    staging: LocationConfig,
    destination: LocationConfig,
    backup: { path: string; maxBackups?: number }
  ): string {
    const sourceDir = staging.path;
    const destDir = destination.path;
    const backupDir = backup.path;
    const logfile = path.join(sourceDir, 'restore.log').replace(/\//g, '\\');

    const lines = [
      '@echo off',
      'setlocal enabledelayedexpansion',
      '',
      'set "dest_dir=' + destDir + '"',
      'set "backup_dir=' + backupDir + '"',
      'set "logfile=' + logfile + '"',
      '',
      'for /f %%I in (\'powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"\') do set "date_str=%%I"',
      'for /f %%I in (\'powershell -NoProfile -Command "Get-Date -Format HH:mm:ss"\') do set "time_str=%%I"',
      '',
      'echo ============================================',
      'echo RESTORE LATEST BACKUP',
      'echo ============================================',
      'echo Date: %date_str% %time_str%',
      'echo.',
      '',
      'if not exist "%backup_dir%" (',
      'echo ERROR: Backup folder not found',
      'echo Expected location: %backup_dir%',
      'goto :error',
      ')',
      '',
      'echo Searching for the most recent backup...',
      'set "latest_backup="',
      'for /f "tokens=*" %%F in (\'dir /b /ad /o-d "%backup_dir%\\backup_*" 2^>nul\') do (',
      'if not defined latest_backup set "latest_backup=%%F"',
      ')',
      '',
      'if not defined latest_backup (',
      'echo ERROR: No backups found in folder',
      'echo Location: %backup_dir%',
      'goto :error',
      ')',
      '',
      'set "backup_path=%backup_dir%\\%latest_backup%"',
      '',
      'echo.',
      'echo ============================================',
      'echo BACKUP FOUND',
      'echo ============================================',
      'echo Backup to restore: %latest_backup%',
      'echo Location: %backup_path%',
      'echo Destination: %dest_dir%',
      'echo ============================================',
      'echo.',
      '',
      'echo.',
      'echo [1/2] Cleaning destination folder...',
      'if exist "%dest_dir%" (',
      'rd /s /q "%dest_dir%"',
      'echo Destination folder removed',
      ')',
      'mkdir "%dest_dir%"',
      'echo Destination folder recreated',
      '',
      'echo.',
      'echo [2/2] Restoring files from backup...',
      'xcopy "%backup_path%\\*" "%dest_dir%\\" /E /I /Y /Q',
      'if !errorlevel! equ 0 (',
      'echo Files restored successfully',
      ') else (',
      'echo ERROR: Failed to restore files',
      'goto :error',
      ')',
      '',
      'echo ============================================ >> "%logfile%"',
      'echo Restore completed: %date_str% %time_str% >> "%logfile%"',
      'echo Backup restored: %latest_backup% >> "%logfile%"',
      'echo Source: %backup_path% >> "%logfile%"',
      'echo Destination: %dest_dir% >> "%logfile%"',
      'echo ============================================ >> "%logfile%"',
      'echo. >> "%logfile%"',
      '',
      'echo.',
      'echo ============================================',
      'echo RESTORE COMPLETED SUCCESSFULLY',
      'echo ============================================',
      'echo Backup restored: %latest_backup%',
      'echo Files copied to: %dest_dir%',
      'echo Log saved to: %logfile%',
      'echo.',
      'exit /b 0',
      '',
      ':error',
      'echo.',
      'echo ============================================',
      'echo ERROR: Restore did not complete',
      'echo ============================================',
      'echo Please review the error messages above',
      'echo.',
      'echo ============================================ >> "%logfile%"',
      'echo ERROR in restore: %date_str% %time_str% >> "%logfile%"',
      'echo Process failed - review details >> "%logfile%"',
      'echo ============================================ >> "%logfile%"',
      'echo. >> "%logfile%"',
      'exit /b 1',
    ];
    return lines.join('\r\n');
  }

  async uploadWindowsBats(localTempDir: string, staging: LocationConfig, destination: LocationConfig, backup: { path: string; maxBackups?: number }, sourceFolders?: (string | { [key: string]: string[] })[] | null): Promise<void> {
    const updateBat = this.generateUpdateBat(staging, destination, backup, sourceFolders);
    const restoreBat = this.generateRestoreBat(staging, destination, backup);

    // Ensure local temp dir exists
    await fs.ensureDir(localTempDir);
    const localUpdatePath = path.join(localTempDir, 'update.bat');
    const localRestorePath = path.join(localTempDir, 'restore.bat');
    await fs.writeFile(localUpdatePath, updateBat, 'utf8');
    await fs.writeFile(localRestorePath, restoreBat, 'utf8');

    // Upload to staging location
    if (staging.type === 'local') {
      const targetUpdate = path.join(staging.path, 'update.bat');
      const targetRestore = path.join(staging.path, 'restore.bat');
      await fs.copy(localUpdatePath, targetUpdate, { overwrite: true });
      await fs.copy(localRestorePath, targetRestore, { overwrite: true });
    } else {
      const ssh = await this.ensureSSHConnection(staging);
      if (!ssh) throw new Error('SSH connection required for staging');
      const remoteUpdate = this.joinPath(staging.path, 'update.bat');
      const remoteRestore = this.joinPath(staging.path, 'restore.bat');
      // Delete existing BAT files first to ensure fresh upload
      try {
        await ssh.deleteFile(remoteUpdate);
      } catch {
        // Ignore if file doesn't exist
      }
      try {
        await ssh.deleteFile(remoteRestore);
      } catch {
        // Ignore if file doesn't exist
      }
      await ssh.uploadFile(localUpdatePath, remoteUpdate);
      await ssh.uploadFile(localRestorePath, remoteRestore);
    }
  }

  async uploadAndExecuteRestoreBat(staging: LocationConfig, destination: LocationConfig, backup: { path: string; maxBackups?: number }): Promise<void> {
    const restoreBat = this.generateRestoreBat(staging, destination, backup);
    const localTempDir = path.join(process.cwd(), '.deploy-temp');
    await fs.ensureDir(localTempDir);
    const localRestorePath = path.join(localTempDir, 'restore.bat');
    await fs.writeFile(localRestorePath, restoreBat, 'utf8');

    if (staging.type === 'local') {
      const targetRestore = path.join(staging.path, 'restore.bat');
      await fs.ensureDir(staging.path);
      await fs.copy(localRestorePath, targetRestore, { overwrite: true });
    } else {
      const ssh = await this.ensureSSHConnection(staging);
      if (!ssh) throw new Error('SSH connection required for staging');
      const remoteRestore = this.joinPath(staging.path, 'restore.bat');
      try { await ssh.deleteFile(remoteRestore); } catch { /* ignore */ }
      await ssh.uploadFile(localRestorePath, remoteRestore);
    }
  }

  async deleteRestoreBat(staging: LocationConfig): Promise<void> {
    if (staging.type === 'local') {
      const targetRestore = path.join(staging.path, 'restore.bat');
      try { await fs.remove(targetRestore); } catch { /* ignore */ }
    } else {
      const ssh = await this.ensureSSHConnection(staging);
      if (!ssh) return;
      const remoteRestore = this.joinPath(staging.path, 'restore.bat');
      try { await ssh.deleteFile(remoteRestore); } catch { /* ignore */ }
    }
  }

  private generateCopyCommands(
    sourceDir: string,
    destDir: string,
    sourceFolders?: (string | { [key: string]: string[] })[] | null
  ): string[] {
    const lines: string[] = [];

    if (sourceFolders && sourceFolders.length > 0) {
      for (const folderSpec of sourceFolders) {
        if (typeof folderSpec === 'string') {
          // Copy entire folder
          lines.push('xcopy "' + sourceDir + '\\' + folderSpec + '\\*" "' + destDir + '\\' + folderSpec + '\\" /E /I /Y /Q');
          lines.push('if !errorlevel! equ 0 (');
          lines.push('echo Folder copied: ' + folderSpec);
          lines.push(') else (');
          lines.push('echo ERROR: Failed to copy folder ' + folderSpec);
          lines.push('goto :error');
          lines.push(')');
        } else {
          // Copy specific files from folder
          for (const [folderName, files] of Object.entries(folderSpec)) {
            lines.push('if not exist "' + destDir + '\\' + folderName + '" mkdir "' + destDir + '\\' + folderName + '"');
            for (const file of files) {
              lines.push('copy /y "' + sourceDir + '\\' + folderName + '\\' + file + '" "' + destDir + '\\' + folderName + '\\' + file + '"');
              lines.push('if !errorlevel! equ 0 (');
              lines.push('echo File copied: ' + folderName + '\\' + file);
              lines.push(') else (');
              lines.push('echo ERROR: Failed to copy ' + folderName + '\\' + file);
              lines.push('goto :error');
              lines.push(')');
            }
          }
        }
      }
    } else {
      // No folders specified: copy everything except .bat files
      lines.push('for /d %%D in ("' + sourceDir + '\\*") do (');
      lines.push('xcopy "%%D\\*" "' + destDir + '\\%%~nxD\\" /E /I /Y /Q');
      lines.push(')');
      lines.push('for %%F in ("' + sourceDir + '\\*") do (');
      lines.push('if /i not "%%~xF"==".bat" copy /y "%%F" "' + destDir + '\\"');
      lines.push(')');
    }

    return lines;
  }

  private isSameSSHServer(
    location1: LocationConfig,
    location2: LocationConfig
  ): boolean {
    if (location1.type !== 'ssh' || location2.type !== 'ssh') {
      return false;
    }
    if (!location1.ssh || !location2.ssh) {
      return false;
    }
    return (
      location1.ssh.host === location2.ssh.host &&
      location1.ssh.port === location2.ssh.port &&
      location1.ssh.username === location2.ssh.username
    );
  }

  async copyFilesOnRemoteServer(
    stagingPath: string,
    destinationPath: string,
    ssh: SSHService
  ): Promise<number> {
    // Detect Windows-style remote paths (e.g. C:\...)
    const isWindowsRemote = /^[A-Za-z]:[\\/]/.test(stagingPath) || /^[A-Za-z]:[\\/]/.test(destinationPath);
    if (isWindowsRemote) {
      // Use PowerShell to remove, copy and count files on Windows remote
      // Build a PowerShell one-liner that: clears destination, copies files, returns count
      const ps = `powershell.exe -NoProfile -NonInteractive -Command "try { Remove-Item -LiteralPath '${destinationPath}\\*' -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force -Path '${destinationPath}' | Out-Null; Copy-Item -Path '${stagingPath}\\*' -Destination '${destinationPath}' -Recurse -Force; $c = (Get-ChildItem -Path '${destinationPath}' -Recurse -File | Measure-Object).Count; Write-Output $c } catch { Write-Error $_; exit 1 }"`;
      const out = await ssh.exec(ps);
      return parseInt(out.trim(), 10) || 0;
    }

    // Unix-like remote: use rm and cp
    await ssh.exec(`rm -rf "${destinationPath}" && cp -r "${stagingPath}"/* "${destinationPath}"/`);
    // Count files by listing them
    const result = await ssh.exec(`find "${destinationPath}" -type f | wc -l`);
    return parseInt(result.trim(), 10);
  }

  async canUseSameSSHConnection(
    staging: LocationConfig,
    destination: LocationConfig
  ): Promise<boolean> {
    return this.isSameSSHServer(staging, destination);
  }
}

export const fileOpsService = new FileOpsService();
