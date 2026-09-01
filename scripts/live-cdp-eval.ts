#!/usr/bin/env bun
/**
 * 実機テストの CDP ターゲット (service worker / page) で任意の JS 式を評価する CLI。
 *
 * scripts/live-browser.ts が公開する CDP endpoint に対し、対象ターゲットの
 * webSocketDebuggerUrl へ直接 WebSocket 接続して Runtime.evaluate を送る。
 * agent-browser が page target を操作している間も service worker target を直接調べられるよう、
 * Playwright への二重接続ではなく生 CDP を使う。詳細は SKILL.md を参照する。
 *
 * 使い方: bun scripts/live-cdp-eval.ts <sw|page> <expression> [--port <n>]
 *   sw   ... type === 'service_worker' のターゲットを対象にする
 *   page ... type === 'page' の先頭のターゲットを対象にする
 *   --port は既定 9222 (live-browser.ts の --port と合わせる)
 *
 * 例: bun scripts/live-cdp-eval.ts sw 'chrome.runtime.onConnect.hasListeners()'
 */
import { type CdpTarget, evaluateOnTarget, fetchTargetList } from './lib/cdp-client';

const DEFAULT_PORT = 9222;

type TargetKind = 'sw' | 'page';

type Options = {
  kind: TargetKind;
  expression: string;
  port: number;
};

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let port = DEFAULT_PORT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = argv[++i];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--port には正の整数を指定してください: ${value}`);
      }
      port = parsed;
      continue;
    }
    positional.push(arg);
  }

  const [kindArg, expression] = positional;
  if (kindArg !== 'sw' && kindArg !== 'page') {
    throw new Error(`第 1 引数は sw か page を指定してください (指定値: ${kindArg ?? '(なし)'})`);
  }
  if (!expression) {
    throw new Error('第 2 引数に評価する JS 式を指定してください');
  }

  return { kind: kindArg, expression, port };
}

function selectTarget(targets: CdpTarget[], kind: TargetKind): CdpTarget {
  const wanted = kind === 'sw' ? 'service_worker' : 'page';
  const target = targets.find((t) => t.type === wanted);
  if (!target) {
    throw new Error(`type === '${wanted}' のターゲットが見つかりません (/json/list に ${targets.length} 件)`);
  }
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`ターゲットに webSocketDebuggerUrl がありません (type: ${target.type})`);
  }
  return target;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targets = await fetchTargetList(options.port);
  const target = selectTarget(targets, options.kind);
  // biome-ignore lint/style/noNonNullAssertion: selectTarget が非 null を保証する
  const result = await evaluateOnTarget(target.webSocketDebuggerUrl!, options.expression);

  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '不明な例外';
    console.error(message);
    process.exit(1);
  }

  console.log(JSON.stringify(result.result?.value ?? null));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
