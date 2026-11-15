'use strict';

// node --test tools/release
const assert = require('node:assert');
const { test } = require('node:test');
const { parseSums, winget } = require('./manifests.cjs');

const HASH = 'a5f5e8877dbf454c986a4a7677dd01a0fa814a5e14c86d157dc42b79e7eefc9e';
const SUMS = `${HASH}  SelfStreamDeck-0.2.0.msi\n${'b'.repeat(64)} *SelfStreamDeck-0.2.0.apk\nnot a line\n`;

test('the sums file is read as { file: hash }, with the binary marker and junk lines tolerated', () => {
  assert.deepStrictEqual(parseSums(SUMS), { 'SelfStreamDeck-0.2.0.msi': HASH, 'SelfStreamDeck-0.2.0.apk': 'b'.repeat(64) });
  assert.deepStrictEqual(parseSums(''), {});
});

test('three manifests, named as winget-pkgs wants, with the release address and the upper-case hash of the MSI', () => {
  const files = winget('0.2.0', parseSums(SUMS), 'LucasFelip/self-stream-deck');
  assert.deepStrictEqual(Object.keys(files), ['LucasFelip.SelfStreamDeck.yaml', 'LucasFelip.SelfStreamDeck.installer.yaml', 'LucasFelip.SelfStreamDeck.locale.en-US.yaml']);
  const installer = files['LucasFelip.SelfStreamDeck.installer.yaml'];
  assert.match(installer, /InstallerUrl: https:\/\/github\.com\/LucasFelip\/self-stream-deck\/releases\/download\/v0\.2\.0\/SelfStreamDeck-0\.2\.0\.msi/);
  assert.match(installer, new RegExp(`InstallerSha256: ${HASH.toUpperCase()}`));
  for (const text of Object.values(files)) {
    assert.match(text, /^PackageIdentifier: LucasFelip\.SelfStreamDeck$/m);
    assert.match(text, /^PackageVersion: 0\.2\.0$/m);
    assert.match(text, /^ManifestVersion: 1\.6\.0$/m);
  }
});

test('a version that is not a release, a missing MSI and a bad repository are refused', () => {
  assert.throws(() => winget('0.2', parseSums(SUMS), 'a/b'), /not a release version/);
  assert.throws(() => winget('0.2.0-rc1', parseSums(SUMS), 'a/b'), /not a release version/);
  assert.throws(() => winget('0.3.0', parseSums(SUMS), 'a/b'), /not in the SHA-256 list/);
  assert.throws(() => winget('0.2.0', parseSums(SUMS), 'nope'), /not owner\/name/);
});
