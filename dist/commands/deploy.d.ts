import type { AppConfig, DeployResult } from '../types/config.types.js';
export declare function deployCommand(config: AppConfig, sourceFolders?: (string | {
    [key: string]: string[];
})[] | null, looseFiles?: string[] | null): Promise<DeployResult>;
//# sourceMappingURL=deploy.d.ts.map