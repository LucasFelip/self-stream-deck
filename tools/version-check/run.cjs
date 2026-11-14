'use strict';

// One version for the whole project. `agent/Cargo.toml` says it; the interface and the Android app must say the same, or a release is
// three things with three numbers. No dependencies.
//
//   node tools/version-check/run.cjs                 every place says the same version
//   node tools/version-check/run.cjs --tag v0.2.0    ...and that version is the one of this tag (the release workflow)
//   node tools/version-check/run.cjs --notes v0.2.0  prints the section of CHANGELOG.md of that version (fails when it is missing or empty)
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const find = (file, pattern) => {
  const match = pattern.exec(read(file));
  if (!match) throw new Error(`${file}: no version found (${pattern})`);
  return match[1];
};
const fail = (message) => { console.error(message); process.exit(1); };
const option = (name) => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1] ?? ''; };

const version = find('agent/Cargo.toml', /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms);

/** the lines under `## [version]` of the changelog, up to the next version */
function notes(of) {
  const lines = read('CHANGELOG.md').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${of}]`));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \[/.test(line) || /^\[[^\]]+\]: /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

const wantedNotes = option('--notes');
if (wantedNotes !== null) {
  const text = notes(wantedNotes.replace(/^v/, ''));
  if (!text) fail(`CHANGELOG.md has no notes under "## [${wantedNotes.replace(/^v/, '')}]": write what changed before tagging.`);
  console.log(text);
  process.exit(0);
}

const tag = option('--tag');
if (tag !== null) {
  if (tag !== `v${version}`) fail(`the tag is ${tag}, but the version of the project is ${version} (agent/Cargo.toml): the tag must be v${version}`);
  console.log(`ok   the tag ${tag} is the version of the project`);
  process.exit(0);
}

const numbers = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!numbers) fail(`agent/Cargo.toml: "${version}" is not a plain x.y.z version`);
const code = String(Number(numbers[1]) * 10000 + Number(numbers[2]) * 100 + Number(numbers[3]));

const lock = JSON.parse(read('web/package-lock.json'));
const found = [
  ['web/package.json', JSON.parse(read('web/package.json')).version, version],
  ['web/package-lock.json', lock.version, version],
  ['web/package-lock.json (packages[""])', lock.packages[''].version, version],
  ['android/app/build.gradle.kts (versionName)', find('android/app/build.gradle.kts', /versionName\s*=\s*"([^"]+)"/), version],
  ['android/app/build.gradle.kts (versionCode)', find('android/app/build.gradle.kts', /versionCode\s*=\s*(\d+)/), code],
];

const wrong = found.filter(([, actual, expected]) => actual !== expected);
for (const [where, actual, expected] of wrong) console.error(`${where}: ${actual}, expected ${expected}`);
if (wrong.length) fail(`\nThe version of the project is ${version} (agent/Cargo.toml). Change the places above to match.`);
console.log(`ok   one version everywhere: ${version} (Android versionCode ${code})`);
