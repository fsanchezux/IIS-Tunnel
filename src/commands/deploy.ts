import ora from 'ora';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';
import type { AppConfig, DeployResult } from '../types/config.types.js';
import { FileOpsService } from '../services/file-ops.js';
import { logger } from '../services/logger.js';

// Helper function to get file size in MB
async function getFileSize(filePath: string): Promise<string> {
  const stats = await fs.stat(filePath);
  const sizeInMB = (stats.size / 1024 / 1024).toFixed(2);
  return `${sizeInMB}MB`;
}

export async function deployCommand(
  config: AppConfig,
  sourceFolders?: (string | { [key: string]: string[] })[] | null
): Promise<DeployResult> {
  const startTime = new Date();
  const errors: string[] = [];
  let filesDeployed = 0;

  const fileOps = new FileOpsService();

  console.log(chalk.bold('\n🚀 Starting deployment...\n'));

  // Generate unique zip filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipFileName = `deploy-${timestamp}.zip`;
  // Create temp zip locally
  const localTempDir = path.join(process.cwd(), '.deploy-temp');
  const localZipPath = path.join(localTempDir, zipFileName);
  const stagingZipPath = config.staging.type === 'local'
    ? path.join(config.staging.path, zipFileName)
    : `${config.staging.path}/${zipFileName}`;

  try {
    // Ensure temp directory exists
    await fs.ensureDir(localTempDir);

    // Step 1: Compress source files locally (fast)
    const spinnerCompress = ora('Compressing files...').start();
    try {
      // Use sourceFolders passed (from configService) or null to copy all
      const foldersToCopy = sourceFolders ?? null;
      const sourceFiles = await fileOps.copyToTemp(config.source, config.staging, foldersToCopy, localTempDir);
      
      let lastProgress = 0;
      await fileOps.compressFiles(localTempDir, localZipPath, (progress) => {
        // Only update spinner text every 10%
        if (progress - lastProgress >= 10 || progress === 100) {
          spinnerCompress.text = `Compressing files... (${progress}%)`;
          lastProgress = progress;
        }
      });
      
      spinnerCompress.succeed(`Files compressed: ${zipFileName}`);
      logger.success(`Files compressed to ${zipFileName}`, { size: await getFileSize(localZipPath) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinnerCompress.fail(`Failed to compress files: ${message}`);
      logger.error(`Failed to compress files: ${message}`);
      errors.push(message);
      throw err;
    }

    // Step 2: Transfer compressed file to staging
    const spinnerTransfer = ora('Transferring compressed file to staging...').start();
    try {
      await fileOps.ensureDir(config.staging);
      await fileOps.deleteContents(config.staging);
      
      const fileSize = await getFileSize(localZipPath);
      let lastProgress = 0;
      
      await fileOps.transferFile(localZipPath, config.staging, zipFileName, (progress) => {
        // Only update spinner text every 10%
        if (progress - lastProgress >= 10 || progress === 100) {
          spinnerTransfer.text = `Transferring ${zipFileName} (${progress}%) to staging...`;
          lastProgress = progress;
        }
      });
      
      spinnerTransfer.succeed(`Transferred ${zipFileName} to staging (${fileSize})`);
      logger.success(`Transferred ${zipFileName} to staging`, { destination: stagingZipPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinnerTransfer.fail(`Failed to transfer file: ${message}`);
      logger.error(`Failed to transfer file: ${message}`);
      errors.push(message);
      throw err;
    }

    // Step 3: Decompress in staging
    const spinnerDecompressStaging = ora('Decompressing files in staging...').start();
    try {
      await fileOps.decompressFilesRemote(config.staging, zipFileName);
      spinnerDecompressStaging.succeed('Files decompressed in staging');
      logger.success('Files decompressed in staging');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinnerDecompressStaging.fail(`Failed to decompress in staging: ${message}`);
      logger.error(`Failed to decompress in staging: ${message}`);
      errors.push(message);
      throw err;
    }

    // Step 3.5: Generate and upload update.bat and restore.bat, then execute update.bat on staging
    const spinnerBats = ora('Generating and uploading update.bat / restore.bat to staging...').start();
    try {
      await fileOps.uploadWindowsBats(localTempDir, config.staging, config.destination, config.backup, sourceFolders);
      spinnerBats.succeed('BAT files uploaded to staging');
      logger.success('BAT files uploaded to staging');

      const spinnerExec = ora('Executing update.bat on staging (as admin)...').start();
      try {
        if (config.staging.type === 'local') {
          // Execute locally with admin elevation using PowerShell
          const updateBatPath = path.join(config.staging.path, 'update.bat');
          await new Promise<void>((resolve, reject) => {
            // Use PowerShell Start-Process with -Verb RunAs to request admin privileges
            // -Wait ensures we wait for the process to complete
            // -PassThru with exit code check
            const psCommand = `
              $process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '"${updateBatPath}"' -Verb RunAs -Wait -PassThru -WindowStyle Hidden
              exit $process.ExitCode
            `.replace(/\n/g, ' ');

            const proc = spawn('powershell.exe', [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy', 'Bypass',
              '-Command', psCommand
            ], {
              cwd: config.staging.path,
              windowsHide: true
            });

            let stdout = '';
            let stderr = '';
            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d) => { stderr += d.toString(); });
            proc.on('error', (e) => reject(e));
            proc.on('close', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`update.bat exited with code ${code}: ${stderr || stdout}`));
            });
          });
        } else {
          // Remote execution via SSH
          const ssh = await fileOps.ensureSSHConnection(config.staging);
          if (!ssh) throw new Error('SSH connection required to execute update.bat on staging');
          // Detect Windows-style remote path
          const isWindowsRemote = /^[A-Za-z]:[\\/]/.test(config.staging.path);
          const remoteUpdatePath = isWindowsRemote
            ? `${config.staging.path.replace(/\//g, '\\')}\\update.bat`
            : `${config.staging.path.replace(/\\/g, '/')}/update.bat`;
          // Use cmd.exe on Windows remotes, otherwise try sh
          if (isWindowsRemote) {
            await ssh.exec(`cmd.exe /c "${remoteUpdatePath}"`);
          } else {
            await ssh.exec(`bash -lc "\"${remoteUpdatePath}\""`);
          }
        }

        spinnerExec.succeed('update.bat executed successfully');
        logger.success('update.bat executed successfully');
      } catch (execErr) {
        const msg = execErr instanceof Error ? execErr.message : String(execErr);
        spinnerExec.fail(`Failed to execute update.bat: ${msg}`);
        logger.error(`Failed to execute update.bat`, { error: msg });
        errors.push(msg);
        throw execErr;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinnerBats.fail(`Failed to generate/upload/execute BATs: ${message}`);
      logger.error(`Failed to generate/upload/execute BATs: ${message}`);
      errors.push(message);
      throw err;
    }

    // Step 4: Clean up
    const spinnerCleanup = ora('Cleaning up...').start();
    try {
      await fileOps.deleteContents(config.staging);
      // Remove only ZIP files in local temp directory, keep other files/folders
      try {
        if (await fs.pathExists(localTempDir)) {
          const entries = await fs.readdir(localTempDir);
          for (const e of entries) {
            if (e.toLowerCase().endsWith('.zip')) {
              await fs.remove(path.join(localTempDir, e));
            }
          }
        }
      } catch (rmErr) {
        logger.warn('Failed to remove some zip files in temp', { error: rmErr instanceof Error ? rmErr.message : String(rmErr) });
      }
      spinnerCleanup.succeed('Cleanup completed');
      logger.info('Temporary files cleaned (zip files removed)');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinnerCleanup.warn(`Failed to cleanup: ${message}`);
      logger.warn(`Failed to cleanup: ${message}`);
    }

  } finally {
    // Close all SSH connections
    await fileOps.closeAllConnections();
  }

  const endTime = new Date();
  const duration = (endTime.getTime() - startTime.getTime()) / 1000;

  const result: DeployResult = {
    success: errors.length === 0,
    startTime,
    endTime,
    filesDeployed,
    errors,
  };

  // Log summary
  logger.info('Deployment completed', {
    success: result.success,
    filesDeployed: result.filesDeployed,
    duration: `${duration}s`,
  });

  // Save logs
  await logger.save();

  // Print summary
  console.log('\n' + chalk.bold('═'.repeat(50)));
  if (result.success) {
    console.log(chalk.green.bold('\n✔ Deployment completed successfully!\n'));
  } else {
    console.log(chalk.red.bold('\n✖ Deployment completed with errors\n'));
  }
  console.log(`  Files deployed: ${chalk.cyan(result.filesDeployed)}`);
  console.log(`  Duration: ${chalk.cyan(duration.toFixed(2) + 's')}`);
  console.log(chalk.bold('═'.repeat(50)) + '\n');

  return result;
}
