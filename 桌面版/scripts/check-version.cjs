// Version consistency check for the build scripts: package.json,
// src-tauri/tauri.conf.json and src-tauri/Cargo.toml must agree.
// Kept as a standalone file on purpose - batch inline `node -e` code gets
// mangled by cmd.exe parsing (delayed expansion eats ! and ^ characters).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const a = require(path.join(root, 'package.json')).version;
const b = require(path.join(root, 'src-tauri', 'tauri.conf.json')).version;
const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
const m = cargo.match(/^version\s*=\s*"([^"]+)"/m);
const c = m && m[1];
if (a !== b || a !== c) {
  console.error('[FAIL] Version mismatch: package.json=' + a + ' tauri.conf.json=' + b + ' Cargo.toml=' + c);
  process.exit(1);
}
console.log('[OK] Version ' + a);
