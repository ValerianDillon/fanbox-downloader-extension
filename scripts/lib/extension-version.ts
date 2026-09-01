export const MANIFEST_VERSION_PLACEHOLDER = '__PACKAGE_VERSION__';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Chrome manifest の更新比較に使える 1〜4 個の整数だけを受け付ける。 */
export function parseChromeExtensionVersion(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('package.json の version は文字列である必要があります');
  }

  const parts = value.split('.');
  const validParts =
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65_535);
  if (!validParts || parts.every((part) => part === '0')) {
    throw new Error(`package.json の version は Chrome 拡張で使える 1〜4 個の整数にしてください: ${value}`);
  }
  return value;
}

/** package.json を唯一の版番号 SoT として manifest template へ反映する。 */
export function applyExtensionVersion(packageJson: unknown, manifestTemplate: unknown): Record<string, unknown> {
  if (!isRecord(packageJson)) {
    throw new Error('package.json のルートはオブジェクトである必要があります');
  }
  if (!isRecord(manifestTemplate)) {
    throw new Error('manifest template のルートはオブジェクトである必要があります');
  }
  if (manifestTemplate.version !== MANIFEST_VERSION_PLACEHOLDER) {
    throw new Error(`manifest template の version は ${MANIFEST_VERSION_PLACEHOLDER} である必要があります`);
  }

  return {
    ...manifestTemplate,
    version: parseChromeExtensionVersion(packageJson.version),
  };
}
