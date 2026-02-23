const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const net = require('net');

let mainWindow = null;
let serverProcess = null;
let serverPort = null;

// ── Helpers ──────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function getDataDirDefault() {
  // In packaged .app: exe is at Contents/MacOS/GL-Dashboard
  // We want the folder *containing* the .app bundle → go up 3 levels
  const exe = app.getPath('exe');
  return path.dirname(path.dirname(path.dirname(path.dirname(exe))));
}

function getResourcesPath() {
  // In packaged app: process.resourcesPath points to Contents/Resources
  // In dev: not used (we connect to Vite)
  return process.resourcesPath;
}

// ── Server lifecycle ─────────────────────────────────────────────────

function startServer(port) {
  return new Promise((resolve, reject) => {
    const resources = getResourcesPath();
    const serverEntry = path.join(resources, 'server', 'index.js');
    const dataDir = getDataDirDefault();

    const env = {
      ...process.env,
      PORT: String(port),
      GULLIVER_APP_DIR: resources,
      GULLIVER_DATA_DIR: dataDir,
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
    };

    serverProcess = fork(serverEntry, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    serverProcess.stdout.on('data', (data) => {
      console.log(`[server] ${data.toString().trimEnd()}`);
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[server] ${data.toString().trimEnd()}`);
    });

    serverProcess.on('message', (msg) => {
      if (msg && msg.type === 'ready') {
        console.log(`Server ready on port ${msg.port}`);
        resolve(msg.port);
      }
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start server:', err);
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      console.log(`Server exited with code ${code}`);
      serverProcess = null;
    });

    // Timeout: if server doesn't signal ready in 15s, reject
    setTimeout(() => reject(new Error('Server start timeout')), 15000);
  });
}

function killServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// ── Window ───────────────────────────────────────────────────────────

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    title: 'GL-Dashboard',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────

ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Data Directory',
  });
  if (canceled || filePaths.length === 0) return null;
  return filePaths[0];
});

ipcMain.handle('dialog:openFile', async (_event, options = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: options.title || 'Select File',
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }],
  });
  if (canceled || filePaths.length === 0) return null;
  return filePaths[0];
});

// ── App lifecycle ────────────────────────────────────────────────────

app.on('ready', async () => {
  try {
    if (!app.isPackaged) {
      // Dev mode: assume npm run dev is running on 5173
      serverPort = 5173;
      console.log('Dev mode — connecting to localhost:5173');
    } else {
      const port = await getFreePort();
      serverPort = await startServer(port);
    }
    createWindow(serverPort);
  } catch (err) {
    console.error('Startup failed:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && serverPort) {
    createWindow(serverPort);
  }
});

app.on('before-quit', () => {
  killServer();
});
