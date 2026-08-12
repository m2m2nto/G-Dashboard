import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNativeSelectDirectoryScript,
  buildNativeSelectFileScript,
  buildNativeSelectFilesScript,
} from '../routes/settings.js';

test('settings native file dialog escapes title and default directory in AppleScript', () => {
  const script = buildNativeSelectFileScript({
    title: 'Pick "file"\nwith text',
    startDir: '/tmp/project "quoted"/folder',
  });

  assert.match(script, /Pick \\"file\\" with text/);
  assert.match(script, /\/tmp\/project \\"quoted\\"\/folder/);
  assert.doesNotMatch(script, /Pick "file"\n/);
});

test('settings native multi-file dialog escapes title and default directory in AppleScript', () => {
  const script = buildNativeSelectFilesScript({
    title: 'Select "many"\rfiles',
    startDir: '/tmp/a "b"',
  });

  assert.match(script, /Select \\"many\\" files/);
  assert.match(script, /\/tmp\/a \\"b\\"/);
});

test('settings native directory dialog escapes title and default directory in AppleScript', () => {
  const script = buildNativeSelectDirectoryScript({
    title: 'Folder "name"\nnext',
    startDir: '/tmp/folder "unsafe"',
  });

  assert.match(script, /Folder \\"name\\" next/);
  assert.match(script, /\/tmp\/folder \\"unsafe\\"/);
});
