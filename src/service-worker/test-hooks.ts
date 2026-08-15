import type { MediaStreamDeps, MediaStreamPort } from './media-stream';

/**
 * テストビルド (`__FBDL_TEST__`) 専用の service worker 側の観測フック (Issue #22)。
 *
 * content script 側 (src/content/test-hooks.ts) と同様に、通常ビルドでは dead code elimination で
 * 消えることを scripts/build.ts の post-build 検証 (`__FBDL_TEST__` / `__fbdlTest` の残留チェック) で
 * 保証する。ガード節は content 側と同じ理由 (別変数を経由すると定数畳み込みが伝播しない) で
 * `typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__` を各関数に直接書く。
 *
 * smoke test (e2e/) は Playwright の Worker.evaluate で service worker のグローバル
 * `globalThis.__fbdlTestState` を直接読み、「キャンセル後に fetch とバッファが残っていないこと」を
 * service worker 側から検証する。
 */

/** service worker のグローバルに置く観測状態 (テストビルドのみ) */
export type MediaStreamTestState = {
  /** 現在 streamMedia が進行中の Port の数 (head 送信前〜終端送信/切断まで) */
  activeStreams: number;
  /** content script 側の切断 (キャンセル等) により終端前に打ち切ったストリーム数 */
  disconnectedStreams: number;
  /** 終端 (end / error / ok:false の head) まで送り切ったストリーム数 */
  finishedStreams: number;
  /** 送った chunk メッセージの総数 */
  chunkMessages: number;
  /** `fbdl-test-drop-after` による切断シミュレーションを既に実行した URL (URL ごとに 1 回だけ切る) */
  droppedUrls: string[];
};

/** globalThis の型付きビュー (declare global で var を増やさずに済ませる) */
type TestGlobal = { __fbdlTestState?: MediaStreamTestState };

/**
 * URL のクエリ `fbdl-test-drop-after=<bytes>` を読む。指定があれば、そのバイト数以上を送った直後に
 * service worker 側から Port を切断し、「転送中に service worker が停止した」状況を再現する
 * (content script 側 の Range 再開の smoke test 用)。切断は URL ごとに 1 回だけ行う (再開後の Port でも
 * 毎回切ると、Range を無視するサーバでは先頭からのやり直しが無限に続き MAX_RESUMES で失敗してしまう。
 * 再現したいのは「1 度切れても完全なファイルになる」ことなので 1 回で足りる)。通常ビルドでは常に null。
 */
export function testDropAfterBytes(url: string): number | null {
  if (typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__) {
    try {
      const raw = new URL(url).searchParams.get('fbdl-test-drop-after');
      if (raw !== null && /^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    } catch {
      // URL として解釈できないものは対象外
    }
  }
  return null;
}

/**
 * streamMedia に渡す deps を、観測状態の更新と切断シミュレーションでラップする。
 * 通常ビルドでは deps をそのまま返す (恒等)。
 */
export function wrapMediaStreamDepsForTest(
  port: MediaStreamPort & { disconnect(): void },
  url: string,
  deps: MediaStreamDeps,
): MediaStreamDeps {
  if (typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__) {
    const state = ensureTestState();
    const dropAfter = testDropAfterBytes(url);
    return {
      ...deps,
      onChunkSent: (info) => {
        state.chunkMessages++;
        deps.onChunkSent?.(info);
        if (dropAfter !== null && !state.droppedUrls.includes(url) && info.sentBytes >= dropAfter) {
          state.droppedUrls.push(url);
          // 実際の service worker 停止と同じく、content script 側には onDisconnect だけが届く。
          // 切断は chunk の postMessage より後に行う必要がある (postMessage は onChunkSent の後) ので、
          // マイクロタスクに遅らせる
          queueMicrotask(() => port.disconnect());
        }
      },
    };
  }
  return deps;
}

/** ストリームの開始/終了を観測状態に反映する。通常ビルドでは no-op */
export function trackMediaStreamForTest(port: MediaStreamPort, run: () => Promise<void>): Promise<void> {
  if (typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__) {
    const state = ensureTestState();
    state.activeStreams++;
    let disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
    });
    return run().finally(() => {
      state.activeStreams--;
      if (disconnected) state.disconnectedStreams++;
      else state.finishedStreams++;
    });
  }
  return run();
}

function ensureTestState(): MediaStreamTestState {
  const g = globalThis as unknown as TestGlobal;
  g.__fbdlTestState ??= {
    activeStreams: 0,
    disconnectedStreams: 0,
    finishedStreams: 0,
    chunkMessages: 0,
    droppedUrls: [],
  };
  return g.__fbdlTestState;
}
