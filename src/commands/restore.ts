import ora from 'ora';
import chalk from 'chalk';
import path from 'path';
import { spawn } from 'child_process';
import type { AppConfig, DeployResult } from '../types/config.types.js';
import { FileOpsService } from '../services/file-ops.js';
import { logger } from '../services/logger.js';

export async function restoreCommand(config: AppConfig): Promise<DeployResult> {
  const startTime = new Date();
  const errors: string[] = [];

  const fileOps = new FileOpsService();

  console.log(chalk.bold('\n🔄 Starting restore...\n'));

  try {
    // Step 1: Generate and upload restore.bat to staging
    const spinnerUpload = ora('Generating and uploading restore.bat to staging...').start();
    try {
      await fileOps.uploadAndExecuteRestoreBat(config.staging, config.destination, config.backup);
      spinnerUpload.succeed('restore.bat uploaded to staging');
      logger.success('restore.bat uploaded to staging');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinnerUpload.fail(`Failed to upload restore.bat: ${message}`);
      logger.error(`Failed to upload restore.bat: ${message}`);
      errors.push(message);
      throw err;
    }

    // Step 2: Execute restore.bat on staging
    const spinnerExec = ora('Executing restore.bat on staging...').start();
    try {
      if (config.staging.type === 'local') {
        const restoreBatPath = path.join(config.staging.path, 'restore.bat');
        await new Promise<void>((resolve, reject) => {
          const psCommand = `
            $process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '"${restoreBatPath}"' -Verb RunAs -Wait -PassThru -WindowStyle Hidden
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
            else reject(new Error(`restore.bat exited with code ${code}: ${stderr || stdout}`));
          });
        });
      } else {
        // Remote execution via SSH
        const ssh = await fileOps.ensureSSHConnection(config.staging);
        if (!ssh) throw new Error('SSH connection required to execute restore.bat on staging');
        const isWindowsRemote = /^[A-Za-z]:[\\/]/.test(config.staging.path);
        const remoteRestorePath = isWindowsRemote
          ? `${config.staging.path.replace(/\//g, '\\')}\\restore.bat`
          : `${config.staging.path.replace(/\\/g, '/')}/restore.bat`;
        if (isWindowsRemote) {
          await ssh.exec(`cmd.exe /c "${remoteRestorePath}"`);
        } else {
          await ssh.exec(`bash -lc "\"${remoteRestorePath}\""`);
        }
      }

      spinnerExec.succeed('restore.bat executed successfully');
      logger.success('restore.bat executed successfully');
    } catch (execErr) {
      const msg = execErr instanceof Error ? execErr.message : String(execErr);
      spinnerExec.fail(`Failed to execute restore.bat: ${msg}`);
      logger.error(`Failed to execute restore.bat`, { error: msg });
      errors.push(msg);
      throw execErr;
    }

    // Step 3: Delete restore.bat from staging
    const spinnerCleanup = ora('Cleaning up restore.bat...').start();
    try {
      await fileOps.deleteRestoreBat(config.staging);
      spinnerCleanup.succeed('restore.bat removed from staging');
      logger.info('restore.bat removed from staging');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinnerCleanup.warn(`Failed to remove restore.bat: ${message}`);
      logger.warn(`Failed to remove restore.bat: ${message}`);
    }

  } finally {
    await fileOps.closeAllConnections();
  }

  const endTime = new Date();
  const duration = (endTime.getTime() - startTime.getTime()) / 1000;

  const result: DeployResult = {
    success: errors.length === 0,
    startTime,
    endTime,
    filesDeployed: 0,
    errors,
  };

  logger.info('Restore completed', {
    success: result.success,
    duration: `${duration}s`,
  });

  await logger.save();

  console.log('\n' + chalk.bold('═'.repeat(50)));
  if (result.success) {
    console.log(chalk.green.bold('\n✔ Restore completed successfully!\n'));
  } else {
    console.log(chalk.red.bold('\n✖ Restore completed with errors\n'));
  }
  console.log(`  Duration: ${chalk.cyan(duration.toFixed(2) + 's')}`);
  console.log(chalk.bold('═'.repeat(50)) + '\n');

  return result;
}
