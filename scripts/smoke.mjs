// Drives the real app (Electron, preload, page) against a License Server
// you run yourself, with a throwaway data folder, and saves screenshots.
//
//   LICENSE_SERVER_URL=http://localhost:3001/v1 LICENSE_KEY=... PRODUCT_UUID=... \
//     SCREENSHOTS=/some/folder node scripts/smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const { LICENSE_SERVER_URL = 'http://localhost:3001/v1', LICENSE_KEY, PRODUCT_UUID, SCREENSHOTS } = process.env;
if (!LICENSE_KEY || !PRODUCT_UUID) throw new Error('Set LICENSE_KEY and PRODUCT_UUID (npm run seed:local prints both)');
const shots = SCREENSHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'license-demo-shots-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'license-demo-data-'));

const app = await electron.launch({ args: ['.'], env: { ...process.env, LICENSE_DEMO_USER_DATA: userData } });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
const text = (id) => page.locator(`#${id}`).innerText();
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

try {
  await page.waitForLoadState('domcontentloaded');
  await page.fill('#server-url', LICENSE_SERVER_URL);
  await page.fill('#product-uuid', PRODUCT_UUID);
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#settings-note').textContent === 'Saved.');
  await shot('1-start');

  await page.fill('#key-input', LICENSE_KEY);
  await page.click('#activate-form button[type=submit]');
  await page.waitForFunction(() => /^Activated/.test(document.querySelector('#license-state').textContent));
  console.log('activate     :', (await text('license-state')).replace(/\n/g, ' | '));
  console.log('summary      :', await text('license-summary'));

  await page.evaluate(() => document.querySelector('#license-state').replaceChildren());
  await page.click('#launch-check');
  await page.waitForFunction(() => document.querySelector('#license-state').textContent.length > 0);
  console.log('launch check :', (await text('license-state')).replace(/\n/g, ' | '));

  await page.waitForFunction(() => /used with this key/.test(document.querySelector('#usage-state').textContent));
  const before = await text('usage-state');
  await page.click('#use-once');
  await page.waitForFunction((was) => document.querySelector('#usage-state').textContent !== was, before);
  console.log('usage        :', before, '->', await text('usage-state'));

  await page.check('#offline-switch');
  await page.click('#launch-check');
  await page.waitForFunction(() => /license file decides/.test(document.querySelector('#license-state').textContent));
  console.log('offline check:', (await text('license-state')).replace(/\n/g, ' | '));
  await shot('2-activated');

  console.log('calls logged :', await page.locator('#call-list li').count());
  const keyShown = (await page.content()).includes(LICENSE_KEY);
  console.log('full key anywhere in the page:', keyShown);

  // The renderer has no Node and no Electron.
  console.log('renderer has require/process:', await page.evaluate(() => [typeof require, typeof process]));

  // Machines: a second machine takes the other seat, a third is refused.
  const machines = async (button) => {
    await page.evaluate(() => document.querySelector('#machines-state').replaceChildren());
    await page.click(button);
    await page.waitForFunction(() => document.querySelector('#machines-state').textContent.length > 0);
    return (await text('machines-state')).replace(/\n/g, ' | ');
  };
  await page.uncheck('#offline-switch');
  console.log('machine 2    :', await machines('#simulate-machine'));
  console.log('machine 3    :', await machines('#simulate-machine'));
  console.log('seats        :', await text('machines-summary'));
  await shot('3-seat-limit');
  console.log('free others  :', await machines('#free-simulated'));

  // This machine's seat freed elsewhere: the launch check catches it.
  console.log('free mine    :', await machines('#free-this-seat'));
  await page.evaluate(() => document.querySelector('#license-state').replaceChildren());
  await page.click('#launch-check');
  await page.waitForFunction(() => document.querySelector('#license-state').textContent.length > 0);
  console.log('launch check :', (await text('license-state')).replace(/\n/g, ' | '));
  console.log('reactivate shown:', await page.isVisible('#reactivate'));
  await shot('4-seat-freed');
  await page.click('#reactivate');
  await page.waitForFunction(() => /Activated again/.test(document.querySelector('#license-state').textContent));
  console.log('reactivate   :', (await text('license-state')).replace(/\n/g, ' | '));

  // A changed public key: replace the pinned key, as a rebuilt server would look.
  const stateFile = path.join(userData, 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.writeFileSync(stateFile, JSON.stringify({ ...saved, publicKey: '-----BEGIN PUBLIC KEY-----\nnot the server key\n-----END PUBLIC KEY-----' }));
  await page.click('#launch-check');
  await page.waitForSelector('#key-warning:not([hidden])');
  console.log('key warning shown:', await page.isVisible('#key-warning'));
  await shot('5-key-warning');
  await page.click('#trust-key');
  await page.waitForSelector('#key-warning[hidden]', { state: 'attached' });
  console.log('after trust  :', await text('offline-state'));
  console.log('pinned again :', JSON.parse(fs.readFileSync(stateFile, 'utf8')).publicKey === saved.publicKey);

  await page.click('#deactivate');
  await page.waitForFunction(() => /Deactivated/.test(document.querySelector('#license-state').textContent));
  console.log('deactivate   :', await text('license-state'));
  console.log('summary      :', await text('license-summary'));
  await shot('3-deactivated');
  console.log('page errors  :', errors.length ? errors : 'none');
  console.log('screenshots  :', shots);
} catch (err) {
  console.log('FAILED       :', err.message.split('\n')[0]);
  console.log('license state:', await text('license-state').catch(() => '?'));
  console.log('page errors  :', errors);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
}
