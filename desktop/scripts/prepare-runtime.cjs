'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const desktop = path.resolve(__dirname, '..');
const project = path.dirname(desktop);
const staging = path.join(desktop, 'staging');
// Only explicit runtime roots are copied. Git ownership is additionally checked.
const allow = {
  server: ['package.json', 'package-lock.json', 'config.local.example.js', 'channels.js', 'config.js', 'paths.js', 'index.js', 'logger.js', 'music.js', 'netease.js', 'persistence.js', 'player.js', 'playback-loop.js', 'playlist-input.js', 'qq.js', 'routes.js', 'scheduler.js', 'state.js', 'users.js'],
  QQMusicApi: ['package.json', 'package-lock.json', 'LICENSE', 'app.js', 'paths.js', 'bin/config.js', 'bin/www', 'routes', 'util', 'public', 'views'],
  'netease-api': ['package.json', 'package-lock.json']
};
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: project, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
const manifest = [];
function copy(source, destination, relative, managed = true) {
  if (!fs.existsSync(source)) throw new Error('Missing runtime input: ' + relative);
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Symbolic links are not runtime inputs: ' + relative);
  if (fs.statSync(source).isDirectory()) {
    for (const entry of fs.readdirSync(source)) copy(path.join(source, entry), path.join(destination, entry), relative + '/' + entry, managed);
  } else {
    if (managed && !tracked.has(relative)) {
      // New lifecycle modules are allowed before their first commit, but only at explicit roots.
        if (!['server/paths.js', 'server/playback-loop.js', 'server/playlist-input.js', 'QQMusicApi/paths.js', 'QQMusicApi/package-lock.json', 'QQMusicApi/util/cookieRenewal.js'].includes(relative)) throw new Error('Unmanaged runtime input: ' + relative);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    manifest.push({ path: path.relative(staging, destination).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') });
  }
}
// The target is a fixed child of desktop; never use a caller-supplied removal path.
if (path.dirname(staging) !== desktop) throw new Error('Invalid staging target');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
for (const [service, files] of Object.entries(allow)) {
  const target = path.join(staging, 'runtime', service);
  for (const file of files) copy(path.join(project, service, file), path.join(target, file), service + '/' + file);
  // Invoke npm CLI through the same Node executable; never install in the source service.
  const npmCLI = process.env.npm_execpath;
  if (!npmCLI || !fs.existsSync(npmCLI)) throw new Error('Run this script with npm run prepare-runtime so npm CLI is available');
  execFileSync(process.execPath, [npmCLI, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' });
}
copy(path.join(project, 'web', 'dist'), path.join(staging, 'runtime', 'web', 'dist'), 'web/dist', false);
for (const file of ['mpv.exe', 'mpv.com', 'd3dcompiler_43.dll', 'mpv/fonts.conf']) {
  const source = path.join(desktop, 'vendor', 'mpv', file);
  if (fs.existsSync(source)) copy(source, path.join(staging, 'mpv', file), 'mpv/' + file, false);
}
if (!fs.existsSync(path.join(staging, 'mpv', 'mpv.exe'))) throw new Error('Verified mpv.exe is required');
const licenseRoot = path.join(staging, 'licenses'); fs.mkdirSync(licenseRoot, { recursive: true });
copy(path.join(project, 'QQMusicApi', 'LICENSE'), path.join(licenseRoot, 'QQMusicApi-LICENSE'), 'QQMusicApi/LICENSE');
for (const name of fs.readdirSync(path.join(desktop, 'vendor', 'mpv'))) {
  if (/^(manifest.*\.json|.*licenses?.*|copying.*|copyright.*|.*source.*)$/i.test(name)) copy(path.join(desktop, 'vendor', 'mpv', name), path.join(licenseRoot, 'mpv', name), 'mpv/' + name, false);
}
function audit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.name === 'node_modules') continue; // Dependencies retain required package-owned fixtures/resources.
    if (/^(config\.local\.js|state\.json|presets\.json|schedules\.json|channels\.json|cookie\.json|allCookies\.json|\.env.*|\.git|.*\.log|AGENTS\.md)$/i.test(entry.name)) throw new Error('Forbidden private artifact: ' + target);
    if (entry.isDirectory()) audit(target);
  }
}
audit(staging);
fs.writeFileSync(path.join(staging, 'resource-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Clean runtime staging prepared.');
