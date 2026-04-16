import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-settings-attachment-root-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const [{ default: settingsRouter }, { settingsPath }] = await Promise.all([
  import('../routes/settings.js'),
  import('../services/settings.js'),
]);

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
      });
    });
  });
}

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test('PUT /api/settings stores attachmentRoot and GET /api/settings returns it', async () => {
  const attachmentRoot = await mkdtemp(join(testRoot, 'attachments-'));
  const { server, baseUrl } = await startServer();

  try {
    const putRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ attachmentRoot }),
    });

    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.attachmentRoot, attachmentRoot);

    const getRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.attachmentRoot, attachmentRoot);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});

test('PUT /api/settings rejects a non-existent attachmentRoot', async () => {
  const { server, baseUrl } = await startServer();

  try {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ attachmentRoot: join(testRoot, 'missing-dir') }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Attachment root does not exist');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});

test('PUT /api/settings rejects a file path for attachmentRoot', async () => {
  const filePath = join(testRoot, 'not-a-directory.txt');
  await writeFile(filePath, 'x', 'utf8');

  const { server, baseUrl } = await startServer();

  try {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ attachmentRoot: filePath }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Attachment root must be a directory');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});

test('attachmentRoot is persisted in the settings file', async () => {
  const attachmentRoot = await mkdtemp(join(testRoot, 'persisted-attachments-'));
  const { server, baseUrl } = await startServer();

  try {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ attachmentRoot }),
    });

    assert.equal(res.status, 200);

    const settingsFile = await import('fs/promises').then(({ readFile }) => readFile(settingsPath(), 'utf8'));
    const settings = JSON.parse(settingsFile);
    assert.equal(settings.attachmentRoot, attachmentRoot);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});
