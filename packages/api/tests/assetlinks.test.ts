import { describe, expect, it } from 'vitest';
import { ANDROID_PACKAGE, assetLinks } from '../src/assetlinks.ts';

const KEY = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');

describe('the Android asset links', () => {
  it('names the app and its signing key, in the shape Android checks', async () => {
    const response = assetLinks(` ${KEY.toLowerCase()} `);
    expect(response?.headers.get('Content-Type')).toContain('application/json');
    expect(await response?.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: [KEY] },
      },
    ]);
  });

  it('is absent until a fingerprint is set, and ignores anything that is not one', () => {
    expect(assetLinks(undefined)).toBeNull();
    expect(assetLinks('')).toBeNull();
    expect(assetLinks('not-a-fingerprint')).toBeNull();
  });
});
