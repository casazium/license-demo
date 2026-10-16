# Casazium License demo

A small Electron app that uses [Casazium License Server](https://casazium.com)
the way your desktop app would, through the public SDK
([`@casazium/license-sdk`](https://www.npmjs.com/package/@casazium/license-sdk)).
Every call it makes is listed in the app, next to the result.

It shows the four moments from the guide
[Licensing a JavaScript desktop app](https://casazium.com/guides/javascript-desktop-app):

- **Activate** once per machine, and keep the activation token.
- **The launch check**, once per start: is the license good, and is
  *this* machine still activated on it?
- **Offline**: a signed license file, verified with the server's public
  key alone, when the server can't be reached.
- **Moving machines**: deactivate to free the seat.

Plus a **usage limit**, counted per key, and a **Machines** panel that
acts as other computers would: a second machine taking the other seat,
a third refused at the limit, and this machine's seat freed from
somewhere else - which the launch check catches with `validate()`.

Pointed at the Casazium demo server, a **Demo keys** panel also checks
keys you can't make yourself - revoked, expired, a higher tier - online
and against their offline files, without activating them; and **Get a
demo key** gets you a key of your own from a test purchase.

### Offline, and what it doesn't let through

Without the server, the app trusts its signed license file, but only:

- for at most `MAX_DAYS_OFFLINE` (14) days since the last good online
  check - the file's own expiry is the license's, and a perpetual
  license's file never expires, so it can't be the limit;
- for the key stored on this machine;
- while the clock hasn't gone back since the app last ran.

When the server says no - revoked, expired, or this machine's seat freed
elsewhere - the app drops the file, so going offline can't undo it. And
every good online check refreshes the file.

### The public key

A real app ships its server's public key and passes it as
`builtInPublicKey` (`main/main.js`), so the offline check trusts nothing it
downloads. This demo can point at any server, so it fetches the key once
and pins it instead, and warns if the server's key later changes.

## Run it

You need Node.js 22.12 or later, and a License Server to point it at.
To run one on your machine with Docker (30-day evaluation mode):

```bash
docker run -d --name license-server -p 127.0.0.1:3001:3001 \
  -e CASAZIUM_UNLICENSED_EVAL=1 -e AUTO_GENERATE_SECRETS=true \
  -e ADMIN_API_KEY=choose-a-long-random-admin-key \
  ghcr.io/casazium/license:latest
```

Then issue a demo license, and start the app:

```bash
npm install
LICENSE_SERVER_URL=http://localhost:3001/v1 ADMIN_API_KEY=choose-a-long-random-admin-key npm run seed:local
npm start
```

In the app, set the server URL and the product UUID the seed printed,
then paste the license key and activate.

## Where the licensing is

- [`main/licensing.js`](main/licensing.js) - all of it: activation, the
  launch check, the offline file, deactivation and usage. No Electron in
  it, so you can read it on its own.
- [`main/calls.js`](main/calls.js) - the `fetch` the SDK calls through:
  a timeout, the call log, and how errors are classified (a 4xx other
  than 429 is the server saying no; anything else means "no answer", and
  the offline file decides).
- [`main/main.js`](main/main.js) - the Electron main process. The
  licensing runs here, never in the page.
- [`preload/preload.cjs`](preload/preload.cjs) - the only calls the page
  can make.

The app never holds an admin API key: issuing and revoking licenses
belong on a server you control.

Everything the license decision depends on - the key, the activation
token, the offline file, the pinned public key and when the app last
checked online - is stored encrypted with Electron's `safeStorage` (the
system keychain). On Linux without a keychain the app says it can't
protect them. Plain JSON holds only settings and the demo server's
public `seed.json`.

Sections marked **DEMO ONLY** in `main/licensing.js` (simulated machines,
the demo keys, accepting a changed server key) exist so one computer can
show what several would. Leave them out of a real app.

For a packaged, distributed app, also set Electron's
[fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) (for
example `RunAsNode` off) when you build it; they apply to the packaged
binary, not to `npm start`.

## Tests

```bash
npm test                       # the licensing module, against a fake SDK client
node scripts/smoke.mjs         # the real app against your server (see the file for the variables)
```

## License

MIT
