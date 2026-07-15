#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BRIDGE_HTTP_URL } from '../src/protocol';
import { buildExtension } from './build';
import { ensureBridge } from './bridge-client';

const root = path.resolve(import.meta.dir, '..');
const extensionDirectory = path.join(root, 'dist');
const openBrowser = !Bun.argv.includes('--no-open');
const extensionWasConnected = await extensionIsConnected();

await buildExtension();
if (process.platform === 'darwin') {
  await installLaunchAgent();
  await waitForInstalledBridge();
}
const health = await ensureBridge();
const extensionConnected = health.extensionConnected
  || await waitForExtensionConnection(extensionWasConnected ? 120 : 50);

if (extensionConnected) {
  await fetch(`${BRIDGE_HTTP_URL}/reload`, { method: 'POST' });
  await Bun.sleep(250);
  if (!await waitForExtensionConnection(120)) {
    throw new Error('Browser Gate was reloaded but did not reconnect to the local bridge.');
  }
  console.log('Browser Gate is already installed and has been reloaded.');
} else {
  if (openBrowser) await openChrome(extensionDirectory);
  else printManualInstall(extensionDirectory);
}

async function installLaunchAgent(): Promise<void> {
  const label = 'com.local.browser-gate';
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Could not determine the current macOS user.');
  const domain = `gui/${uid}`;
  const directory = path.join(os.homedir(), 'Library/LaunchAgents');
  const plist = path.join(directory, `${label}.plist`);
  const log = path.join(os.tmpdir(), 'browser-gate.log');
  const bridgePath = path.join(root, 'scripts/bridge.ts');
  const bridgeHasher = new Bun.CryptoHasher('sha256');
  bridgeHasher.update(await Bun.file(bridgePath).arrayBuffer());
  bridgeHasher.update(await Bun.file(path.join(root, 'src/protocol.ts')).arrayBuffer());
  const bridgeHash = bridgeHasher.digest('hex');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(bridgePath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>BROWSER_GATE_BRIDGE_HASH</key><string>${bridgeHash}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`;

  await mkdir(directory, { recursive: true });
  const existing = await readFile(plist, 'utf8').catch(() => '');
  const loaded = Bun.spawnSync(['launchctl', 'print', `${domain}/${label}`]).exitCode === 0;
  if (existing === contents && loaded) {
    console.log('Browser Gate background bridge is already installed.');
    return;
  }
  Bun.spawnSync(['launchctl', 'bootout', `${domain}/${label}`]);
  await writeFile(plist, contents);
  let failure = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = Bun.spawnSync(['launchctl', 'bootstrap', domain, plist]);
    if (result.exitCode === 0) {
      failure = '';
      break;
    }
    failure = result.stderr.toString().trim();
    await Bun.sleep(100);
  }
  if (failure) throw new Error(`Could not install the Browser Gate background bridge: ${failure}`);
  Bun.spawnSync(['launchctl', 'kickstart', '-k', `${domain}/${label}`]);
  console.log('Installed the Browser Gate background bridge.');
}

async function waitForInstalledBridge(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${BRIDGE_HTTP_URL}/health`, { signal: AbortSignal.timeout(200) });
      if (response.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
}

async function waitForExtensionConnection(attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BRIDGE_HTTP_URL}/health`, { signal: AbortSignal.timeout(200) });
      if (response.ok) {
        const status = await response.json() as { extensionConnected?: boolean };
        if (status.extensionConnected) return true;
      }
    } catch {}
    await Bun.sleep(100);
  }
  return false;
}

async function extensionIsConnected(): Promise<boolean> {
  try {
    const response = await fetch(`${BRIDGE_HTTP_URL}/health`, { signal: AbortSignal.timeout(200) });
    if (!response.ok) return false;
    const status = await response.json() as { extensionConnected?: boolean };
    return status.extensionConnected === true;
  } catch {
    return false;
  }
}

async function openChrome(directory: string): Promise<void> {
  if (process.platform === 'darwin') {
    const running = Bun.spawnSync(['pgrep', '-x', 'Google Chrome']).exitCode === 0;
    if (!running) {
      const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const process = Bun.spawn([chrome, `--load-extension=${directory}`], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      process.unref();
      console.log(`Started Chrome with Browser Gate loaded from ${directory}`);
      return;
    }
    Bun.spawnSync(['open', '-a', 'Google Chrome', 'chrome://extensions']);
  }

  printManualInstall(directory);
}

function printManualInstall(directory: string): void {
  console.log(`Chrome is already running, so it cannot accept a new --load-extension flag.`);
  console.log(`In chrome://extensions, enable Developer mode, click Load unpacked, and select:`);
  console.log(directory);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
