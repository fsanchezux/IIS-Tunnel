import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { deployCommand } from '../commands/deploy.js';
import { logger } from '../services/logger.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let configFilePath;
function getConfigPath() {
    return configFilePath;
}
function readRawConfig() {
    const content = fs.readFileSync(getConfigPath(), 'utf-8');
    return yaml.load(content);
}
function writeRawConfig(config) {
    const yamlStr = yaml.dump(config, { lineWidth: 120, noRefs: true, quotingType: '"' });
    fs.writeFileSync(getConfigPath(), yamlStr, 'utf-8');
}
async function scanDirectory(dirPath) {
    const result = [];
    if (!await fs.pathExists(dirPath))
        return result;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            const children = await scanDirectory(fullPath);
            result.push({ name: entry.name, path: fullPath, type: 'directory', children });
        }
        else {
            const stat = await fs.stat(fullPath);
            result.push({ name: entry.name, path: fullPath, type: 'file', mtime: stat.mtimeMs });
        }
    }
    return result.sort((a, b) => {
        if (a.type !== b.type)
            return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}
// Get recently changed files: try git first, fall back to mtime
function getRecentlyChangedFiles(sourcePath, commits = 5) {
    const normalize = (p) => p.replace(/\\/g, '/');
    // Try git — check if it's a repo first
    try {
        execSync('git rev-parse --is-inside-work-tree', {
            cwd: sourcePath,
            encoding: 'utf-8',
            timeout: 3000,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // It's a git repo — get changed files from last N commits
        const output = execSync(`git diff --name-only HEAD~${commits}`, {
            cwd: sourcePath,
            encoding: 'utf-8',
            timeout: 5000,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const files = output.trim().split('\n').filter(Boolean);
        if (files.length > 0) {
            return files.map(f => normalize(path.join(sourcePath, f)));
        }
    }
    catch { /* not a git repo or git not available — fall through */ }
    // Fall back to mtime: find the most recently modified files
    const allFiles = [];
    function walk(dir) {
        if (!fs.existsSync(dir))
            return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            }
            else {
                const stat = fs.statSync(full);
                allFiles.push({ path: normalize(full), mtime: stat.mtimeMs });
            }
        }
    }
    walk(sourcePath);
    if (allFiles.length === 0)
        return [];
    // Sort by mtime descending, find the most recent timestamp,
    // then return all files modified on that same day (within 24h of the newest)
    allFiles.sort((a, b) => b.mtime - a.mtime);
    const newestTime = allFiles[0].mtime;
    const cutoff = newestTime - 24 * 60 * 60 * 1000;
    return allFiles.filter(f => f.mtime >= cutoff).map(f => f.path);
}
// Convert selected files/folders back to the YAML folders format
function buildFoldersFromSelection(sourcePath, selectedPaths) {
    // Normalize all paths
    const normalize = (p) => p.replace(/\\/g, '/');
    const normalizedSource = normalize(sourcePath).replace(/\/$/, '');
    // Get relative paths
    const relativePaths = selectedPaths.map(p => {
        const norm = normalize(p);
        return norm.startsWith(normalizedSource)
            ? norm.slice(normalizedSource.length + 1)
            : norm;
    });
    // Group by top-level folder
    const folderMap = new Map();
    const rootFiles = [];
    for (const rel of relativePaths) {
        const parts = rel.split('/');
        if (parts.length === 1) {
            rootFiles.push(parts[0]);
        }
        else {
            const folder = parts[0];
            const file = parts.slice(1).join('/');
            if (!folderMap.has(folder))
                folderMap.set(folder, []);
            folderMap.get(folder).push(file);
        }
    }
    const folders = [];
    for (const [folder, files] of folderMap) {
        // Check if ALL files in this folder are selected (then just use folder name)
        const folderFullPath = path.join(sourcePath, folder);
        let allFiles = [];
        try {
            allFiles = getAllFilesRelative(folderFullPath, '');
        }
        catch { /* ignore */ }
        if (allFiles.length > 0 && allFiles.length === files.length &&
            allFiles.every(f => files.includes(f))) {
            folders.push(folder);
        }
        else {
            folders.push({ [folder]: files });
        }
    }
    return folders;
}
function getAllFilesRelative(dirPath, prefix) {
    const results = [];
    if (!fs.existsSync(dirPath))
        return results;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            results.push(...getAllFilesRelative(path.join(dirPath, entry.name), relPath));
        }
        else {
            results.push(relPath);
        }
    }
    return results;
}
// Convert the YAML folders config to a flat list of selected paths
function getSelectedPathsFromFolders(sourcePath, folders) {
    if (!folders || folders.length === 0)
        return [];
    const selected = [];
    const normalize = (p) => p.replace(/\\/g, '/');
    for (const item of folders) {
        if (typeof item === 'string') {
            // Entire folder selected - add all files recursively
            const folderPath = path.join(sourcePath, item);
            const allFiles = getAllFilesRelative(folderPath, item);
            for (const f of allFiles) {
                selected.push(normalize(path.join(sourcePath, f)));
            }
        }
        else {
            // Specific files in folder
            for (const [folder, files] of Object.entries(item)) {
                for (const file of files) {
                    selected.push(normalize(path.join(sourcePath, folder, file)));
                }
            }
        }
    }
    return selected;
}
export async function startServer(port, cfgPath) {
    configFilePath = cfgPath || path.join(process.cwd(), 'iis-tunnel.config.yaml');
    const app = express();
    app.use(express.json());
    // Serve static frontend
    const publicDir = path.join(__dirname, '..', '..', 'public');
    app.use(express.static(publicDir));
    // API: Create a new profile
    app.post('/api/profiles', (req, res) => {
        try {
            const config = readRawConfig();
            const { name, profile } = req.body;
            if (!name || !name.trim()) {
                return res.status(400).json({ error: 'Profile name is required' });
            }
            if (config.profiles[name]) {
                return res.status(409).json({ error: `Profile "${name}" already exists` });
            }
            if (!profile?.source?.path || !profile?.staging?.path || !profile?.staging?.type ||
                !profile?.destination?.path || !profile?.destination?.type ||
                !profile?.backup?.path || !profile?.logging?.path || !profile?.logging?.filename) {
                return res.status(400).json({ error: 'Missing required fields' });
            }
            config.profiles[name] = profile;
            writeRawConfig(config);
            res.status(201).json({ success: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // API: Get all profiles
    app.get('/api/profiles', (_req, res) => {
        try {
            const config = readRawConfig();
            const profiles = Object.entries(config.profiles).map(([name, profile]) => ({
                name,
                description: profile.description || '',
                sourcePath: profile.source.path,
                stagingPath: profile.staging.path,
                stagingType: profile.staging.type,
                stagingSSH: profile.staging.ssh || null,
                destinationPath: profile.destination.path,
                destinationType: profile.destination.type,
                destinationSSH: profile.destination.ssh || null,
                hasPassword: !!profile.password,
            }));
            res.json(profiles);
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // API: Get profile detail
    app.get('/api/profiles/:name', (req, res) => {
        try {
            const config = readRawConfig();
            const profile = config.profiles[req.params.name];
            if (!profile)
                return res.status(404).json({ error: 'Profile not found' });
            res.json({ name: req.params.name, ...profile });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // API: Scan source directory for a profile
    app.get('/api/profiles/:name/files', async (req, res) => {
        try {
            const config = readRawConfig();
            const profile = config.profiles[req.params.name];
            if (!profile)
                return res.status(404).json({ error: 'Profile not found' });
            const commits = parseInt(req.query.commits) || 5;
            const tree = await scanDirectory(profile.source.path);
            const selected = getSelectedPathsFromFolders(profile.source.path, profile.source.folders);
            const recentlyChanged = getRecentlyChangedFiles(profile.source.path, commits);
            res.json({ sourcePath: profile.source.path, tree, selected, recentlyChanged });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // API: Update profile folders selection
    app.put('/api/profiles/:name/folders', (req, res) => {
        try {
            const config = readRawConfig();
            const profile = config.profiles[req.params.name];
            if (!profile)
                return res.status(404).json({ error: 'Profile not found' });
            const { selectedPaths } = req.body;
            const folders = buildFoldersFromSelection(profile.source.path, selectedPaths);
            profile.source.folders = folders;
            writeRawConfig(config);
            res.json({ success: true, folders });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // API: Verify password
    app.post('/api/profiles/:name/verify-password', (req, res) => {
        try {
            const config = readRawConfig();
            const profile = config.profiles[req.params.name];
            if (!profile)
                return res.status(404).json({ error: 'Profile not found' });
            if (!profile.password)
                return res.json({ valid: true });
            const { password } = req.body;
            res.json({ valid: password === profile.password });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // API: Update profile settings (paths + SSH) — requires password
    app.put('/api/profiles/:name/settings', (req, res) => {
        try {
            const config = readRawConfig();
            const profile = config.profiles[req.params.name];
            if (!profile)
                return res.status(404).json({ error: 'Profile not found' });
            const { password, settings } = req.body;
            // Require password if profile has one
            if (profile.password) {
                if (!password || password !== profile.password) {
                    return res.status(403).json({ error: 'Invalid password' });
                }
            }
            // Apply changes
            if (settings.sourcePath !== undefined) {
                profile.source.path = settings.sourcePath;
            }
            if (settings.stagingPath !== undefined) {
                profile.staging.path = settings.stagingPath;
            }
            if (settings.destinationPath !== undefined) {
                profile.destination.path = settings.destinationPath;
            }
            if (settings.stagingSSH) {
                profile.staging.ssh = {
                    host: settings.stagingSSH.host,
                    port: settings.stagingSSH.port || 22,
                    username: settings.stagingSSH.username,
                    privateKey: settings.stagingSSH.privateKey,
                };
            }
            if (settings.destinationSSH) {
                profile.destination.ssh = {
                    host: settings.destinationSSH.host,
                    port: settings.destinationSSH.port || 22,
                    username: settings.destinationSSH.username,
                    privateKey: settings.destinationSSH.privateKey,
                };
            }
            writeRawConfig(config);
            res.json({ success: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    // Create HTTP server and WebSocket server for deploy streaming
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws) => {
        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'deploy') {
                    const { profileName } = msg;
                    // Intercept console.log to stream output
                    const originalLog = console.log;
                    const originalError = console.error;
                    const send = (type, text) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type, text }));
                        }
                    };
                    console.log = (...args) => {
                        const text = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
                        // Strip ANSI codes for the UI
                        const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
                        send('log', clean);
                        originalLog(...args);
                    };
                    console.error = (...args) => {
                        const text = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
                        const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
                        send('error', clean);
                        originalError(...args);
                    };
                    try {
                        // Load config fresh
                        const freshConfig = new (await import('../services/config.js')).ConfigService();
                        const config = await freshConfig.load(getConfigPath(), profileName);
                        const sourceFolders = freshConfig.getSourceFolders();
                        const sourceFiles = freshConfig.getSourceFiles();
                        logger.setConfig(config.logging);
                        send('status', 'deploying');
                        const result = await deployCommand(config, sourceFolders, sourceFiles);
                        send('status', result.success ? 'success' : 'error');
                        send('result', JSON.stringify(result));
                    }
                    catch (err) {
                        send('error', String(err));
                        send('status', 'error');
                    }
                    finally {
                        console.log = originalLog;
                        console.error = originalError;
                    }
                }
            }
            catch (err) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', text: String(err) }));
                }
            }
        });
    });
    server.listen(port, () => {
        console.log(`IIS-Tunnel UI running at http://localhost:${port}`);
    });
}
//# sourceMappingURL=api.js.map