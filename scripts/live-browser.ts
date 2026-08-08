#!/usr/bin/env bun
/**
 * 実 FANBOX (https://www.fanbox.cc/) を相手に、coding agent が拡張の実機テストを行うための
 * ランチャー。Playwright 管理の Chromium (channel: 'chromium') に dist/ の拡張を読み込んだ
 * 永続コンテキストを起動し、CDP (Chrome DevTools Protocol) を外部にポート公開する。
 * これを `chrome-devtools-mcp` (--browser-url) から操作する。
 *
 * branded Chrome は --load-extension が廃止されているため使わない
 * (e2e/smoke.spec.ts と同じく Playwright 管理の Chromium を使う)。
 *
 * 使い方: bun scripts/live-browser.ts [--headed] [--port <n>] [--profile <dir>]
 *
 * 詳細な運用手順は .claude/skills/extension-live-test/SKILL.md を参照。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE_DIR = path.join(homedir(), '.local/share/fanbox-downloader-extension/live-profile');
const START_URL = 'https://www.fanbox.cc/';

type Options = {
  headed: boolean;
  port: number;
  profileDir: string;
};

function parseArgs(argv: string[]): Options {
  let headed = false;
  let port = DEFAULT_PORT;
  let profileDir = DEFAULT_PROFILE_DIR;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--headed':
        headed = true;
        break;
      case '--port': {
        const value = argv[++i];
        const parsed = Number(value);
        if (!value || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--port には正の整数を指定してください: ${value}`);
        }
        port = parsed;
        break;
      }
      case '--profile': {
        const value = argv[++i];
        if (!value) {
          throw new Error('--profile にはディレクトリパスを指定してください');
        }
        profileDir = path.resolve(value);
        break;
      }
      default:
        throw new Error(`不明な引数です: ${arg}`);
    }
  }

  return { headed, port, profileDir };
}

/**
 * WSLg の DISPLAY / WAYLAND_DISPLAY を引き継いだまま headless Chromium を起動すると、
 * 最初の requestAnimationFrame の配送が 60〜100 秒止まる (e2e/smoke.spec.ts の browserEnv()
 * と同じ既知の問題、詳細は CLAUDE.md 参照)。headless 時のみ取り除く。headed 時は WSLg の
 * ウィンドウ表示に必要なため引き継ぐ。
 */
function launchEnv(headed: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!headed && (key === 'DISPLAY' || key === 'WAYLAND_DISPLAY')) continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const extensionPath = path.resolve('dist');
  if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
    console.error(
      `dist/ が見つかりません (${extensionPath})。先に \`bun run build\` を実行してください。` +
        ' (このスクリプトは自動ビルドしません)',
    );
    process.exit(1);
  }

  mkdirSync(options.profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(options.profileDir, {
    channel: 'chromium',
    headless: !options.headed,
    env: launchEnv(options.headed),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--remote-debugging-port=${options.port}`,
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(START_URL);

  const cdpEndpoint = `http://127.0.0.1:${options.port}`;
  console.log('fanbox-downloader-extension live browser を起動しました。');
  console.log(`  CDP endpoint : ${cdpEndpoint}`);
  console.log(`  profile dir  : ${options.profileDir}`);
  console.log(`  mode         : ${options.headed ? 'headed' : 'headless'}`);
  console.log(`  extension    : ${extensionPath}`);
  console.log('');
  console.log('chrome-devtools MCP から操作する場合は、次のコマンドで登録してください:');
  console.log(
    `  claude mcp add --scope local chrome-devtools -- npx chrome-devtools-mcp@latest --browser-url=${cdpEndpoint}`,
  );
  console.log('');
  console.log('終了するには Ctrl+C (SIGINT) を送るか、このプロセスを SIGTERM で止めてください。');

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  console.log('終了処理中...');
  await context.close();
  console.log('終了しました。');
}

await main();
