// Host-driven breaks on the web SDK in a real browser: the page's own ad player reports a break and its ad; the SDK
// draws Buy from IL's break card (routed, fixture body) and takes it away when the ad ends.
import { expect, test } from '@playwright/test';

export function hostBreakChecks() {
  test('host-driven break: a reported ad gets Buy from its break card, gone when the ad ends', async ({ page }) => {
    await page.goto('/test/browser/host-break.html');
    await page.waitForFunction(() => window.harnessReady === true);
    expect(await page.evaluate(() => window.harness.cuts()), 'a host plan schedules no video ad').toBe(0);
    await page.evaluate(() => window.harness.breakStarted(58));
    expect(await page.evaluate(() => window.harness.playing())).toBe(true);
    expect(await page.evaluate(() => window.harness.buy())).toBe(false);
    await page.evaluate(() => window.harness.adStarted());
    await page.waitForFunction(() => window.harness.buy(), null, { timeout: 5000 });
    const asked = (await page.evaluate(() => window.harness.requests)).filter((url) => url.includes('/il-player/break-product'));
    expect(asked).toHaveLength(1);
    const q = new URL(asked[0]).searchParams;
    expect([q.get('cut'), q.get('tag'), q.get('creative'), q.get('delivery'), q.get('locale')])
      .toEqual(['at-58000', 'T_mid', 'cr1', 'D'.repeat(43), 'es']);
    await page.evaluate(() => window.harness.adEnded());
    await page.waitForFunction(() => !window.harness.buy(), null, { timeout: 5000 });
    await page.evaluate(() => window.harness.breakEnded());
    expect(await page.evaluate(() => window.harness.playing())).toBe(false);
  });
}
