// The bundled Montserrat is what the panels render with: the file was requested from this server, answered 200,
// is loaded as a face of the family, and nothing was requested from any other host. The machine may have its
// own Montserrat installed, so the page's own evidence is used, not how the text looks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const file = resolve(import.meta.dirname, '../../web/fonts/Montserrat-wght.woff2');
// Elements of fonts.html and the weight the stylesheet gives each one.
const weights = { text: 500, button: 600, heading: 650, title: 700, price: 700, 'phone-buy': 650, 'phone-chosen': 600, 'phone-price': 700 };

export function fontChecks() {
  test('the panels render with the Montserrat file shipped in web/fonts', async ({ page, baseURL, browserName }) => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    const fontResponses = [];
    page.on('response', response => { if (response.url().endsWith('.woff2')) fontResponses.push(response); });
    await page.goto('/test/browser/fonts.html');
    await page.evaluate(() => document.fonts.ready);

    for (const [id, weight] of Object.entries(weights)) {
      const style = await page.$eval('#' + id, el => { const s = getComputedStyle(el); return [s.fontFamily, s.fontWeight]; });
      expect(style[0], id).toMatch(/^["']?IL Montserrat["']?, Montserrat, Inter,/);
      expect(Number(style[1]), id).toBe(weight);
      const loaded = await page.evaluate(w => document.fonts.load(w + ' 16px "IL Montserrat"').then(faces => faces.map(f => f.status)), weight);
      expect(loaded, 'faces for weight ' + weight).toEqual(['loaded']);
    }
    const faces = await page.evaluate(() => [...document.fonts].map(f => ({ family: f.family.replace(/"/g, ''), weight: f.weight, status: f.status })));
    expect(faces).toEqual([{ family: 'IL Montserrat', weight: '100 900', status: 'loaded' }]);

    expect(fontResponses).toHaveLength(1);
    expect(fontResponses[0].url()).toBe(baseURL + '/web/fonts/Montserrat-wght.woff2');
    expect(fontResponses[0].status()).toBe(200);
    expect(Buffer.compare(await fontResponses[0].body(), readFileSync(file))).toBe(0);
    expect(requests.filter(url => !url.startsWith(baseURL + '/'))).toEqual([]);
    // The rule lives in fonts.css, which player.css imports next to the file it names.
    expect(requests).toContain(baseURL + '/web/fonts.css');

    // 650 is its own instance of the variable axis: between 600 and 700, not a copy of either.
    const widths = await page.evaluate(() => [600, 650, 700].map(weight => {
      const span = document.createElement('span');
      span.style.cssText = `font: ${weight} 40px "IL Montserrat"; white-space: nowrap; position: absolute`;
      span.textContent = 'Botella térmica Capacidad 750 ml';
      document.body.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    }));
    expect(widths[0]).toBeLessThan(widths[1]);
    expect(widths[1]).toBeLessThan(widths[2]);

    if (browserName === 'chromium') {
      // Chromium reports which font painted a node: the page's own custom font, not one installed on the machine.
      const client = await page.context().newCDPSession(page);
      await client.send('DOM.enable');
      await client.send('CSS.enable');
      const { root } = await client.send('DOM.getDocument');
      for (const id of Object.keys(weights)) {
        const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#' + id });
        const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
        // The name is the one inside the file (its default instance is named "Montserrat Thin").
        expect(fonts.map(f => [f.familyName.startsWith('Montserrat'), f.isCustomFont]), id).toEqual([[true, true]]);
      }
    }
  });
}
