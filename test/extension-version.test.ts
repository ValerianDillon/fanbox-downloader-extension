import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  applyExtensionVersion,
  MANIFEST_VERSION_PLACEHOLDER,
  parseChromeExtensionVersion,
} from '../scripts/lib/extension-version';

describe('Chrome 拡張の版番号', () => {
  test('リポジトリの package.json と manifest template から現在の版番号を生成する', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));
    const template = JSON.parse(readFileSync('static/manifest.template.json', 'utf-8'));

    expect(applyExtensionVersion(packageJson, template).version).toBe(packageJson.version);
  });

  test.each(['1', '1.0', '2.10.2', '3.1.2.4567', '65535.0.0.1'])('%s を受け付ける', (version) => {
    expect(parseChromeExtensionVersion(version)).toBe(version);
  });

  test.each([
    null,
    '',
    '0',
    '0.0.0.0',
    '01.0.0',
    '1.2.3.4.5',
    '65536.0.0',
    '2.0.0-beta.1',
  ])('%p を拒否する', (version) => {
    expect(() => parseChromeExtensionVersion(version)).toThrow();
  });

  test('package.json の版番号を template へ反映し、入力は変更しない', () => {
    const packageJson = { name: 'fanbox-downloader-extension', version: '2.0.0' };
    const template = { manifest_version: 3, version: MANIFEST_VERSION_PLACEHOLDER };

    expect(applyExtensionVersion(packageJson, template)).toEqual({
      manifest_version: 3,
      version: '2.0.0',
    });
    expect(template.version).toBe(MANIFEST_VERSION_PLACEHOLDER);
  });

  test('固定版番号が残った template を拒否する', () => {
    expect(() => applyExtensionVersion({ version: '2.0.0' }, { version: '1.0.0' })).toThrow(
      MANIFEST_VERSION_PLACEHOLDER,
    );
  });
});
