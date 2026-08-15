// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="web-ext.d.ts" />

// eslint-disable-next-line import/no-relative-packages
import rootPackageJson from '../../package.json' with { type: 'json' };

import CopyPlugin from 'copy-webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
import { type WebExtRunner, cmd as WebExtCmd } from 'web-ext';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import webpack from 'webpack';
import WatchExternalFilesPlugin from 'webpack-watch-external-files-plugin';
import unocssPostcss from '@unocss/postcss';
// UnoCSS icons are loaded via @unocss/postcss in the PostCSS pipeline

/**
 * Build-time guard against the "stale shared-memory page count" incident:
 * a zafu-wasm re-vendor grew the module's declared initial memory (51 -> 59
 * pages) but loaders kept allocating the old size, so instantiation failed at
 * RUNTIME with "LinkError: memory import has 51 pages which is smaller than
 * the declared initial of 59" and address derivation broke.
 *
 * This makes that class of bug fail the BUILD instead:
 * 1. Parse the wasm's declared `initial` from the vendored glue
 *    (public/zafu-wasm/zafu_wasm.js) - the source of truth.
 * 2. Check ZAFU_WASM_INITIAL_PAGES (src/config/zafu-wasm-memory.ts, the
 *    constant every loader imports) covers it.
 * 3. Sweep src/ for any stray hardcoded `new WebAssembly.Memory({ initial: N`
 *    in files that touch zafu-wasm, so a future loader that bypasses the
 *    shared constant is still caught.
 *
 * Throws (failing dev, prod, and beta builds - they all evaluate this config)
 * if any allocation is smaller than the wasm's declared initial.
 */
const assertZafuWasmMemoryPages = (rootDir: string): void => {
  const gluePath = path.join(rootDir, 'public/zafu-wasm/zafu_wasm.js');
  const glue = readFileSync(gluePath, 'utf8');
  const declaredMatch = /new WebAssembly\.Memory\(\{initial:(\d+)/.exec(glue);
  if (!declaredMatch) {
    throw new Error(
      `zafu-wasm memory check: could not find "new WebAssembly.Memory({initial:N" in ${gluePath}. ` +
        'The glue format changed - update assertZafuWasmMemoryPages in webpack.config.ts.',
    );
  }
  const declared = Number(declaredMatch[1]);

  const constantPath = path.join(rootDir, 'src/config/zafu-wasm-memory.ts');
  const constantSrc = readFileSync(constantPath, 'utf8');
  const constantMatch = /ZAFU_WASM_INITIAL_PAGES\s*=\s*(\d+)/.exec(constantSrc);
  if (!constantMatch) {
    throw new Error(
      `zafu-wasm memory check: could not find ZAFU_WASM_INITIAL_PAGES in ${constantPath}.`,
    );
  }
  const configured = Number(constantMatch[1]);
  if (configured < declared) {
    throw new Error(
      `zafu-wasm memory check FAILED: ${gluePath} declares initial=${declared} pages ` +
        `but ZAFU_WASM_INITIAL_PAGES=${configured} in ${constantPath}. ` +
        `Loaders would throw LinkError at runtime. Bump ZAFU_WASM_INITIAL_PAGES to ${declared}.`,
    );
  }

  // Catch loaders that hardcode a page count instead of importing the constant.
  const srcRoot = path.join(rootDir, 'src');
  for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(entry.parentPath, entry.name);
    const source = readFileSync(filePath, 'utf8');
    if (!source.includes('zafu_wasm') && !source.includes('zafu-wasm')) {
      continue;
    }
    const memoryRe = /new WebAssembly\.Memory\(\s*\{\s*initial:\s*(\d+)/g;
    for (let m = memoryRe.exec(source); m !== null; m = memoryRe.exec(source)) {
      const pages = Number(m[1]);
      if (pages < declared) {
        throw new Error(
          `zafu-wasm memory check FAILED: ${filePath} hardcodes WebAssembly.Memory initial=${pages} ` +
            `but the vendored wasm glue declares initial=${declared}. ` +
            'Use createZafuWasmMemory() from src/config/zafu-wasm-memory.ts instead of hardcoding.',
        );
      }
    }
  }
};

export default ({
  WEBPACK_WATCH = false,
}: {
  ['WEBPACK_WATCH']?: boolean;
} = {}): webpack.Configuration[] => {
  assertZafuWasmMemoryPages(new URL('.', import.meta.url).pathname);

  const gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  const gitDate = execSync('git log -1 --format=%cd --date=short', { encoding: 'utf-8' }).trim();

  const keysPackage = path.dirname(require.resolve('@penumbra-zone/keys'));
  // Resolve wasm package via a known export, then go up to package root
  const wasmPackage = path.dirname(path.dirname(require.resolve('@rotko/penumbra-wasm/build')));

  const localPackages = [
    ...Object.values(rootPackageJson.dependencies),
    ...Object.values(rootPackageJson.devDependencies),

    /* eslint-disable */
    // typescript and eslint will recognize the literal type of local json.
    // this is the simplest way to shut them both up.
    ...Object.values(((rootPackageJson as any).pnpm?.overrides ?? {}) as Record<string, string>),
    /* eslint-enable */
  ]
    .filter(specifier => specifier.endsWith('.tgz'))
    .map(tgzSpecifier =>
      tgzSpecifier.startsWith('file:') ? url.fileURLToPath(tgzSpecifier) : tgzSpecifier,
    );

  const __dirname = new URL('.', import.meta.url).pathname;
  const srcDir = path.join(__dirname, 'src');
  const entryDir = path.join(srcDir, 'entry');
  const injectDir = path.join(srcDir, 'content-scripts');
  const distDir = path.join(__dirname, 'dist');

  const CHROMIUM_PROFILE = process.env['CHROMIUM_PROFILE'];

  /*
   * The DefinePlugin replaces specified tokens with specified values.
   * - These should be declared in `zafu.d.ts` for TypeScript awareness.
   * - `process.env.NODE_ENV` and other env vars are implicitly defined.
   * - Replacement is literal, so the values must be stringified.
   *
   * Note: extension id / origin are NOT injected here. They're resolved at
   * runtime via chrome.runtime.id, so the same build runs correctly under
   * any install method (unpacked, beta Web Store, prod Web Store).
   */
  // Build-time env injection source: process env first, then
  // apps/extension/.env.local (gitignored) so local `webpack` builds match the
  // CI build exactly. Used by the NEAR_1CLICK_JWT define below; the token
  // VALUE lives only in the Actions secret / .env.local, never in the repo.
  const dotEnvLocal: Record<string, string> = (() => {
    try {
      const out: Record<string, string> = {};
      for (const raw of readFileSync(path.join(__dirname, '.env.local'), 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      return out;
    } catch {
      return {};
    }
  })();
  const NEAR_1CLICK_JWT = process.env['NEAR_1CLICK_JWT'] ?? dotEnvLocal['NEAR_1CLICK_JWT'] ?? '';

  const DefinePlugin = new webpack.DefinePlugin({
    'globalThis.__DEV__': JSON.stringify(process.env['NODE_ENV'] !== 'production'),
    'globalThis.__ASSERT_ROOT__': JSON.stringify(false),
    BUILD_COMMIT: JSON.stringify(gitCommit),
    BUILD_DATE: JSON.stringify(gitDate),
    'process.env.NEAR_1CLICK_JWT': JSON.stringify(NEAR_1CLICK_JWT),
    "process.env['NEAR_1CLICK_JWT']": JSON.stringify(NEAR_1CLICK_JWT),
  });

  const WebExtReloadPlugin = {
    webExtRun: undefined as WebExtRunner | undefined,
    apply({ hooks }: webpack.Compiler) {
      hooks.afterEmit.tapPromise(
        { name: 'WebExt Reloader' },
        async ({ options }: webpack.Compilation) => {
          await this.webExtRun?.reloadAllExtensions();
          this.webExtRun ??= await WebExtCmd.run({
            target: 'chromium',
            chromiumProfile: CHROMIUM_PROFILE,
            keepProfileChanges: Boolean(CHROMIUM_PROFILE),
            profileCreateIfMissing: Boolean(CHROMIUM_PROFILE),
            sourceDir: options.output.path,
            startUrl: 'http://localhost:5173/',
          });
          this.webExtRun.registerCleanup(() => (this.webExtRun = undefined));
        },
      );
    },
  };

  /**
   * This custom plugin will run `pnpm install` before each watch-mode build. This
   * combined with WatchExternalFilesPlugin will ensure that tarball dependencies
   * are updated when they change.
   */
  const PnpmInstallPlugin = {
    apply: ({ hooks }: webpack.Compiler) =>
      hooks.watchRun.tapPromise(
        { name: 'CustomPnpmInstallPlugin' },
        compiler =>
          new Promise<void>((resolve, reject) => {
            const pnpmInstall = spawn(
              'pnpm',
              // --ignore-scripts because syncpack doesn't like to run under
              // webpack for some reason. watch out for post-install scripts that
              // dependencies might need.
              ['-w', 'install', '--ignore-scripts', '--offline'],
              { stdio: 'inherit' },
            );
            pnpmInstall.on('exit', code => {
              if (code) {
                reject(new Error(`pnpm install failed ${code}`));
              } else {
                // clear webpack's cache to ensure new deps are used
                compiler.purgeInputFileSystem();
                resolve();
              }
            });
          }),
      ),
  };

  // Shared module rules for TypeScript and JS
  const sharedModuleRules: webpack.RuleSetRule[] = [
    {
      test: /\.tsx?$/,
      use: { loader: 'ts-loader', options: { transpileOnly: true } },
      exclude: /node_modules/,
    },
    {
      test: /\.m?js/,
      resolve: {
        fullySpecified: false,
      },
    },
  ];

  // Shared plugins for both configs
  const sharedPlugins = [
    new webpack.ProvidePlugin({
      // Required by the `bip39` library
      Buffer: ['buffer', 'Buffer'],
      // Inert browser `process` shim so a bare `process` / `process.browser`
      // reference from a dependency in the bundle does not throw
      // "process is not defined" at runtime. Specific `process.env.X` reads are
      // still replaced by DefinePlugin at build time.
      process: path.resolve(__dirname, 'src/stubs/process.cjs'),
    }),
    new webpack.IgnorePlugin({
      // Not required by the `bip39` library, but very nice
      checkResource(resource) {
        return /.*\/wordlists\/(?!english).*\.json/.test(resource);
      },
    }),
    DefinePlugin,
  ];

  const workersDir = path.join(srcDir, 'workers');

  // Browser config for DOM-based entries (pages, popups, offscreen, injected scripts)
  const browserConfig: webpack.Configuration = {
    name: 'browser',
    mode: 'production',
    performance: {
      hints: false, // disable size warnings - WASM crypto libs are big by nature
    },
    entry: {
      'injected-session': path.join(injectDir, 'injected-session.ts'),
      'injected-penumbra-global': path.join(injectDir, 'injected-penumbra-global.ts'),
      'injected-keplr': path.join(injectDir, 'injected-keplr.ts'),
      'keplr-bridge': path.join(injectDir, 'keplr-bridge.ts'),
      'passkey-intercept': path.join(injectDir, 'passkey-intercept.ts'),
      'offscreen-handler': path.join(entryDir, 'offscreen-handler.ts'),
      'page-root': path.join(entryDir, 'page-root.tsx'),
      'popup-root': path.join(entryDir, 'popup-root.tsx'),
      zitadel: path.join(srcDir, 'zitadel', 'main.tsx'),
      // network workers (isolated sync per network)
      'workers/zcash-worker': path.join(workersDir, 'zcash-worker.ts'),
    },
    output: {
      path: distDir,
      filename: '[name].js',
    },
    optimization: {
      splitChunks: {
        chunks: chunk => {
          // workers must be self-contained (no chunk splitting)
          const filesNotToChunk = [
            'injected-session',
            'injected-penumbra-global',
            'injected-keplr',
            'keplr-bridge',
            'passkey-intercept',
            'workers/zcash-worker',
          ];
          return chunk.name ? !filesNotToChunk.includes(chunk.name) : false;
        },
      },
    },
    module: {
      rules: [
        ...sharedModuleRules,
        {
          test: /\.css$/i,
          use: [
            'style-loader',
            'css-loader',
            {
              loader: 'postcss-loader',
              options: {
                postcssOptions: {
                  ident: 'postcss',
                  plugins: [unocssPostcss(), '@tailwindcss/postcss'],
                },
              },
            },
          ],
        },
        {
          test: /\.mp4$/,
          type: 'asset/resource',
          generator: {
            filename: 'videos/[hash][ext][query]',
          },
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js'],
      alias: {
        '@ui': path.resolve(__dirname, '../../packages/ui'),
        // Redirect @penumbra-zone packages to @rotko equivalents (async API)
        '@penumbra-zone/types': '@rotko/penumbra-types',
        '@penumbra-zone/wasm': '@rotko/penumbra-wasm',
        '@penumbra-zone/services': '@rotko/penumbra-services',
        // protobufjs ships an `inquire()` helper that uses eval() to
        // optionally load long.js. MV3 CSP blocks all eval. Stub it.
        '@protobufjs/inquire': path.resolve(__dirname, 'src/stubs/protobufjs-inquire.cjs'),
      },
      fallback: {
        crypto: false, // use webcrypto instead of node crypto
        buffer: require.resolve('buffer/'),
        // @ledgerhq/hw-app-btc -> bip32 -> bs58check -> create-hash requires
        // node's `stream`; polyfill it for the transparent Ledger (Bitcoin-app)
        // signing path. create-hash is the browser hash impl, so it needs stream
        // + buffer only, not node crypto.
        stream: require.resolve('stream-browserify'),
      },
    },
    plugins: [
      new webpack.CleanPlugin(),
      ...sharedPlugins,
      new CopyPlugin({
        patterns: [
          'public',
          {
            from: path.join(keysPackage, 'keys', '*_pk.bin'),
            to: 'keys/[name][ext]',
          },
          {
            from: path.join(wasmPackage, 'wasm-parallel'),
            to: 'wasm-parallel',
          },
          // zcash-wasm: public/zafu-wasm/ serves BOTH the scanning worker and
          // the offscreen prover (one parallel build, one path) — copied via
          // the 'public' pattern above
          // docs: bundled mdBook output
          {
            from: path.resolve(__dirname, '../../docs/book'),
            to: 'docs',
            noErrorOnMissing: true,
          },
        ],
      }),
      // html entry points
      new HtmlWebpackPlugin({
        favicon: 'public/favicon/icon128.png',
        title: 'Zafu Wallet',
        template: 'react-root.html',
        filename: 'page.html',
        chunks: ['page-root'],
      }),
      new HtmlWebpackPlugin({
        title: 'Zafu Wallet',
        template: 'react-root.html',
        rootId: 'popup-root',
        filename: 'popup.html',
        chunks: ['popup-root'],
      }),
      new HtmlWebpackPlugin({
        title: 'Zafu Wallet',
        template: 'react-root.html',
        rootId: 'popup-root',
        filename: 'sidepanel.html',
        chunks: ['popup-root'],
      }),
      new HtmlWebpackPlugin({
        title: 'zitadel',
        template: 'zitadel.html',
        filename: 'zitadel.html',
        chunks: ['zitadel'],
      }),
      new HtmlWebpackPlugin({
        title: 'Zafu Offscreen',
        filename: 'offscreen.html',
        chunks: ['offscreen-handler'],
      }),
      // watch tarballs for changes
      WEBPACK_WATCH && new WatchExternalFilesPlugin({ files: localPackages }),
      WEBPACK_WATCH && PnpmInstallPlugin,
      WEBPACK_WATCH && CHROMIUM_PROFILE && WebExtReloadPlugin,
    ],
    experiments: {
      asyncWebAssembly: true,
    },
  };

  // Worker config for service worker and WASM build worker
  // Uses 'webworker' target to avoid DOM-based chunk loading
  // Depends on 'browser' to ensure it runs after browser config (which cleans the dist)
  const workerConfig: webpack.Configuration = {
    name: 'worker',
    mode: 'production',
    performance: {
      hints: false,
    },
    dependencies: ['browser'],
    target: 'webworker',
    entry: {
      'service-worker': path.join(srcDir, 'service-worker.ts'),
      'wasm-build-parallel': path.join(srcDir, 'wasm-build-parallel.ts'),
      'zcash-build-parallel': path.join(srcDir, 'zcash-build-parallel.ts'),
    },
    output: {
      path: distDir,
      filename: '[name].js',
    },
    optimization: {
      // service workers cannot use importScripts for dynamic chunks
      // everything must be bundled into a single file
      splitChunks: false,
    },
    module: {
      rules: sharedModuleRules,
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js'],
      alias: {
        // Redirect @penumbra-zone packages to @rotko equivalents (async API)
        '@penumbra-zone/types': '@rotko/penumbra-types',
        '@penumbra-zone/wasm': '@rotko/penumbra-wasm',
        '@penumbra-zone/services': '@rotko/penumbra-services',
        '@protobufjs/inquire': path.resolve(__dirname, 'src/stubs/protobufjs-inquire.cjs'),
      },
    },
    plugins: [...sharedPlugins],
    experiments: {
      asyncWebAssembly: true,
    },
  };

  return [browserConfig, workerConfig];
};
