// The fetch the SDK calls through. The SDK accepts a `fetch` option, so
// the app can add what every real integration needs - a timeout, and in
// Electron the system proxy settings - and, for this demo, record each
// call for the developer panel. The SDK itself is unchanged.

const SECRET_FIELDS = new Set(['key', 'token', 'instance_id', 'signature', 'portal_token']);
const MAX_LOGGED_BODY = 64 * 1024;

// Keys, activation tokens and portal links stay out of the call log:
// only their last four characters are shown.
export function mask(value) {
  if (typeof value !== 'string' || value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

function maskBody(body) {
  if (Array.isArray(body)) return body.map(maskBody);
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, SECRET_FIELDS.has(k) ? mask(v) : maskBody(v)])
  );
}

// SDKs before 0.5.0 put the license key in export URLs
// (/export-license/:key/offline); kept for anyone running an older one.
function maskUrl(url, secrets) {
  let masked = url;
  for (const secret of secrets) {
    if (secret) masked = masked.split(encodeURIComponent(secret)).join(mask(secret));
  }
  return masked;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * @param {object} options
 * @param {typeof fetch} options.baseFetch - Electron's net.fetch in the app; any fetch in tests
 * @param {number} [options.timeoutMs]
 * @param {(call: object) => void} options.onCall - receives each finished call
 * @param {() => string[]} [options.secrets] - values to mask wherever they appear in a URL
 * @param {() => number} [options.now]
 */
export function createRecordingFetch({ baseFetch, timeoutMs = 5000, onCall, secrets = () => [], now = () => Date.now() }) {
  return async function recordingFetch(url, init = {}) {
    const started = now();
    const request = init.body ? maskBody(parseJson(init.body)) : undefined;
    const call = { method: init.method ?? 'GET', url: maskUrl(String(url), secrets()), request, startedAt: started };
    try {
      const res = await baseFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // Read the body once here, for the log, and hand the SDK a response
      // it can still read.
      const text = await res.text();
      // The log keeps a bounded copy; the SDK still gets the whole response.
      const logged = text.length > MAX_LOGGED_BODY ? `(${text.length} characters, not shown)` : maskBody(parseJson(text));
      onCall({ ...call, status: res.status, response: logged, ms: now() - started });
      return new Response(text, { status: res.status, headers: res.headers });
    } catch (err) {
      onCall({ ...call, error: err.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : err.message, ms: now() - started });
      throw err;
    }
  };
}

/**
 * What an SDK error means for the app. The SDK puts the HTTP status on
 * `err.status` (0.4.0+); a network failure or timeout has none.
 *   refused     - the server answered no (a 4xx other than 429)
 *   unreachable - no usable answer: offline, timed out, rate limited, a
 *                 server error, or a server without the route
 */
export function classifyError(err) {
  const status = err?.status;
  // A 404 ending ": Not Found" is a route the server doesn't have - a
  // server URL missing /v1, or a server older than the SDK needs (SDK
  // 0.5.0's exports need License Server 1.21.0) - not a refused key, which
  // says "License key not found". Treating it as refused would drop a good
  // offline file at launch, and forget a key whose seat is still taken.
  if (status === 404 && /: Not Found$/.test(err?.message ?? '')) return 'unreachable';
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) return 'refused';
  // The SDK's own checks on a response the server sent successfully: the
  // license is for another product. A real answer, not a network problem.
  if (status === undefined && /product_uuid mismatch/.test(err?.message ?? '')) return 'refused';
  return 'unreachable';
}
