const path = require('path');

const WHISPER_CPP_VERSION = '1.9.1';
const RELEASE_BASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}`;
const SOURCE_ARCHIVE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.zip`;
// NOTE: this pins a GitHub auto-generated source archive, which is not
// byte-stable — GitHub may recompress it, invalidating the hash without any
// upstream release change. If the macOS source build starts failing with
// "Artifact checksum verification failed", that is why. The Windows/Linux
// targets use release assets instead and do not have this problem.
const SOURCE_ARCHIVE_SHA256 = 'e684d836a67616c0d51c9239245a46ee6a7203258b2b3354e456af5039482d13';

const RUNTIME_TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'zip',
    filename: 'whisper-cublas-12.4.0-bin-x64.zip',
    bytes: 677887125,
    sha256: '106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b',
    executable: 'whisper-server.exe'
  }),
  'linux-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.gz',
    filename: 'whisper-bin-ubuntu-x64.tar.gz',
    bytes: 9379235,
    sha256: 'f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5',
    executable: 'whisper-server'
  }),
  'linux-arm64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.gz',
    filename: 'whisper-bin-ubuntu-arm64.tar.gz',
    bytes: 4555819,
    sha256: 'e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3',
    executable: 'whisper-server'
  }),
  'darwin-x64': Object.freeze({
    kind: 'source',
    sourceArchitecture: 'x86_64',
    executable: 'whisper-server'
  }),
  'darwin-arm64': Object.freeze({
    kind: 'source',
    sourceArchitecture: 'arm64',
    executable: 'whisper-server'
  })
});

function getRuntimeTarget(platform = process.platform, architecture = process.arch) {
  const key = `${platform}-${architecture}`;
  const target = RUNTIME_TARGETS[key];
  if (!target) throw new Error(`Local Whisper is not packaged for ${key}.`);
  return {
    ...target,
    key,
    url: target.kind === 'archive' ? `${RELEASE_BASE_URL}/${target.filename}` : SOURCE_ARCHIVE_URL
  };
}

function getRuntimeExecutablePath(runtimeDirectory, platform = process.platform, architecture = process.arch) {
  return path.join(runtimeDirectory, getRuntimeTarget(platform, architecture).executable);
}

module.exports = {
  WHISPER_CPP_VERSION,
  RUNTIME_TARGETS,
  SOURCE_ARCHIVE_URL,
  SOURCE_ARCHIVE_SHA256,
  getRuntimeTarget,
  getRuntimeExecutablePath
};
