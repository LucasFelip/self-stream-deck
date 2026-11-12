'use strict';

// One version for the whole project. `agent/Cargo.toml` says it; the interface and the Android app must say the same, or a release is
// three things with three numbers. No dependencies:  node tools/version-check/run.cjs
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const find = (file, pattern) => {
  const match = pattern.exec(read(file));
  if (!match) throw new Error(`${file}: no version found (${pattern})`);
  return match[1];
};

const version = find('agent/Cargo.toml', /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms);
const numbers = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!numbers) throw new Error(`agent/Cargo.toml: "${version}" is not a plain x.y.z version`);
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
if (wrong.length) {
  console.error(`\nThe version of the project is ${version} (agent/Cargo.toml). Change the places above to match.`);
  process.exit(1);
}
console.log(`ok   one version everywhere: ${version} (Android versionCode ${code})`);
