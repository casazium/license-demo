// The page. It shows state and sends button presses to the main process;
// it makes no licensing decisions itself (window.licensing is the
// preload's bridge, and every call returns { ok, value } or
// { ok: false, error, status }).

const $ = (id) => document.getElementById(id);

function show(el, kind, lines) {
  el.className = `state ${kind}`;
  el.replaceChildren(...lines.filter(Boolean).map((line) => Object.assign(document.createElement('div'), { textContent: line })));
}

function describeLicense(license) {
  if (!license) return null;
  const expires = license.expiresAt ? `expires ${new Date(license.expiresAt).toLocaleString()}` : 'never expires';
  return `${license.tier ?? 'unknown'} tier, ${license.productId ?? 'unknown product'}, ${expires}`;
}

const LAUNCH_TEXT = {
  ok: ['good', 'License good, and this machine is activated.'],
  seat_freed: ['warn', "License good, but this machine's seat was freed elsewhere. Activate again to use it here."],
  refused: ['bad', 'The server refused this license.'],
  no_key: ['muted', 'No license on this machine yet. Paste a key and activate.'],
};

async function refreshStatus() {
  const res = await window.licensing.status();
  if (!res.ok) return show($('license-state'), 'bad', [res.error]);
  const s = res.value;
  $('storage-note').textContent = s.secretsProtected
    ? 'The key and token are stored in the system keychain.'
    : 'No system keychain here: the key and token are stored, but not protected.';
  // The summary lines describe what's stored; the state boxes below them
  // show the result of the last action, and are left alone here.
  $('license-summary').textContent = s.hasKey
    ? `Key ${s.keyHint}, ${s.activated ? 'activated on this machine' : 'not activated here'}.` +
      (s.lastCheckedAt ? ` Last checked with the server ${new Date(s.lastCheckedAt).toLocaleString()}.` : '')
    : LAUNCH_TEXT.no_key[1];
  $('machines-summary').textContent = s.hasKey
    ? `Seats this app knows it's using: ${(s.activated ? 1 : 0) + s.simulatedMachines} of 2` +
      ` (this machine ${s.activated ? 'activated' : 'not activated'}, ${s.simulatedMachines} simulated).`
    : 'Activate a license first.';
  if (s.offlineFile) {
    const expires = s.offlineFile.expiresAt ? `expires ${new Date(s.offlineFile.expiresAt).toLocaleString()}` : 'never expires';
    $('offline-summary').textContent = `A license file is saved (${s.offlineFile.tier} tier, ${expires}).`;
  } else {
    $('offline-summary').textContent = 'No license file saved yet. One is exported when you activate.';
  }
}

async function launchCheck() {
  const res = await window.licensing.launchCheck({ offline: $('offline-switch').checked });
  if (!res.ok) return show($('license-state'), 'bad', [res.error]);
  const r = res.value;
  if (r.state === 'offline') {
    const why = r.forced ? 'Acting as if offline' : `Couldn't reach the server (${r.message})`;
    return show($('license-state'), r.valid ? 'good' : 'bad', [
      `${why}: the license file decides.`,
      r.valid ? 'The file verifies: the app keeps working.' : `The file doesn't verify${r.reason ? ` (${r.reason})` : ''}.`,
      r.clockWentBack ? "This machine's clock has gone backwards since the last check." : null,
    ]);
  }
  const [kind, text] = LAUNCH_TEXT[r.state] ?? ['bad', r.state];
  show($('license-state'), kind, [text, describeLicense(r.license), r.message]);
  $('reactivate').hidden = r.state !== 'seat_freed';
  $('key-warning').hidden = !r.publicKeyChanged;
  await refreshStatus();
}

$('reactivate').addEventListener('click', async () => {
  const res = await window.licensing.reactivate();
  if (!res.ok) return show($('license-state'), 'bad', [res.error]);
  if (res.value.outcome !== 'activated') {
    return show($('license-state'), 'warn', ['This machine is activated, but its token is gone. Free the seat from the license portal, then try again.']);
  }
  $('reactivate').hidden = true;
  show($('license-state'), 'good', ['Activated again.', describeLicense(res.value.license)]);
  await refreshStatus();
});

$('trust-key').addEventListener('click', async () => {
  const res = await window.licensing.trustNewPublicKey();
  if (!res.ok) return show($('license-state'), 'bad', [res.error]);
  $('key-warning').hidden = true;
  show($('offline-state'), 'good', ['Pinned the new key, and exported a fresh license file signed with it.']);
  await refreshStatus();
});

$('simulate-machine').addEventListener('click', async () => {
  const res = await window.licensing.simulateAnotherMachine();
  if (!res.ok) return show($('machines-state'), res.code === 'no_key' ? 'muted' : 'bad', [res.code === 'no_key' ? 'Activate a license first.' : res.error]);
  const r = res.value;
  if (r.outcome === 'activated') show($('machines-state'), 'good', [`Machine ${r.machine} activated: it took a seat.`]);
  else if (r.outcome === 'refused') show($('machines-state'), 'bad', [`Machine ${r.machine} was refused: every seat is taken.`, r.message]);
  else show($('machines-state'), 'warn', [`Machine ${r.machine} is already activated, without a token here.`]);
  await refreshStatus();
});

$('free-simulated').addEventListener('click', async () => {
  const res = await window.licensing.freeSimulatedMachines();
  if (!res.ok) return show($('machines-state'), 'bad', [res.error]);
  show($('machines-state'), 'muted', [`Freed ${res.value.count} simulated machine${res.value.count === 1 ? '' : 's'}.`]);
  await refreshStatus();
});

$('free-this-seat').addEventListener('click', async () => {
  const res = await window.licensing.freeThisSeatElsewhere();
  if (!res.ok) return show($('machines-state'), 'bad', [res.error]);
  if (res.value.outcome === 'not_activated') return show($('machines-state'), 'muted', ['This machine is not activated.']);
  show($('machines-state'), 'warn', [
    "This machine's seat was freed, as the license portal or another machine would.",
    'The key is still stored here. Run the launch check: the license is still good, but validate() says this machine is no longer activated.',
  ]);
  await refreshStatus();
});

$('activate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = $('key-input').value.trim();
  if (!key) return;
  show($('license-state'), 'muted', ['Activating…']);
  const res = await window.licensing.activate(key);
  if (!res.ok && res.status === 429) {
    // The server limits activations and deactivations per key (20 per 15
    // minutes), so a script hammering one key can't fill its seats.
    return show($('license-state'), 'warn', ['Too many activation attempts for this key. Try again in a few minutes.']);
  }
  if (!res.ok) return show($('license-state'), 'bad', [res.error]);
  if (res.value.outcome === 'already_activated_without_token') {
    return show($('license-state'), 'warn', [
      'This machine was activated before, but its activation token is gone (a reinstall?).',
      'Free the seat from the license portal, then activate again.',
    ]);
  }
  $('key-input').value = '';
  show($('license-state'), 'good', ['Activated.', describeLicense(res.value.license)]);
  await refreshStatus();
  await refreshUsage();
});

$('launch-check').addEventListener('click', launchCheck);

$('deactivate').addEventListener('click', async () => {
  const res = await window.licensing.deactivate();
  if (!res.ok) return show($('license-state'), 'bad', [res.error]);
  show($('license-state'), 'muted', ["Deactivated: this machine's seat is free, and the key can be activated elsewhere."]);
  await refreshStatus();
});

$('verify-offline').addEventListener('click', async () => {
  const res = await window.licensing.verifyOffline();
  if (!res.ok) return show($('offline-state'), 'bad', [res.error]);
  const r = res.value;
  show($('offline-state'), r.valid ? 'good' : 'bad', [
    r.valid ? 'Verified offline: signature, product and expiry all check out.' : `Doesn't verify${r.reason ? ` (${r.reason})` : ''}.`,
    'Checked against the public key alone - no network call.',
    r.clockWentBack ? "This machine's clock has gone backwards since the last check." : null,
  ]);
});

$('export-offline').addEventListener('click', async () => {
  const res = await window.licensing.exportOffline();
  if (!res.ok) return show($('offline-state'), 'bad', [res.error]);
  await refreshStatus();
});

async function refreshUsage() {
  const res = await window.licensing.usage();
  if (!res.ok) return show($('usage-state'), res.code === 'no_key' ? 'muted' : 'bad', [res.code === 'no_key' ? 'Activate a license first.' : res.error]);
  const metric = (res.value.metrics ?? []).find((m) => m.metric === 'api_calls_per_day');
  if (!metric) return show($('usage-state'), 'muted', ['This license has no usage limit.']);
  show($('usage-state'), metric.exceeded ? 'bad' : 'muted', [`${metric.used} of ${metric.limit} used with this key.`]);
}

$('use-once').addEventListener('click', async () => {
  const res = await window.licensing.trackUsage();
  if (!res.ok) {
    await refreshUsage();
    return show($('usage-state'), 'bad', [res.error]);
  }
  await refreshUsage();
});
$('refresh-usage').addEventListener('click', refreshUsage);

async function loadSettings() {
  const res = await window.app.getSettings();
  if (!res.ok) return;
  $('server-url').value = res.value.serverUrl;
  $('product-uuid').value = res.value.productUuid;
  $('helper-url').value = res.value.helperUrl ?? '';
}

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const res = await window.app.saveSettings({
    serverUrl: $('server-url').value,
    productUuid: $('product-uuid').value,
    helperUrl: $('helper-url').value,
  });
  $('settings-note').textContent = res.ok ? 'Saved.' : res.error;
  await refreshStatus();
  if (res.ok) await refreshSeed({ reload: true });
});

// --- Demo keys (the demo server's seed.json) ---------------------------

const DEMO_KINDS = ['revoked', 'expired', 'business'];

async function refreshSeed({ reload = false } = {}) {
  const res = reload ? await window.demo.loadSeed() : await window.demo.seed();
  const seed = res.ok ? (reload ? (res.value.loaded ? res.value : null) : res.value) : null;
  const ready = Boolean(seed?.matchesSettings);
  for (const kind of DEMO_KINDS) $(`try-${kind}`).disabled = !ready || !seed.kinds.includes(kind);
  $('get-key').hidden = !(ready && seed.getKeyUrl);
  $('apply-seed').hidden = !seed || ready;
  if (!res.ok) return show($('demo-state'), 'bad', [`Couldn't load seed.json: ${res.error}`]);
  if (!seed) {
    $('demo-summary').textContent = 'Set the demo helper URL in Server settings to load the demo keys.';
    return;
  }
  $('demo-summary').textContent = ready
    ? `Demo keys from ${new Date(seed.generatedAt).toLocaleString()}.`
    : `The demo helper's keys are for ${seed.serverUrl}, not the server set here.`;
  if (ready) {
    const match = await window.demo.keyMatchesServer();
    if (match.ok && match.value === false) {
      show($('demo-state'), 'warn', [
        "The server's public key doesn't match the one the demo helper publishes.",
        'This app may be talking to a different server than the demo.',
      ]);
    }
  }
}

function describeTry(r) {
  const online = {
    ok: `Online: verifyKey says valid, ${describeLicense(r.online.license)}.`,
    refused: `Online: refused (${r.online.status}) - ${r.online.message}`,
    unreachable: `Online: no answer (${r.online.message}).`,
  }[r.online.state];
  const offline = r.offline
    ? r.offline.valid
      ? 'Offline: its license file still verifies, with the public key alone.'
      : 'Offline: its license file is refused.'
    : null;
  const kind = r.online.state === 'ok' && (!r.offline || r.offline.valid) ? 'good' : r.offline?.valid ? 'warn' : 'bad';
  return [kind, [`The ${r.kind} key (${r.keyHint}).`, online, offline]];
}

const TRY_NOTES = {
  revoked: "Revoked keys are refused online at once, but a file exported before the revocation keeps verifying offline until it expires. If that matters, issue short-lived files and have the app check online now and then.",
  expired: 'Expiry is checked on both sides: by the server, and by the file against this machine\'s clock.',
  business: 'A higher tier, read from verifyKey: this is where an app would unlock its Business features.',
};

for (const kind of DEMO_KINDS) {
  $(`try-${kind}`).addEventListener('click', async () => {
    const res = await window.demo.tryKey(kind);
    if (!res.ok) return show($('demo-state'), 'bad', [res.error]);
    const [state, lines] = describeTry(res.value);
    show($('demo-state'), state, [...lines, TRY_NOTES[kind]]);
  });
}

$('apply-seed').addEventListener('click', async () => {
  const res = await window.demo.applySeed();
  if (!res.ok) return show($('demo-state'), 'bad', [res.error]);
  await loadSettings();
  await refreshStatus();
  await refreshSeed();
  show($('demo-state'), 'good', ['Using the demo server. Get a demo key, or try the keys below.']);
});

$('get-key').addEventListener('click', async () => {
  const res = await window.demo.getKey();
  if (!res.ok) return show($('demo-state'), 'bad', [res.error]);
  show($('demo-state'), 'muted', [
    'The test checkout opened in your browser. Pay with the test card 4242 4242 4242 4242 (any future date, any CVC).',
    'Your key appears on the page after payment: paste it into License above.',
  ]);
});

function addCall(call) {
  const item = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'call-head';
  const path = (() => {
    try {
      return new URL(call.url).pathname.replace(/^\/v1/, '');
    } catch {
      return call.url;
    }
  })();
  head.textContent = `${call.method} ${path}  ${call.status ?? 'failed'}  ${call.ms} ms`;
  item.className = call.status && call.status < 400 ? 'ok' : 'err';
  const body = document.createElement('pre');
  body.textContent = JSON.stringify({ request: call.request, response: call.response, error: call.error }, null, 2);
  item.append(head, body);
  $('call-list').prepend(item);
}

$('clear-calls').addEventListener('click', async () => {
  await window.app.clearCalls();
  $('call-list').replaceChildren();
});

window.app.onCall(addCall);

(async () => {
  await loadSettings();
  await refreshSeed({ reload: true });
  const existing = await window.app.calls();
  if (existing.ok) existing.value.forEach(addCall);
  await refreshStatus();
  // The launch check: once, at start.
  if ((await window.licensing.status()).value?.hasKey) {
    await launchCheck();
    await refreshUsage();
  }
  // Start-up is done (the form now holds the saved settings): the smoke
  // test waits for this before typing.
  document.body.dataset.ready = 'true';
})();
