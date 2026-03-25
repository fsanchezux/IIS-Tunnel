import type { AppConfig } from '../types/config.types.js';
export declare class ConfigService {
    private config;
    private baseConfig;
    private activeProfile;
    private sourceFolders;
    private sourceFiles;
    load(configPath?: string, profileName?: string): Promise<AppConfig>;
    private buildConfigFromProfile;
    getActiveProfile(): string | null;
    getSourceFolders(): (string | {
        [key: string]: string[];
    })[] | null;
    getSourceFiles(): string[] | null;
    getAvailableProfiles(): string[];
    getConfig(): AppConfig;
    private findConfigFile;
    private validateBaseConfig;
    private validateProfiles;
    private validateSSH;
}
export declare const configService: ConfigService;
//# sourceMappingURL=config.d.ts.map