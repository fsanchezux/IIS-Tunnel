export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

export interface LocationConfig {
  type: 'local' | 'ssh';
  path: string;
  ssh?: SSHConfig;
}

export interface BackupConfig {
  path: string;
  maxBackups: number;
}

export interface LoggingConfig {
  path: string;
  filename: string;
}

// Profile configuration - defines complete configuration for a deployment profile
// Each profile is fully self-contained with all required settings
export interface ProfileConfig {
  description?: string;
  password?: string;
  source: {
    path: string;
    folders?: (string | { [folderName: string]: string[] })[];  // Can be folder name or {folder: [files]}
    type?: 'local' | 'ssh';
    ssh?: SSHConfig;
  };
  staging: {
    path: string;
    type: 'local' | 'ssh';
    ssh?: SSHConfig;  // Required if type is 'ssh'
  };
  destination: {
    path: string;
    type: 'local' | 'ssh';
    ssh?: SSHConfig;  // Required if type is 'ssh'
  };
  backup: {
    path: string;
    maxBackups?: number;
  };
  logging: {
    path: string;
    filename: string;
  };
}

// Base config only contains profiles - no defaults
export interface BaseConfig {
  profiles: Record<string, ProfileConfig>;
}

// Runtime config after profile is applied
export interface AppConfig {
  source: LocationConfig;
  staging: LocationConfig;
  destination: LocationConfig;
  backup: BackupConfig;
  logging: LoggingConfig;
  password?: string;
  profiles?: Record<string, ProfileConfig>;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  details?: Record<string, unknown>;
}

export interface DeployResult {
  success: boolean;
  startTime: Date;
  endTime: Date;
  filesDeployed: number;
  backupPath?: string;
  errors: string[];
}
