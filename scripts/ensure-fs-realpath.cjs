#!/usr/bin/env node
/**
 * Some environments using Node.js 22 removed the legacy `fs.realpath` module,
 * which old versions of `glob` (pulled in by workbox-build) still require.
 * This script polyfills the module so workbox can run during the build step.
 */
const fs = require('node:fs');
const path = require('node:path');

const moduleDir = path.resolve(__dirname, '..', 'node_modules', 'fs.realpath');
const moduleFile = path.join(moduleDir, 'index.js');
const packageJson = path.join(moduleDir, 'package.json');

if (!fs.existsSync(moduleDir)) {
  fs.mkdirSync(moduleDir, { recursive: true });
}

const source = `const fs = require('node:fs');\n\nmodule.exports = {\n  realpath: fs.realpath,\n  realpathSync: fs.realpathSync,\n  realpathSyncNative: fs.realpathSync.native || fs.realpathSync,\n  realpathNative: fs.realpath.native || fs.realpath\n};\n`;
fs.writeFileSync(moduleFile, source, 'utf8');

if (!fs.existsSync(packageJson)) {
  const pkg = {
    name: 'fs.realpath',
    version: '1.0.0',
    main: 'index.js'
  };
  fs.writeFileSync(packageJson, JSON.stringify(pkg, null, 2), 'utf8');
}
