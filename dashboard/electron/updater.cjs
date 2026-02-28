const { app } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const REPO_OWNER = 'm2m2nto';
const REPO_NAME = 'gulliver-dashboard-releases';
const RELEASES_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

class Updater {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.latestRelease = null;
    this.downloadedAppPath = null;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  _send(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  _getCurrentBuild() {
    try {
      const pkgPath = path.join(process.resourcesPath, 'app.asar', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.buildNumber || 0;
    } catch {
      // Fallback: try the unpacked package.json
      try {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return pkg.buildNumber || 0;
      } catch {
        return 0;
      }
    }
  }

  _httpsGet(url) {
    return new Promise((resolve, reject) => {
      const options = {
        headers: { 'User-Agent': 'G-Dashboard-Updater' },
      };
      const req = https.get(url, options, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._httpsGet(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  _getAppPath() {
    // process.execPath is e.g. /path/to/G-Dashboard.app/Contents/MacOS/G-Dashboard
    // Go up 3 levels to get the .app bundle path
    const exe = app.getPath('exe');
    return path.dirname(path.dirname(path.dirname(exe)));
  }

  // ── Public API ───────────────────────────────────────────────────────

  async checkForUpdates() {
    try {
      const data = await this._httpsGet(RELEASES_URL);
      const release = JSON.parse(data.toString());

      // Parse buildNumber from tag: v1.1.0-build.14
      const tag = release.tag_name || '';
      const buildMatch = tag.match(/build\.(\d+)/);
      if (!buildMatch) return null;

      const remoteBuild = parseInt(buildMatch[1], 10);
      const localBuild = this._getCurrentBuild();

      if (remoteBuild > localBuild) {
        // Parse version from tag: v1.1.0-build.14
        const versionMatch = tag.match(/^v?([\d.]+)/);
        const version = versionMatch ? versionMatch[1] : tag;

        this.latestRelease = {
          version,
          buildNumber: remoteBuild,
          tag: release.tag_name,
          assets: release.assets || [],
        };

        this._send('update:available', {
          version,
          buildNumber: remoteBuild,
          currentBuild: localBuild,
        });

        return this.latestRelease;
      }

      return null; // up to date
    } catch (err) {
      console.error('[updater] Check failed:', err.message);
      // Silently fail — no internet, no banner
      return null;
    }
  }

  async downloadUpdate() {
    if (!this.latestRelease) {
      this._send('update:error', { message: 'No update available' });
      return;
    }

    try {
      // Find the ZIP asset
      const zipAsset = this.latestRelease.assets.find(
        (a) => a.name.endsWith('.zip') && a.content_type !== 'application/json'
      );
      if (!zipAsset) {
        this._send('update:error', { message: 'No ZIP asset found in release' });
        return;
      }

      const tmpDir = path.join(os.tmpdir(), 'gulliver-update');
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });

      const zipPath = path.join(tmpDir, zipAsset.name);
      const totalBytes = zipAsset.size;

      // Download with progress
      await new Promise((resolve, reject) => {
        const downloadUrl = zipAsset.browser_download_url;
        const doDownload = (url) => {
          const options = { headers: { 'User-Agent': 'G-Dashboard-Updater' } };
          https.get(url, options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              doDownload(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Download failed: HTTP ${res.statusCode}`));
              return;
            }
            const file = fs.createWriteStream(zipPath);
            let downloaded = 0;
            res.on('data', (chunk) => {
              downloaded += chunk.length;
              file.write(chunk);
              this._send('update:download-progress', {
                percent: totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0,
                downloaded,
                total: totalBytes,
              });
            });
            res.on('end', () => { file.end(); resolve(); });
            res.on('error', (err) => { file.end(); reject(err); });
          }).on('error', reject);
        };
        doDownload(downloadUrl);
      });

      // Extract with ditto (macOS, preserves permissions and code signatures)
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      execSync(`ditto -xk "${zipPath}" "${extractDir}"`);

      // Find the .app inside extracted directory
      const findApp = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.endsWith('.app')) {
            return path.join(dir, entry.name);
          }
        }
        // Check one level deeper
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const nested = findApp(path.join(dir, entry.name));
            if (nested) return nested;
          }
        }
        return null;
      };

      this.downloadedAppPath = findApp(extractDir);
      if (!this.downloadedAppPath) {
        this._send('update:error', { message: 'No .app found in update ZIP' });
        return;
      }

      this._send('update:downloaded', {
        version: this.latestRelease.version,
        buildNumber: this.latestRelease.buildNumber,
      });
    } catch (err) {
      console.error('[updater] Download failed:', err.message);
      this._send('update:error', { message: err.message });
    }
  }

  applyAndRestart() {
    if (!this.downloadedAppPath) {
      this._send('update:error', { message: 'No downloaded update to apply' });
      return;
    }

    const currentAppPath = this._getAppPath();
    const newAppPath = this.downloadedAppPath;
    const appName = path.basename(currentAppPath);
    const parentDir = path.dirname(currentAppPath);

    // Spawn a detached shell script that:
    // 1. Waits for the current process to exit
    // 2. Removes the old .app
    // 3. Moves the new .app in place
    // 4. Opens the new .app
    const script = `
      sleep 1
      rm -rf "${currentAppPath}"
      mv "${newAppPath}" "${path.join(parentDir, appName)}"
      open "${path.join(parentDir, appName)}"
    `;

    const child = spawn('bash', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    app.quit();
  }
}

module.exports = Updater;
