/** The Android app's package (android/app/build.gradle, `applicationId`). */
export const ANDROID_PACKAGE = 'io.github.vaibhavmannq.eventide';

/** A SHA-256 certificate fingerprint as keytool prints it: 32 hex bytes separated by colons. */
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * /.well-known/assetlinks.json: the site's half of the link with the Android app. It says the app signed with
 * these keys speaks for this site, so Chrome opens it full screen with no address bar, and invite links open in it.
 * `fingerprints` is a comma-separated list (a second key, if the first is ever replaced). Null when none is set.
 */
export function assetLinks(fingerprints: string | undefined): Response | null {
  const valid = (fingerprints ?? '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter((f) => FINGERPRINT.test(f));
  if (valid.length === 0) return null;
  return Response.json(
    [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: valid },
      },
    ],
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
