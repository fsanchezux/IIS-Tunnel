# IIS-Tunnel

CLI tool for deploying files to remote Windows servers via SSH with automatic backups, rollback support and logging.

Designed for IIS application deployments: compress source files locally, transfer to a staging area, execute update scripts with backup rotation, and restore previous versions when needed.

## Features

- **Profile-based configuration** - Define multiple deployment targets in a single YAML file
- **SSH support** - Deploy to remote servers via SSH/SFTP with key-based authentication
- **Automatic backups** - Creates timestamped backups before every deployment with configurable rotation
- **Restore** - Roll back to the latest backup with a single command (`--restore`)
- **Password self-check** - Optional password per profile to prevent accidental deployments
- **Selective file deployment** - Deploy entire folders or specific files from each folder
- **7-Zip compression** - Fast file compression for efficient transfers
- **Logging** - Text and JSON logs for every deployment and restore operation

## Prerequisites

- **Node.js** >= 18.0.0
- **7-Zip** installed and available in PATH

### Installing 7-Zip

```bash
winget install 7zip.7zip
```

Then restart your terminal so the PATH is updated. Verify with:

```bash
7z
```

## Installation

### From GitHub (recommended)

```bash
npm install -g github:fsanchezux/IIS-Tunnel
```

### From a local clone

```bash
git clone https://github.com/fsanchezux/IIS-Tunnel.git
cd IIS-Tunnel
npm install
npm run build
npm link
```

After either method, the `iis-tunnel` command will be available globally in any terminal.

## Configuration

Create a file named `iis-tunnel.config.yaml` in your project directory:

```yaml
profiles:
  my-app:
    description: "My application deployment"
    password: "optional-secret"  # Optional: requires password before deploy
    source:
      path: C:\path\to\your\source
      folders:
        - bin:
            - myapp.dll
            - myapp.xml
        - wwwroot
    staging:
      type: ssh
      path: C:\Users\deployuser\staging_folder
      ssh:
        host: your-server
        port: 22
        username: deployuser
        privateKey: C:\Users\you\.ssh\your_key
    destination:
      type: ssh
      path: C:\Users\deployuser\MyApp
      ssh:
        host: your-server
        port: 22
        username: deployuser
        privateKey: C:\Users\you\.ssh\your_key
    backup:
      path: C:\Users\deployuser\backups
      maxBackups: 5
    logging:
      path: C:\Users\deployuser\logs
      filename: my-app-deploy
```

To open the configuration file in your default editor:

```bash
iis-tunnel --edit
```

## Usage

### List available profiles

```bash
iis-tunnel --list-profiles
```

### Deploy

```bash
iis-tunnel --profile my-app --deploy
```

Or use the profile name directly as a flag:

```bash
iis-tunnel --my-app --deploy
```

If the profile has a `password` configured, you will be prompted to enter it before the deployment proceeds.

### Restore latest backup

```bash
iis-tunnel --profile my-app --restore
```

### Dry run (preview without changes)

```bash
iis-tunnel --profile my-app --dry-run
```

### Edit configuration

```bash
iis-tunnel --edit
```

## Deployment Flow

1. **Compress** - Source files are compressed locally into a ZIP file using 7-Zip
2. **Transfer** - The ZIP is uploaded to the staging directory (local or SSH)
3. **Decompress** - Files are extracted in the staging directory
4. **Backup** - A timestamped backup of the current destination is created
5. **Update** - Files are copied from staging to destination via `update.bat`
6. **Rotate** - Old backups exceeding `maxBackups` are deleted
7. **Cleanup** - Temporary files are removed

## Restore Flow

1. **Generate** - `restore.bat` is created and uploaded to staging
2. **Execute** - The script finds the latest backup and copies it to the destination
3. **Cleanup** - `restore.bat` is removed from staging

## License

ISC
