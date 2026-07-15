#!/usr/bin/env bun
import { copyFile, mkdir, watch } from 'node:fs/promises';
import path from 'node:path';

import { BRIDGE_HTTP_URL } from '../src/protocol';

const root = path.resolve(import.meta.dir, '..');
const sourceDirectory = path.join(root, 'src');
const outputDirectory = path.join(root, 'dist');
const watchMode = Bun.argv.includes('--watch');

export async function buildExtension(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints: [path.join(sourceDirectory, 'background.ts')],
    outdir: outputDirectory,
    target: 'browser',
    format: 'esm',
    naming: 'background.js',
    sourcemap: 'external',
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('Extension build failed.');
  }
  await copyFile(path.join(sourceDirectory, 'manifest.json'), path.join(outputDirectory, 'manifest.json'));
  console.log(`Built Browser Gate in ${outputDirectory}`);
}

async function reloadExtension(): Promise<void> {
  try {
    await fetch(`${BRIDGE_HTTP_URL}/reload`, { method: 'POST', signal: AbortSignal.timeout(500) });
  } catch {}
}

async function main(): Promise<void> {
  await buildExtension();
  if (!watchMode) return;

  console.log('Watching src for changes...');
  let pending: ReturnType<typeof setTimeout> | undefined;
  for await (const event of watch(sourceDirectory, { recursive: true })) {
    if (!event.filename) continue;
    clearTimeout(pending);
    pending = setTimeout(async () => {
      try {
        await buildExtension();
        await reloadExtension();
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }, 75);
  }
}

if (import.meta.main) await main();
