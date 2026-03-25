import fs from 'fs-extra';
import yaml from 'js-yaml';
import path from 'path';
const CONFIG_FILENAME = 'iis-tunnel.config.yaml';
export class ConfigService {
    config = null;
    baseConfig = null;
    activeProfile = null;
    sourceFolders = null;
    sourceFiles = null;
    async load(configPath, profileName) {
        const filePath = configPath || this.findConfigFile();
        if (!filePath) {
            throw new Error(`Configuration file not found. Create '${CONFIG_FILENAME}' in the current directory.`);
        }
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const rawConfig = yaml.load(fileContent);
        // Parse base config (only profiles)
        this.baseConfig = this.validateBaseConfig(rawConfig);
        // If profile specified, build full config from profile
        if (profileName) {
            this.config = this.buildConfigFromProfile(profileName);
        }
        else {
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
    buildConfigFromProfile(profileName) {
        if (!this.baseConfig) {
            throw new Error('Base configuration not loaded.');
        }
        if (!this.baseConfig.profiles || !this.baseConfig.profiles[profileName]) {
            const availableProfiles = this.baseConfig.profiles
                ? Object.keys(this.baseConfig.profiles).join(', ')
                : 'none';
            throw new Error(`Profile "${profileName}" not found. Available profiles: ${availableProfiles}`);
        }
        const profile = this.baseConfig.profiles[profileName];
        this.activeProfile = profileName;
        // Build source config
        const sourceType = profile.source.type || 'local';
        const source = {
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
        // Set source files (loose files at root) if specified
        if (profile.source.files && profile.source.files.length > 0) {
            this.sourceFiles = profile.source.files;
        }
        // Build staging config
        const stagingType = profile.staging.type;
        const staging = {
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
        const destination = {
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
    getActiveProfile() {
        return this.activeProfile;
    }
    getSourceFolders() {
        return this.sourceFolders;
    }
    getSourceFiles() {
        return this.sourceFiles;
    }
    getAvailableProfiles() {
        if (!this.baseConfig || !this.baseConfig.profiles) {
            return [];
        }
        return Object.keys(this.baseConfig.profiles);
    }
    getConfig() {
        if (!this.config) {
            throw new Error('Configuration not loaded. Call load() first.');
        }
        return this.config;
    }
    findConfigFile() {
        const currentDir = process.cwd();
        const configPath = path.join(currentDir, CONFIG_FILENAME);
        if (fs.existsSync(configPath)) {
            return configPath;
        }
        return null;
    }
    validateBaseConfig(raw) {
        // Profiles are required
        if (!raw.profiles) {
            throw new Error('Missing "profiles" in configuration. At least one profile is required.');
        }
        return {
            profiles: this.validateProfiles(raw.profiles),
        };
    }
    validateProfiles(raw) {
        const profiles = {};
        for (const [name, profileRaw] of Object.entries(raw)) {
            const profile = profileRaw;
            // Validate source (required)
            if (!profile.source) {
                throw new Error(`Profile "${name}" must have a "source" configuration`);
            }
            const sourceRaw = profile.source;
            if (!sourceRaw.path) {
                throw new Error(`Profile "${name}.source" must have "path" defined`);
            }
            // Validate staging (required)
            if (!profile.staging) {
                throw new Error(`Profile "${name}" must have a "staging" configuration`);
            }
            const stagingRaw = profile.staging;
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
            const destRaw = profile.destination;
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
            const backupRaw = profile.backup;
            if (!backupRaw.path) {
                throw new Error(`Profile "${name}.backup" must have "path" defined`);
            }
            // Validate logging (required)
            if (!profile.logging) {
                throw new Error(`Profile "${name}" must have a "logging" configuration`);
            }
            const loggingRaw = profile.logging;
            if (!loggingRaw.path || !loggingRaw.filename) {
                throw new Error(`Profile "${name}.logging" must have "path" and "filename" defined`);
            }
            // Validate SSH configs if present
            if (stagingRaw.ssh) {
                this.validateSSH(stagingRaw.ssh, `${name}.staging.ssh`);
            }
            if (destRaw.ssh) {
                this.validateSSH(destRaw.ssh, `${name}.destination.ssh`);
            }
            if (sourceRaw.ssh) {
                this.validateSSH(sourceRaw.ssh, `${name}.source.ssh`);
            }
            profiles[name] = {
                description: profile.description,
                password: profile.password,
                source: {
                    path: sourceRaw.path,
                    folders: sourceRaw.folders,
                    files: sourceRaw.files,
                    type: sourceRaw.type || 'local',
                    ssh: sourceRaw.ssh,
                },
                staging: {
                    path: stagingRaw.path,
                    type: stagingRaw.type,
                    ssh: stagingRaw.ssh,
                },
                destination: {
                    path: destRaw.path,
                    type: destRaw.type,
                    ssh: destRaw.ssh,
                },
                backup: {
                    path: backupRaw.path,
                    maxBackups: backupRaw.maxBackups,
                },
                logging: {
                    path: loggingRaw.path,
                    filename: loggingRaw.filename,
                },
            };
        }
        return profiles;
    }
    validateSSH(raw, name) {
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
            host: raw.host,
            port: raw.port || 22,
            username: raw.username,
            password: raw.password,
            privateKey: raw.privateKey,
        };
    }
}
export const configService = new ConfigService();
//# sourceMappingURL=config.js.map