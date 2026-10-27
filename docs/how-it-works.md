# How it works

This app is a small, real integration of
[Casazium License Server](https://casazium.com) through its public SDK,
[`@casazium/license-sdk`](https://www.npmjs.com/package/@casazium/license-sdk)
(0.5.0 or later, which needs License Server 1.21.0 or later). Everything
below maps to code you can copy. The parts that only exist so one computer can show what several would are marked
**demo only** - leave them out of a real app.

- [The shape of the app](#the-shape-of-the-app)
- [Activating](#activating)
- [The launch check](#the-launch-check)
- [Offline](#offline)
- [Moving machines](#moving-machines)
- [Usage limits](#usage-limits)
- [Errors: refused or unreachable?](#errors-refused-or-unreachable)
- [Storage](#storage)
- [The public key](#the-public-key)
- [The call log](#the-call-log)
- [Demo only: other machines, and the demo keys](#demo-only-other-machines-and-the-demo-keys)
- [Taking it into your app](#taking-it-into-your-app)

## The shape of the app

| File | Runs in | What it does |
| --- | --- | --- |
| [`main/licensing.js`](../main/licensing.js) | main process | **All of the licensing.** No Electron in it: its storage, machine id and `fetch` are passed in, so it can be read and tested on its own. |
| [`main/calls.js`](../main/calls.js) | main process | The `fetch` the SDK calls through (a timeout, and the call log), and `classifyError`. |
| [`main/main.js`](../main/main.js) | main process | The window and its security settings, and the handlers the page can call. |
| [`main/store.js`](../main/store.js) | main process | Encrypted storage for the license, plain JSON for settings. |
| [`main/machine-id.js`](../main/machine-id.js) | main process | This machine's id, for this app. |
| [`preload/preload.cjs`](../preload/preload.cjs) | preload | The only calls the page can make. |
| [`renderer/`](../renderer) | page | Shows state and sends button presses. Makes no licensing decisions. |

**The licensing runs in the main process, never in the page.** The page is
a web page: anyone can open its developer tools and change what it does.
So it gets no Node, no Electron and no SDK - only a fixed list of calls
(`preload.cjs`), and every handler in `main.js` checks the call came from
the app's own page. The window is sandboxed and isolated, with a strict
Content-Security-Policy, no new windows, and no navigation away. Links
open in the system browser only for a short list of https hosts.

The app holds **no admin API key**. Issuing, listing and revoking licenses
belong on a server you control; the SDK's browser build doesn't even
include those methods.

## Activating

`activate(key)` in `licensing.js`:

1. **`verifyKey(key, productUuid)`** - is this a good license for this
   product? Checked *before* taking a seat, so a revoked key, or a key for
   another product, never uses up a machine.
2. **`activate(key, instanceId)`** - takes one of the license's seats for
   this machine, and returns an **activation token**. The token is returned
   only once, and it's the credential that frees the seat later, so it's
   stored straight away.
3. **`exportOfflineLicense(key)`** - a signed license file, kept for when
   the server can't be reached (see [Offline](#offline)). From SDK 0.5.0
   it sends the key in the request body, not the URL, so proxies on the
   way don't log it.

Two cases worth handling as the app does:

- **`alreadyActivated` with no token.** This machine was activated before,
  but its token is gone - a reinstall, cleared storage. The server won't
  hand out the token again, so the seat has to be freed (the license
  portal can do it) and the machine activated again. The app says so.
- **Storing the token fails** (the keychain refused). The app gives the
  seat back immediately with the token it still has, rather than leave a
  seat nobody can free.

## The launch check

`launchCheck()`, once per start - never on a timer:

```js
const license = await client.verifyKey(key, productUuid); // is the license good?
const { valid } = await client.validate(key, instanceId); // is THIS machine still activated?
```

Both questions matter. `verifyKey` checks only the license, so on its own
it keeps passing after this machine's seat was freed somewhere else - from
the license portal, or by another machine. `validate()` (SDK 0.4.0+) is
what notices.

| Result | Meaning | What the app does |
| --- | --- | --- |
| `ok` | License good, this machine activated | Records the time, refreshes the offline file |
| `seat_freed` | License good, but not activated here | Drops the token and the offline file; offers to activate again |
| `refused` | Revoked, expired, unknown key, or another product's | Drops the offline file, so going offline can't undo it |
| `offline` | No usable answer | The offline file decides |

## Offline

A network failure is not an invalid license: a launch check that fails
closed locks a paying customer out because their train went into a
tunnel. So when the server can't be reached, the app trusts its signed
license file, verified with the server's public key alone:

```js
const ok = await new CasaziumLicenseClient({ publicKey }).verifySignedFile(file, productUuid);
```

`verifySignedFile` checks the signature, that it's a license, the
product, and the expiry. `verifyOffline()` in `licensing.js` adds three
rules of its own, because a file on its own would let a revoked user stay
offline forever:

- **A limit on time offline:** `MAX_DAYS_OFFLINE` (14) since the last good
  online check. The file's own expiry is the license's - a perpetual
  license's file never expires - so it can't be the limit. Choose your
  own number.
- **It must be this key's file.** Any genuine file for the product would
  otherwise pass.
- **The clock mustn't have gone back** since the app last ran. Rolling the
  clock back is the usual way to stretch an expiry, so then the app asks
  for an online check instead. This deters casual tampering; it isn't
  protection against someone who controls the machine.

Every good online check refreshes the file, so its terms follow the
server's. Every refusal deletes it.

The **Act as if offline** switch skips the network, so you can see all
this with Wi-Fi on.

## Moving machines

`deactivate()` frees this machine's seat with its token
(`client.deactivate(key, token)`), and forgets the license. If the server
says the license or activation no longer exists, there's no seat to free,
so the app forgets it anyway. Only a server it can't reach keeps the
license stored, so the seat can still be freed later.

Put this behind a visible "deactivate this computer" control - otherwise
every new laptop means an email to you. The license portal lets your
customers do it themselves too.

## Usage limits

A license can carry numeric limits (here, 5 metered uses). Each use is
counted with the activation token:

```js
await client.trackUsage(key, token, 'api_calls_per_day', 1);
const { metrics } = await client.getUsageReport(key); // used, limit, remaining
```

The server refuses the next use once `remaining` is 0, so that's when the
app shows the limit as reached. Usage is a running count per license: it
doesn't reset by itself.

## Errors: refused or unreachable?

From SDK 0.4.0, an error from a server response carries its HTTP status
on `err.status`; a network failure or a timeout has none. `classifyError`
in `calls.js` turns that into the one question the app cares about:

| | Means |
| --- | --- |
| 404 ending `: Not Found` | **Unreachable**: the server doesn't have that route. |
| any other 4xx, except 429 | **Refused**: the server answered no. Believe it. |
| 429, 5xx, no status | **Unreachable**: no usable answer. Fall back to the offline file. |

A 429 means "slow down", not "no". A 404 whose message ends `: Not Found`
comes from a server URL missing `/v1`, or a server older than the SDK
needs (SDK 0.5.0's exports need License Server 1.21.0); a refused key says
`License key not found`. Treating the first as refused would drop a good
offline file at launch, and forget a key whose seat is still taken. The
SDK's own refusal of a license for another product (`product_uuid
mismatch`) counts as refused too.

The SDK client is built with **one retry** rather than its default three,
and the `fetch` it uses times out after 5 seconds - so a server that
doesn't answer can't hold up the app's start for long.

## Storage

Everything the license decision depends on - the key, the activation
token, the offline file (which contains the key), the pinned public key,
and when the app last checked online - is kept together, **encrypted with
Electron's `safeStorage`** (the system keychain). Editing a file on disk
can't forge a pass, and the key isn't readable on disk. Writes go to a
temporary file and are renamed into place, so a crash never leaves a torn
file.

On Linux without a keychain, `safeStorage` falls back to encrypting with a
fixed password, which protects nothing; the app says so rather than
claiming otherwise. A keychain that refuses is reported as such, not taken
to mean "no license".

Plain JSON holds only settings and the demo server's public `seed.json`.

Licensing actions run one at a time in the main process, and the page
ignores clicks while one is running, so two presses can't interleave.

## The public key

Offline files are verified with the server's public key. **A real app
ships it** and passes it as `builtInPublicKey` (in `main.js`), so the
offline check trusts nothing it downloads. Fetch it once from your server
(`GET /v1/public-key`) while you build the app.

This demo can point at any server, so it fetches the key on first use
and pins it instead - **demo only**. If the server's key later changes, it
says so: offline files signed with the old key stop verifying, and an
unexpected change can mean the app is talking to a different server.

## The call log

The panel on the right lists every request the SDK made: method, path,
what was sent, what came back, and how long it took. The SDK accepts a
`fetch` option, so the app passes one that records each call
(`createRecordingFetch` in `calls.js`) - no change to the SDK. License
keys, activation tokens and instance ids are masked to their last four
characters, wherever they appear, including in URLs.

The same technique is handy for debugging your own integration.

## Demo only: other machines, and the demo keys

**Machines.** A real app activates once, as itself. The Machines panel
uses the same key under other machine ids, so one computer can show what
several would: a second machine taking the other seat, a third refused at
the limit, and this machine's seat being freed from somewhere else - which
the next launch check catches with `validate()`.

**Demo keys.** Pointed at the Casazium demo server, the app reads
`seed.json` from its helper: keys you can't create yourself - revoked,
expired, and a Business-tier one - with license files exported before
they were revoked or expired. They're shared by everyone trying the demo,
so the app only checks them, never activates them:

- **Revoked:** refused online at once, but its file still verifies on its
  own - which is why the offline rules above exist.
- **Expired:** refused online and offline.
- **Business:** a higher tier, read from `verifyKey` - where an app would
  unlock more features.

**Get a demo key** opens a Stripe test-mode checkout. Pay with the test
card `4242 4242 4242 4242` (any future date, any CVC); nothing is charged,
and the key appears on the page after payment. Demo keys last a day and
work on two machines.

## Taking it into your app

1. **Copy `main/licensing.js` and `main/calls.js`.** Delete the sections
   marked DEMO ONLY.
2. **Pass your server's public key** as `builtInPublicKey`, and your
   product's UUID (it's in the response to your first `issue-license`, and
   on the license's page in the console).
3. **Read the server URL from configuration**, so moving between hosted
   and your own server isn't a new release.
4. **Choose your `MAX_DAYS_OFFLINE`.**
5. **Keep the licensing in the main process** and give the page only the
   calls it needs.
6. **For a packaged app**, set Electron's
   [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) (for
   example `RunAsNode` off) when you build it.

Not using Electron? The licensing module only needs `fetch`, somewhere to
store an encrypted record, and a stable machine id - the same steps apply
in any desktop or server app.

**Want the vendor side** - issuing and revoking licenses, connecting your
own Stripe or Lemon Squeezy? Sign up for a
[hosted account](https://casazium.com/pricing): the Free plan is enough,
and you can point this app at it (Server settings: your server URL and
product UUID).

More: [Licensing a JavaScript desktop app](https://casazium.com/guides/javascript-desktop-app)
and the [License Server docs](https://docs.casazium.com/docs/license-server/intro).
