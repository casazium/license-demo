// This machine's id for this app. The SDK's getFingerprint() is the same
// for every app on the machine; an HMAC keyed by the product's UUID gives
// an id that is stable for this app but doesn't identify the machine
// across products. The server treats instance ids as opaque labels.
import crypto from 'node:crypto';
import { getFingerprint } from '@casazium/license-sdk/fingerprint';

export function appInstanceId(productUuid, fingerprint = getFingerprint()) {
  return crypto.createHmac('sha256', productUuid || 'license-demo').update(fingerprint).digest('hex').slice(0, 32);
}
