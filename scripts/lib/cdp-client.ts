/**
 * scripts/live-cdp-eval.ts と scripts/live-pull-zip.ts が共有する、最小限の CDP クライアント。
 *
 * agent-browser が page target を操作している間も service worker target を直接調べられるよう、
 * 両スクリプトとも webSocketDebuggerUrl に生の WebSocket で直接つなぎ Runtime.evaluate を送る。
 */

export type CdpTarget = {
  type: string;
  webSocketDebuggerUrl?: string;
  url?: string;
};

export async function fetchTargetList(port: number): Promise<CdpTarget[]> {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  let response: Response;
  try {
    response = await fetch(endpoint);
  } catch (cause) {
    throw new Error(
      `CDP (${endpoint}) に接続できません。live-browser.ts が起動しているか、--port が合っているか確認してください。` +
        ` (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  if (!response.ok) {
    throw new Error(`CDP (${endpoint}) が異常応答を返しました: HTTP ${response.status}`);
  }
  return (await response.json()) as CdpTarget[];
}

export type RuntimeEvaluateResult = {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

/**
 * webSocketDebuggerUrl に接続し Runtime.evaluate を送って結果を得る。
 * CDP は Runtime.evaluate の応答より先にイベント通知 (id を持たないメッセージ) を
 * 送ってくることがあるため、応答は id の一致で待つ (通知を早合点して結果と取り違えない)。
 */
export async function evaluateOnTarget(
  wsUrl: string,
  expression: string,
  timeoutMs = 10_000,
): Promise<RuntimeEvaluateResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const requestId = 1;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP の応答がタイムアウトしました (${timeoutMs / 1000} 秒)`));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: requestId,
          method: 'Runtime.evaluate',
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    });

    ws.addEventListener('message', (event) => {
      let message: { id?: number; result?: RuntimeEvaluateResult; error?: { message?: string } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== requestId) return; // 応答以外の通知は無視する
      clearTimeout(timeout);
      ws.close();
      if (message.error) {
        reject(new Error(`CDP エラー: ${message.error.message ?? JSON.stringify(message.error)}`));
        return;
      }
      resolve(message.result ?? {});
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket 接続に失敗しました: ${wsUrl}`));
    });
  });
}
