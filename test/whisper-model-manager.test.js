const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { WhisperModelManager } = require('../src/whisper-model-manager');

function createFixtureModel(content) {
  return Object.freeze({
    id: 'fixture',
    filename: 'ggml-fixture.bin',
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    url: 'https://example.test/ggml-fixture.bin'
  });
}

function createTestDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-model-manager-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function response(status, chunks) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: Readable.from(chunks)
  };
}

test('resumes, verifies, and atomically installs a model download', async (context) => {
  const content = Buffer.from('verified model fixture');
  const model = createFixtureModel(content);
  const userDataPath = createTestDirectory(context);
  let requestHeaders = null;
  const manager = new WhisperModelManager({
    userDataPath,
    models: [model],
    now: () => 1000,
    fetchImpl: async (_url, options) => {
      requestHeaders = options.headers;
      return response(206, [content.subarray(8)]);
    }
  });
  fs.mkdirSync(manager.modelDirectory, { recursive: true });
  fs.writeFileSync(manager.getPartialPath(model.id), content.subarray(0, 8));

  const result = await manager.download(model.id);
  assert.equal(result.resumed, true);
  assert.equal(requestHeaders.Range, 'bytes=8-');
  assert.deepEqual(fs.readFileSync(manager.getModelPath(model.id)), content);
  assert.equal(fs.existsSync(manager.getPartialPath(model.id)), false);
  assert.equal((await manager.listModels())[0].installed, true);
});

test('removes a checksum-invalid completed download so retry can start cleanly', async (context) => {
  const content = Buffer.from('expected bytes');
  const model = createFixtureModel(content);
  const manager = new WhisperModelManager({
    userDataPath: createTestDirectory(context),
    models: [model],
    fetchImpl: async () => response(200, [Buffer.from('incorrect data')])
  });

  await assert.rejects(manager.download(model.id), /checksum mismatch/);
  assert.equal(fs.existsSync(manager.getPartialPath(model.id)), false);
  assert.equal(fs.existsSync(manager.getModelPath(model.id)), false);
});

test('replaces an incomplete destination left by an interrupted filesystem move', async (context) => {
  const content = Buffer.from('replacement fixture');
  const model = createFixtureModel(content);
  const manager = new WhisperModelManager({
    userDataPath: createTestDirectory(context),
    models: [model],
    fetchImpl: async () => response(200, [content])
  });
  fs.mkdirSync(manager.modelDirectory, { recursive: true });
  fs.writeFileSync(manager.getModelPath(model.id), Buffer.from('short'));

  await manager.download(model.id);
  assert.deepEqual(fs.readFileSync(manager.getModelPath(model.id)), content);
});

test('replaces a zero-byte destination before the final atomic rename', async (context) => {
  const content = Buffer.from('zero-byte replacement fixture');
  const model = createFixtureModel(content);
  const manager = new WhisperModelManager({
    userDataPath: createTestDirectory(context),
    models: [model],
    fetchImpl: async () => response(200, [content])
  });
  fs.mkdirSync(manager.modelDirectory, { recursive: true });
  fs.writeFileSync(manager.getModelPath(model.id), Buffer.alloc(0));

  await manager.download(model.id);
  assert.deepEqual(fs.readFileSync(manager.getModelPath(model.id)), content);
});

test('cancels an in-flight download while retaining resumable bytes', async (context) => {
  const content = Buffer.from('cancel fixture');
  const model = createFixtureModel(content);
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  const manager = new WhisperModelManager({
    userDataPath: createTestDirectory(context),
    models: [model],
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      fetchStarted();
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });

  const download = manager.download(model.id);
  await started;
  assert.equal(manager.cancelDownload(model.id), true);
  await assert.rejects(download, /cancelled/);
  assert.equal(manager.activeDownload, null);
});

test('imports only a file matching the selected model integrity contract', async (context) => {
  const content = Buffer.from('import fixture');
  const model = createFixtureModel(content);
  const userDataPath = createTestDirectory(context);
  const sourcePath = path.join(userDataPath, 'source.bin');
  fs.writeFileSync(sourcePath, content);
  const manager = new WhisperModelManager({
    userDataPath,
    models: [model],
    fetchImpl: async () => { throw new Error('not used'); }
  });

  await manager.importModel(model.id, sourcePath);
  assert.deepEqual(fs.readFileSync(manager.getModelPath(model.id)), content);
  await manager.deleteModel(model.id);
  assert.equal(fs.existsSync(manager.getModelPath(model.id)), false);
});

test('an untouched installed model is hashed once, not on every Listen', async (context) => {
  const content = Buffer.from('installed model fixture');
  const model = createFixtureModel(content);
  const manager = new WhisperModelManager({
    userDataPath: createTestDirectory(context),
    models: [model],
    fetchImpl: async () => { throw new Error('not used'); }
  });
  fs.mkdirSync(manager.modelDirectory, { recursive: true });
  fs.writeFileSync(manager.getModelPath(model.id), content);

  let hashes = 0;
  const hash = manager._sha256.bind(manager);
  manager._sha256 = (filePath) => { hashes += 1; return hash(filePath); };

  assert.equal(await manager.verifyInstalledModel(model.id), manager.getModelPath(model.id));
  assert.equal(hashes, 1);
  await manager.verifyInstalledModel(model.id);
  await manager.verifyInstalledModel(model.id);
  assert.equal(hashes, 1, 'the second and third checks reuse the recorded verification');

  // A new manager (app restart) still trusts the record on disk.
  const restarted = new WhisperModelManager({ userDataPath: path.dirname(manager.modelDirectory), models: [model], fetchImpl: async () => { throw new Error('not used'); } });
  let restartedHashes = 0;
  const restartedHash = restarted._sha256.bind(restarted);
  restarted._sha256 = (filePath) => { restartedHashes += 1; return restartedHash(filePath); };
  await restarted.verifyInstalledModel(model.id);
  assert.equal(restartedHashes, 0);
});

test('a model file that changed after verification is hashed again and rejected', async (context) => {
  const content = Buffer.from('installed model fixture');
  const model = createFixtureModel(content);
  const manager = new WhisperModelManager({
    userDataPath: createTestDirectory(context),
    models: [model],
    fetchImpl: async () => { throw new Error('not used'); }
  });
  fs.mkdirSync(manager.modelDirectory, { recursive: true });
  const modelPath = manager.getModelPath(model.id);
  fs.writeFileSync(modelPath, content);
  await manager.verifyInstalledModel(model.id);

  // Same size, different bytes, later timestamp.
  const tampered = Buffer.from(content);
  tampered[0] ^= 0xff;
  fs.writeFileSync(modelPath, tampered);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(modelPath, later, later);

  await assert.rejects(manager.verifyInstalledModel(model.id), /checksum mismatch/);
});

test('reports a missing selected model distinctly from a corrupt model', async (context) => {
  const content = Buffer.from('missing model fixture');
  const model = createFixtureModel(content);
  const manager = new WhisperModelManager({
    userDataPath: createTestDirectory(context),
    models: [model],
    fetchImpl: async () => { throw new Error('not used'); }
  });

  await assert.rejects(
    manager.verifyInstalledModel(model.id),
    (error) => error.code === 'ENOENT'
  );
});
