'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DATA_DIR } = require('./config');
const { log } = require('./log');

/**
 * The native helper: native/*.cs compiled into one small exe (ssd-helper.exe) with the C# compiler that ships with Windows
 * (.NET Framework 4, no SDK needed). It speaks the same line protocol as the PowerShell helpers and uses a fraction of their memory
 * and start-up time. The exe is built on first use into data/bin/, named after a hash of the sources, so editing a source builds
 * a new one and an unchanged tree is never compiled twice. When the compiler is missing or the build fails, callers get null and
 * fall back to the PowerShell scripts.
 */

const SOURCES = path.join(__dirname, '..', 'native');
const OUT_DIR = path.join(DATA_DIR, 'bin');
const FRAMEWORK = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const CSC = path.join(FRAMEWORK, 'csc.exe');
const REFERENCES = ['System.Web.Extensions.dll', 'System.Management.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Core.dll', 'Microsoft.CSharp.dll'];

let building = null;
let resolved = null; // the path once ensure() has finished (null while building, or when it cannot be built)

function sourceFiles() {
  return fs.readdirSync(SOURCES).filter((name) => name.endsWith('.cs')).sort().map((name) => path.join(SOURCES, name));
}

function hashOfSources() {
  const hash = crypto.createHash('sha256');
  for (const file of sourceFiles()) hash.update(path.basename(file)).update(fs.readFileSync(file));
  return hash.digest('hex').slice(0, 16);
}

function compile(output, files) {
  return new Promise((resolve, reject) => {
    const args = ['/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${output}`, ...REFERENCES.map((name) => `/r:${name}`), ...files];
    execFile(CSC, args, { windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${stdout}${stderr}`.trim().split('\n').slice(0, 6).join('\n') || error.message));
      else resolve();
    });
  });
}

/** Path of the built helper (building it if needed), or null when it cannot be built. Safe to call many times. */
function ensure() {
  if (building) return building;
  building = (async () => {
    if (process.env.SSD_NO_NATIVE) return null; // forces the PowerShell helpers (to try the fallback, or to compare)
    if (process.platform !== 'win32' || !fs.existsSync(CSC) || !fs.existsSync(SOURCES)) return null;
    try {
      const exe = path.join(OUT_DIR, `ssd-helper-${hashOfSources()}.exe`);
      if (fs.existsSync(exe)) return exe;

      fs.mkdirSync(OUT_DIR, { recursive: true });
      const started = Date.now();
      const temporary = `${exe}.${process.pid}.tmp`;
      await compile(temporary, sourceFiles());
      fs.renameSync(temporary, exe);
      // older builds are no longer needed (one may still be running: skip what cannot be removed)
      for (const name of fs.readdirSync(OUT_DIR)) {
        const file = path.join(OUT_DIR, name);
        if (/^ssd-helper-.*\.exe$/.test(name) && file !== exe) { try { fs.unlinkSync(file); } catch { /* in use */ } }
      }
      log.info(`[native] built ${path.basename(exe)} in ${Date.now() - started} ms`);
      return exe;
    } catch (err) {
      log.warn(`[native] could not build the native helper, using the PowerShell scripts: ${err.message}`);
      return null;
    }
  })();
  building.then((exe) => { resolved = exe; });
  return building;
}

/** The built helper if ensure() has already finished, else null (never waits). */
const current = () => resolved;

module.exports = { ensure, current };
