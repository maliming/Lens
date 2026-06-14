// Generate macOS .icns + standalone .png + .ico from build/icon.svg
// Run: node build/build-icon.mjs
//
// Dependencies: sharp (npm i -D sharp)
// Uses macOS built-in `iconutil` for .icns generation.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BUILD = path.join(ROOT, 'build');
const SVG = path.join(BUILD, 'icon.svg');
const TRAY_SVG = path.join(BUILD, 'tray-icon.svg');
const TRAY_PNG_1X = path.join(BUILD, 'trayTemplate.png');     // 18x18
const TRAY_PNG_2X = path.join(BUILD, 'trayTemplate@2x.png');  // 36x36
const ICONSET = path.join(BUILD, 'icon.iconset');
const ICNS = path.join(BUILD, 'icon.icns');
const PNG = path.join(BUILD, 'icon.png');
const ICO = path.join(BUILD, 'icon.ico');

const FILES = {
  16:   ['icon_16x16.png'],
  32:   ['icon_16x16@2x.png', 'icon_32x32.png'],
  64:   ['icon_32x32@2x.png'],
  128:  ['icon_128x128.png'],
  256:  ['icon_128x128@2x.png', 'icon_256x256.png'],
  512:  ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png'],
};

async function main() {
  await fs.rm(ICONSET, { recursive: true, force: true });
  await fs.mkdir(ICONSET, { recursive: true });
  const svg = await fs.readFile(SVG);

  console.log('▸ Rendering PNG sizes from SVG…');
  for (const [size, names] of Object.entries(FILES)) {
    const buf = await sharp(svg, { density: 384 }).resize(Number(size), Number(size)).png().toBuffer();
    for (const name of names) {
      await fs.writeFile(path.join(ICONSET, name), buf);
      console.log(`   ${name} (${size}px)`);
    }
  }

  console.log('\n▸ Standalone PNG (build/icon.png)…');
  await fs.copyFile(path.join(ICONSET, 'icon_512x512.png'), PNG);

  console.log('\n▸ Building .icns via iconutil…');
  try {
    await exec('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS]);
    console.log('   ✓ build/icon.icns');
  } catch (e) {
    console.error('   ✗ iconutil failed (macOS only):', e.message);
  }

  // Windows .ico: combine 16/32/48/64/128/256 with sharp
  console.log('\n▸ Building .ico (Windows)…');
  try {
    const sizes = [16, 32, 48, 64, 128, 256];
    const pngs = await Promise.all(
      sizes.map(s => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer())
    );
    // sharp doesn't natively support .ico. Try png-to-ico if present, else skip.
    try {
      const pti = await import('png-to-ico').then(m => m.default || m);
      const ico = await pti(pngs);
      await fs.writeFile(ICO, ico);
      console.log('   ✓ build/icon.ico');
    } catch {
      console.log('   ⚠ Skipped (run `npm i -D png-to-ico` if you need .ico for Windows)');
    }
  } catch (e) {
    console.error('   ✗ ico build failed:', e.message);
  }

  // macOS menu-bar template PNGs. Black-on-alpha; system auto-inverts in dark menu bars.
  // Standard menu-bar height is 18pt → 18x18 base + 36x36 @2x for Retina.
  console.log('\n▸ Tray template PNGs (build/trayTemplate.png + @2x)…');
  try {
    const traySvg = await fs.readFile(TRAY_SVG);
    await sharp(traySvg, { density: 512 }).resize(18, 18).png().toFile(TRAY_PNG_1X);
    await sharp(traySvg, { density: 512 }).resize(36, 36).png().toFile(TRAY_PNG_2X);
    console.log('   ✓ build/trayTemplate.png + @2x.png');
  } catch (e) {
    console.error('   ✗ tray icon render failed:', e.message);
  }

  console.log('\n▸ Cleaning up iconset…');
  await fs.rm(ICONSET, { recursive: true, force: true });
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
