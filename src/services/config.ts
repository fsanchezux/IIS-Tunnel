import fs from 'fs-extra';
import yaml from 'js-yaml';
import path from 'path';
import type { AppConfig, LocationConfig, SSHConfig, ProfileConfig, BaseConfig } from '../types/config.types.js';

const CONFIG_FILENAME = 'iis-tunnel.config.yaml';

export class ConfigService {
  private config: AppConfig | null = null;
  private baseConfig: BaseConfig | null = null;
  private activeProfile: string | null = null;
  private sourceFolders: (string | { [key: string]: string[] })[] | null = null;

  async load(configPath?: string, profileName?: string): Promise<AppConfig> {
    const filePath = configPath || this.findConfigFile();

    if (!filePath) {
      throw new Error(`Configuration file not found. Create '${CONFIG_FILENAME}' in the current directory.`);
    }

    const fileContent = await fs.readFile(filePath, 'utf-8');
    const rawConfig = yaml.load(fileContent) as Record<string, unknown>;

    // Parse base config (only profiles)
    this.baseConfig = this.validateBaseConfig(rawConfig);

    // If profile specified, build full config from profile
    if (profileName) {
      this.config = this.buildConfigFromProfile(profileName);
    } else {
      // No profile - create minimal config for listing profiles
      this.config = {
        source: { type: 'local', path: '' },
        staging: { type: 'local', path: '' },
        destination: { type: 'local', path: '' },
        backup: { path: '', maxBackups: 3 },
        logging: { path: './logs', filename: 'deploy' },
        profiles: this.baseConfig.profiles,
      };
    }

    return this.config;
  }

  private buildConfigFromProfile(profileName: string): AppConfig {
    if (!this.baseConfig) {
      throw new Error('Base configuration not loaded.');
    }

    if (!this.baseConfig.profiles || !this.baseConfig.profiles[profileName]) {
      const availableProfiles = this.baseConfig.profiles
        ? Object.keys(this.baseConfig.profiles).join(', ')
        : 'none';
      throw new Error(
        `Profile "${profileName}" not found. Available profiles: ${availableProfiles}`
      );
    }

    const profile = this.baseConfig.profiles[profileName];
    this.activeProfile = profileName;

    // Build source config
    const sourceType = profile.source.type || 'local';
    const source: LocationConfig = {
      type: sourceType,
      path: profile.source.path,
    };
    if (sourceType === 'ssh') {
      if (!profile.source.ssh) {
        throw new Error(`Profile "${profileName}": source is SSH but no SSH config provided`);
      }
      source.ssh = profile.source.ssh;
    }

    // Set source folders if specified
    if (profile.source.folders && profile.source.folders.length > 0) {
      this.sourceFolders = profile.source.folders;
    }

    // Build staging config
    const stagingType = profile.staging.type;
    const staging: LocationConfig = {
      type: stagingType,
      path: profile.staging.path,
    };
    if (stagingType === 'ssh') {
      if (!profile.staging.ssh) {
        throw new Error(`Profile "${profileName}": staging is SSH but no SSH config provided`);
      }
      staging.ssh = profile.staging.ssh;
    }

    // Build destination config
    const destType = profile.destination.type;
    const destination: LocationConfig = {
      type: destType,
      path: profile.destination.path,
    };
    if (destType === 'ssh') {
      if (!profile.destination.ssh) {
        throw new Error(`Profile "${profileName}": destination is SSH but no SSH config provided`);
      }
      destination.ssh = profile.destination.ssh;
    }

    // Build backup config
    const backup = {
      path: profile.backup.path,
      maxBackups: profile.backup.maxBackups || 3,
    };

    // Build logging config (required in profile)
    const logging = {
      path: profile.logging.path,
      filename: profile.logging.filename,
    };

    return {
      source,
      staging,
      destination,
      backup,
      logging,
      password: profile.password,
      profiles: this.baseConfig.profiles,
    };
  }

  getActiveProfile(): string | null {
    return this.activeProfile;
  }

  getSourceFolders(): (string | { [key: string]: string[] })[] | null {
    return this.sourceFolders;
  }

  getAvailableProfiles(): string[] {
    if (!this.baseConfig || !this.baseConfig.profiles) {
      return [];
    }
    return Object.keys(this.baseConfig.profiles);
  }

  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
    return this.config;
  }

  private findConfigFile(): string | null {
    const currentDir = process.cwd();
    const configPath = path.join(currentDir, CONFIG_FILENAME);

    if (fs.existsSync(configPath)) {
      return configPath;
    }

    return null;
  }

  private validateBaseConfig(raw: Record<string, unknown>): BaseConfig {
    // Profiles are required
    if (!raw.profiles) {
      throw new Error('Missing "profiles" in configuration. At least one profile is required.');
    }

    return {
      profiles: this.validateProfiles(raw.profiles as Record<string, unknown>),
    };
  }

  private validateProfiles(raw: Record<string, unknown>): Record<string, ProfileConfig> {
    const profiles: Record<string, ProfileConfig> = {};

    for (const [name, profileRaw] of Object.entries(raw)) {
      const profile = profileRaw as Record<string, unknown>;

      // Validate source (required)
      if (!profile.source) {
        throw new Error(`Profile "${name}" must have a "source" configuration`);
      }
      const sourceRaw = profile.source as Record<string, unknown>;
      if (!sourceRaw.path) {
        throw new Error(`Profile "${name}.source" must have "path" defined`);
      }

      // Validate staging (required)
      if (!profile.staging) {
        throw new Error(`Profile "${name}" must have a "staging" configuration`);
      }
      const stagingRaw = profile.staging as Record<string, unknown>;
      if (!stagingRaw.path || !stagingRaw.type) {
        throw new Error(`Profile "${name}.staging" must have "path" and "type" defined`);
      }
      // If staging is SSH, ssh config is required
      if (stagingRaw.type === 'ssh' && !stagingRaw.ssh) {
        throw new Error(`Profile "${name}.staging" is SSH but missing "ssh" configuration`);
      }

      // Validate destination (required)
      if (!profile.destination) {
        throw new Error(`Profile "${name}" must have a "destination" configuration`);
      }
      const destRaw = profile.destination as Record<string, unknown>;
      if (!destRaw.path || !destRaw.type) {
        throw new Error(`Profile "${name}.destination" must have "path" and "type" defined`);
      }
      // If destination is SSH, ssh config is required
      if (destRaw.type === 'ssh' && !destRaw.ssh) {
        throw new Error(`Profile "${name}.destination" is SSH but missing "ssh" configuration`);
      }

      // Validate backup (required)
      if (!profile.backup) {
        throw new Error(`Profile "${name}" must have a "backup" configuration`);
      }
      const backupRaw = profile.backup as Record<string, unknown>;
      if (!backupRaw.path) {
        throw new Error(`Profile "${name}.backup" must have "path" defined`);
      }

      // Validate logging (required)
      if (!profile.logging) {
        throw new Error(`Profile "${name}" must have a "logging" configuration`);
      }
      const loggingRaw = profile.logging as Record<string, unknown>;
      if (!loggingRaw.path || !loggingRaw.filename) {
        throw new Error(`Profile "${name}.logging" must have "path" and "filename" defined`);
      }

      // Validate SSH configs if present
      if (stagingRaw.ssh) {
        this.validateSSH(stagingRaw.ssh as Record<string, unknown>, `${name}.staging.ssh`);
      }
      if (destRaw.ssh) {
        this.validateSSH(destRaw.ssh as Record<string, unknown>, `${name}.destination.ssh`);
      }
      if (sourceRaw.ssh) {
        this.validateSSH(sourceRaw.ssh as Record<string, unknown>, `${name}.source.ssh`);
      }

      profiles[name] = {
        description: profile.description as string | undefined,
        password: profile.password as string | undefined,
        source: {
          path: sourceRaw.path as string,
          folders: sourceRaw.folders as string[] | undefined,
          type: (sourceRaw.type as 'local' | 'ssh') || 'local',
          ssh: sourceRaw.ssh as SSHConfig | undefined,
        },
        staging: {
          path: stagingRaw.path as string,
          type: stagingRaw.type as 'local' | 'ssh',
          ssh: stagingRaw.ssh as SSHConfig | undefined,
        },
        destination: {
          path: destRaw.path as string,
          type: destRaw.type as 'local' | 'ssh',
          ssh: destRaw.ssh as SSHConfig | undefined,
        },
        backup: {
          path: backupRaw.path as string,
          maxBackups: backupRaw.maxBackups as number | undefined,
        },
        logging: {
          path: loggingRaw.path as string,
          filename: loggingRaw.filename as string,
        },
      };
    }

    return profiles;
  }

  private validateSSH(raw: Record<string, unknown>, name: string): SSHConfig {
    if (!raw.host || typeof raw.host !== 'string') {
      throw new Error(`Invalid or missing "host" in ${name}`);
    }
    if (!raw.username || typeof raw.username !== 'string') {
      throw new Error(`Invalid or missing "username" in ${name}`);
    }
    if (!raw.password && !raw.privateKey) {
      throw new Error(`Either "password" or "privateKey" is required in ${name}`);
    }

    return {
      host: raw.host as string,
      port: (raw.port as number) || 22,
      username: raw.username as string,
      password: raw.password as string | undefined,
      privateKey: raw.privateKey as string | undefined,
    };
  }
}

export const configService = new ConfigService();
