'use strict';

// The winget manifests of a release, made from its version and the SHA256SUMS.txt that the release workflow publishes beside the MSI:
//
//   node tools/release/manifests.cjs --version 0.2.0 --sums pub/SHA256SUMS.txt [--repo LucasFelip/self-stream-deck] --out pub/winget
//
// Three files, named as winget-pkgs wants them (LucasFelip.SelfStreamDeck.yaml, .installer.yaml and .locale.en-US.yaml). The release workflow attaches
// them to the release; submitting them to winget-pkgs is a decision of the person who owns the project (docs/desenvolvimento.md).
const fs = require('node:fs');
const path = require('node:path');

const ID = 'LucasFelip.SelfStreamDeck';
const SCHEMA = '1.6.0';

/** `abc…  SelfStreamDeck-0.2.0.msi` (or `abc… *file`) lines of a sha256sum file, as { file: hash }. */
function parseSums(text) {
  const sums = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums[match[2]] = match[1].toLowerCase();
  }
  return sums;
}

function check(version, repo) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error(`"${version}" is not a release version (1.2.3)`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/name`);
}

/** The three manifests as { file name: text }. */
function winget(version, sums, repo) {
  check(version, repo);
  const msi = `SelfStreamDeck-${version}.msi`;
  const hash = sums[msi];
  if (!hash) throw new Error(`${msi} is not in the SHA-256 list`);
  const head = (type) => `PackageIdentifier: ${ID}\nPackageVersion: ${version}\n`;
  const tail = (type) => `ManifestType: ${type}\nManifestVersion: ${SCHEMA}\n`;
  return {
    [`${ID}.yaml`]: `${head()}DefaultLocale: en-US\n${tail('version')}`,
    [`${ID}.installer.yaml`]: `${head()}InstallerLocale: en-US
Platform:
  - Windows.Desktop
MinimumOSVersion: 10.0.17763.0
InstallerType: wix
Scope: machine
InstallModes:
  - silent
  - silentWithProgress
InstallerSwitches:
  Silent: /qn
  SilentWithProgress: /qb
UpgradeBehavior: install
Installers:
  - Architecture: x64
    InstallerUrl: https://github.com/${repo}/releases/download/v${version}/${msi}
    InstallerSha256: ${hash.toUpperCase()}
${tail('installer')}`,
    [`${ID}.locale.en-US.yaml`]: `${head()}PackageLocale: en-US
Publisher: ${repo.split('/')[0]}
PublisherUrl: https://github.com/${repo.split('/')[0]}
PackageName: Self Stream Deck
PackageUrl: https://github.com/${repo}
License: MIT
LicenseUrl: https://github.com/${repo}/blob/main/LICENSE
ShortDescription: Turns a phone into a control panel for a Windows PC.
Description: Open programs, fire shortcuts, adjust the sound, control media, watch performance, arrange windows, shut the PC down and use the phone camera as a webcam. The agent runs on the PC (a single executable), the panel is a web page, and nothing goes through the internet.
Moniker: self-stream-deck
Tags:
  - stream-deck
  - remote-control
  - android
  - webcam
${tail('defaultLocale')}`,
  };
}

function main(argv) {
  const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const version = option('--version');
  const sumsFile = option('--sums');
  const out = option('--out');
  const repo = option('--repo') || 'LucasFelip/self-stream-deck';
  if (!version || !sumsFile || !out) {
    console.error('usage: node tools/release/manifests.cjs --version X.Y.Z --sums SHA256SUMS.txt --out DIR [--repo owner/name]');
    process.exit(2);
  }
  const files = winget(version, parseSums(fs.readFileSync(sumsFile, 'utf8')), repo);
  fs.mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text);
  console.log(`${Object.keys(files).length} winget manifests for ${version} in ${out}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseSums, winget };
