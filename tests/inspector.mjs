import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const response = {
  id: 'resp_fixture', model: 'test-model', status: 'completed', created_at: 1700000000,
  previous_response_id: null, instructions: 'Instrucciones de prueba',
  usage: { input_tokens: 1234, output_tokens: 567 },
  output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Resumen disponible' }] },
    { type: 'function_call', name: 'buscar_partidas', arguments: JSON.stringify({ codigo: 'ABC', nested: { importe: 0, enabled: false, missing: null }, items: [] }) },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Primera linea\n' + 'Texto largo de prueba. '.repeat(150) + '\nFINAL_COMPLETO <script>window.bad=true</script>' }] },
    { type: 'unknown_future_type', custom: { preserved: 'CAMPO_DESCONOCIDO' } }
  ], metadata: { object: {}, list: [], falsy: false, zero: 0, nothing: null }
};
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  let data;
  if (url.pathname === '/api/health') data = { runtime: 'test', api_key_configured: true };
  else if (url.pathname === '/api/chain') {
    assert.equal(url.searchParams.get('limit'), '1');
    if (url.searchParams.get('response_id') === 'resp_error') return route.fulfill({ status: 404, json: { error: { message: 'Respuesta no encontrada' } } });
    data = { chain: [{ response, input_items: [], input_items_error: { message: 'Sin permiso de entrada' } }], truncated: true };
  } else if (url.pathname === '/api/continue') data = { response: { ...response, id: 'resp_unsaved' } };
  else throw new Error(`Unexpected endpoint ${url.pathname}`);
  await route.fulfill({ json: data });
});
try {
  await page.goto('http://127.0.0.1:8787');
  await page.locator('#response-id').fill('resp_fixture');
  await page.getByRole('button', { name: 'Cargar', exact: true }).click();
  await page.locator('#inspector-content').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.trace-card').count(), 4);
  assert.equal(await page.locator('.trace-card[open]').count(), 1);
  await page.locator('#expand-all').click();
  assert.ok((await page.locator('#viewer').innerText()).includes('FINAL_COMPLETO'));
  assert.ok((await page.locator('#viewer').innerText()).includes('CAMPO_DESCONOCIDO'));
  assert.equal(await page.evaluate(() => window.bad), undefined);
  assert.equal(await page.locator('.sidebar').count(), 0);
  await page.locator('[data-view=json]').click();
  await page.locator('#collapse-all').click();
  assert.equal(await page.locator('#viewer details[open]').count(), 0);
  await page.locator('#search').fill('FINAL_COMPLETO');
  await page.waitForFunction(() => document.querySelectorAll('mark').length > 0);
  await page.locator('#next-match').click();
  assert.equal(await page.locator('mark.current-match').count(), 1);
  await page.locator('#search').fill('');
  await page.locator('#expand-all').click();
  await page.locator('#decode-json').uncheck();
  assert.ok((await page.locator('#viewer').innerText()).includes('\\"codigo\\"'));
  await page.locator('#decode-json').check();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-json').click();
  const download = await downloadPromise;
  assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(), 'utf8')), response);
  await page.locator('[data-view=input]').click();
  assert.ok((await page.locator('#viewer').innerText()).includes('No se pudieron recuperar'));
  await page.locator('[data-view=trace]').click();
  await page.locator('#collapse-all').click();
  await page.locator('#expand-all').click();
  await page.screenshot({ path: 'tests/inspector-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: 'tests/inspector-mobile.png', fullPage: true });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  for (const id of ['collapse-all', 'download-json', 'open-composer']) {
    const box = await page.locator('#' + id).boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 844);
  }
  await page.locator('#collapse-all').click();
  assert.equal(await page.locator('#viewer details[open]').count(), 0);
  await page.screenshot({ path: 'tests/inspector-mobile.png', fullPage: false });
  await page.locator('#open-composer').click();
  assert.ok(await page.locator('#composer-dialog').isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#composer-dialog').isVisible(), false);
  await page.locator('#open-composer').click();
  await page.locator('#message').fill('Continuar prueba');
  await page.locator('#store').uncheck();
  await page.locator('#continue-button').click();
  await page.waitForFunction(() => document.querySelector('#selected-id').textContent === 'resp_unsaved');
  await page.locator('#response-id').fill('resp_error');
  await page.getByRole('button', { name: 'Cargar', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Respuesta no encontrada'));
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/api/')) requests++; });
  await page.locator('#json-file').setInputFiles(await download.path());
  await page.waitForFunction(() => document.querySelector('#source-note').textContent.includes('Archivo local'));
  assert.equal(requests, 0);
  assert.equal(await page.locator('#selected-id').textContent(), response.id);
  const reexport = page.waitForEvent('download');
  await page.locator('#download-json').click();
  assert.deepEqual(JSON.parse(fs.readFileSync(await (await reexport).path(), 'utf8')), response);
  await page.locator('#json-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('No se pudo abrir'));
  assert.equal(await page.locator('#selected-id').textContent(), response.id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#collapse-all').click();
  await page.screenshot({ path: 'tests/inspector-desktop.png', fullPage: false });
  assert.deepEqual(errors, []);
  console.log('PASS: trace, nested JSON, full text, search, collapse, original download, errors, mobile, unsaved fork, safe rendering.');
} finally { await browser.close(); }
