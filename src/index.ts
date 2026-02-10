#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'readline';
import path from 'path';
import fs from 'fs-extra';
import { configService } from './services/config.js';
import { logger } from './services/logger.js';
import { deployCommand } from './commands/deploy.js';
import { restoreCommand } from './commands/restore.js';

function promptPassword(message: string): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdout.write(message);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let password = '';
      const onData = (ch: string) => {
        const c = ch.toString();
        if (c === '\n' || c === '\r' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
        } else if (c === '\u0003') {
          stdin.setRawMode(false);
          process.exit(1);
        } else if (c === '\u007F' || c === '\b') {
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          password += c;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(message, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function main() {
  const program = new Command();

  program
    .name('iis-tunnel')
    .description('CLI tool for deploying files with SSH support, automatic backups and logging')
    .version('1.0.0');

  // Pre-load config to discover profile names for dynamic shortcuts
  let profileNames: string[] = [];
  try {
    // Find --config value from argv before Commander parses
    const configIdx = process.argv.indexOf('--config');
    const configAltIdx = process.argv.indexOf('-c');
    const idx = configIdx !== -1 ? configIdx : configAltIdx;
    const configPath = idx !== -1 ? process.argv[idx + 1] : undefined;
    await configService.load(configPath);
    profileNames = configService.getAvailableProfiles();
  } catch {
    // Config may not exist or be invalid - continue without profile shortcuts
  }

  program
    .option('-c, --config <path>', 'Path to configuration file')
    .option('-p, --profile <name>', 'Use a specific profile from configuration (REQUIRED)')
    .option('--list-profiles', 'List all available profiles')
    .option('--deploy', 'Deploy files from source to destination')
    .option('--restore', 'Restore the latest backup for the profile')
    .option('--dry-run', 'Show what would be done without making changes')
    .option('--edit', 'Open the configuration file in the default editor');

  // Register each profile name as a shortcut flag (e.g. --itescola, --administracio)
  for (const name of profileNames) {
    program.option(`--${name}`, `Shortcut for --profile ${name}`);
  }

  program.action(async (options) => {
    try {
      // Determine which profile to use
      let profileName: string | undefined;
      if (options.profile) {
        profileName = options.profile;
      } else {
        // Check dynamic profile shortcuts
        for (const name of profileNames) {
          if (options[name]) {
            profileName = name;
            break;
          }
        }
      }

      // For --list-profiles, load config without profile first
      if (options.listProfiles) {
        const profiles = configService.getAvailableProfiles();
        if (profiles.length === 0) {
          console.log(chalk.yellow('\nNo profiles defined in configuration.\n'));
        } else {
          const config = configService.getConfig();
          console.log(chalk.bold('\nAvailable profiles:'));
          for (const name of profiles) {
            const profile = config.profiles?.[name];
            const desc = profile?.description ? ` - ${profile.description}` : '';
            console.log(`  ${chalk.cyan(name)}${desc}`);
          }
          console.log('');
        }
        return;
      }

      // Open config file in editor
      if (options.edit) {
        const configPath = options.config || path.join(process.cwd(), 'iis-tunnel.config.yaml');
        if (!await fs.pathExists(configPath)) {
          console.error(chalk.red(`\nConfig file not found: ${configPath}\n`));
          process.exit(1);
        }
        console.log(chalk.gray(`Opening ${configPath}...`));
        const { exec } = await import('child_process');
        const isWin = process.platform === 'win32';
        const cmd = isWin ? `start "" "${configPath}"` : `open "${configPath}" || xdg-open "${configPath}"`;
        exec(cmd, (err) => {
          if (err) {
            console.error(chalk.red(`Failed to open editor: ${err.message}`));
            process.exit(1);
          }
        });
        return;
      }

      // Profile is REQUIRED for deploy, restore and dry-run
      if (!profileName) {
        console.error(chalk.red('\nError: A profile is required. Use --profile <name> or --<profile-name>\n'));
        console.log('Available commands:');
        console.log('  iis-tunnel --list-profiles              List all available profiles');
        console.log('  iis-tunnel --profile <name> --deploy    Deploy using specified profile');
        console.log('  iis-tunnel --profile <name> --restore   Restore latest backup for profile');
        if (profileNames.length > 0) {
          console.log(`  iis-tunnel --${profileNames[0]} --deploy            Deploy using ${profileNames[0]} profile`);
        }
        console.log('');
        process.exit(1);
      }

      if (!options.deploy && !options.dryRun && !options.restore) {
        program.help();
        return;
      }

      // Load configuration with profile
      console.log(chalk.gray('Loading configuration...'));
      const config = await configService.load(options.config, profileName);
      logger.setConfig(config.logging);
      logger.info('Configuration loaded successfully');

      // Display active profile
      const activeProfile = configService.getActiveProfile();
      console.log(chalk.bold(`\nActive Profile: ${chalk.magenta(activeProfile)}`));

      // Display configuration summary
      console.log(chalk.bold('\nConfiguration:'));
      console.log(`  Source:      ${chalk.cyan(config.source.type)} - ${config.source.path}`);

      // Show source folders if specific folders are configured
      const sourceFolders = configService.getSourceFolders();
      if (sourceFolders && sourceFolders.length > 0) {
        console.log(`  Folders:     ${chalk.yellow(sourceFolders.join(', '))}`);
      }

      console.log(`  Staging:     ${chalk.cyan(config.staging.type)} - ${config.staging.path}`);
      console.log(`  Destination: ${chalk.cyan(config.destination.type)} - ${config.destination.path}`);
      console.log(`  Backups:     ${config.backup.path} (max: ${config.backup.maxBackups})`);
      console.log(`  Logs:        ${config.logging.path}`);

      if (options.dryRun) {
        console.log(chalk.yellow('\n[DRY RUN] No changes will be made.\n'));
        return;
      }

      if (options.deploy) {
        // Password self-check if configured
        if (config.password) {
          console.log(chalk.yellow('\nThis profile requires a password to proceed.'));
          const input = await promptPassword('Enter password: ');
          if (input !== config.password) {
            console.error(chalk.red('\nError: Incorrect password. Deployment aborted.\n'));
            process.exit(1);
          }
          console.log(chalk.green('Password verified. Continuing...\n'));
        }

        const result = await deployCommand(config, sourceFolders);
        process.exit(result.success ? 0 : 1);
      }

      if (options.restore) {
        const result = await restoreCommand(config);
        process.exit(result.success ? 0 : 1);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nError: ${message}\n`));
      logger.error(message);
      try {
        await logger.save();
      } catch {
        // Ignore save errors
      }
      process.exit(1);
    }
  });

  program.parse();
}

main();
