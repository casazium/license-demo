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

If the server's signing key ever changes, the app says so: offline
license files signed with the old key stop verifying, and an
unexpected change can mean a different server.

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

## Tests

```bash
npm test                       # the licensing module, against a fake SDK client
node scripts/smoke.mjs         # the real app against your server (see the file for the variables)
```

## License

MIT
