import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Build-time constants. Read package.json version + current git short SHA so
// the status bar can show what's actually shipped. Falls back gracefully if
// git isn't available (e.g. building from a tarball).
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
const git = (args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const gitCommit = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
const gitBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
const gitDate = git(['log', '-1', '--format=%cI']);

export default defineConfig(({ command }) => {
  // Demo data (~1MB of fake sessions / chat templates / fake workspace content)
  // ships only in dev (`npm run dev`) and DEMO_BUILD=1 forced-demo artifacts.
  // Regular `vite build` swaps the demoData module for a tiny stub so the
  // production bundle never carries the fake content.
  const includeDemo = command !== 'build' || process.env.DEMO_BUILD === '1';

  return {
    plugins: [react()],
    resolve: {
      // Aliases listed in order — most specific first. The demoData swap uses an
      // array of `{ find, replacement }` entries because plain object aliases
      // require an EXACT id match and the various importers reach demoData via
      // different resolved paths.
      alias: includeDemo
        ? { '@': path.resolve(__dirname, 'src') }
        : [
            // Match relative specifiers like `../lib/demoData` and `./demoData`
            // — that's what every renderer file uses. We deliberately don't
            // match the literal `demoData` alone (could collide with an npm
            // package name) or paths containing `node_modules` (a third-party
            // helper accidentally named demoData.ts won't get swapped).
            {
              find: /^(\.{1,2}\/)+(.*\/)?lib\/demoData(\.ts)?$/,
              replacement: path.resolve(__dirname, 'src/lib/demoData.empty.ts'),
            },
            { find: '@', replacement: path.resolve(__dirname, 'src') },
          ],
    },
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __GIT_COMMIT__: JSON.stringify(gitCommit),
      __GIT_BRANCH__: JSON.stringify(gitBranch),
      __GIT_DATE__: JSON.stringify(gitDate),
      // When DEMO_BUILD=1 is set at build time, the renderer forces demo mode on
      // regardless of the localStorage flag — used to ship a UI-preview build.
      __DEMO_BUILD__: JSON.stringify(process.env.DEMO_BUILD === '1'),
    },
  };
});
