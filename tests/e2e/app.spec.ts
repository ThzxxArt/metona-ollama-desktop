import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, METONA_E2E: '1' } });
  page = await app.firstWindow();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console.error]', msg.text());
  });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test('主窗口可启动并显示品牌', async () => {
  await expect(page.locator('.app-title')).toHaveText('Metona Ollama');
});

test('preload 领域桥可用（IPC 发送方校验未误伤正常调用）', async () => {
  const info = await page.evaluate(
    () => (window as unknown as { metonaDesktop?: { sys?: { platform?: string } } }).metonaDesktop?.sys,
  );
  expect(info?.platform).toBeTruthy();
  const config = await page.evaluate(() =>
    (
      window as unknown as { metonaDesktop?: { ollama?: { getConfig: () => Promise<{ mode: string }> } } }
    ).metonaDesktop?.ollama?.getConfig(),
  );
  expect(config?.mode).toMatch(/^(local|remote)$/);
});

test('设置面板包含本地/远程与上下文数字输入', async () => {
  await page.click('#btnSettings');
  await expect(page.locator('#selectOllamaMode')).toBeVisible();
  await expect(page.locator('#inputServerUrl')).toBeVisible();
  await expect(page.locator('#inputContextLength')).toHaveAttribute('type', 'number');
  await expect(page.locator('#inputTemperature')).toHaveCount(0);
  await expect(page.locator('#selectContextLength')).toHaveCount(0);
});

test('工具面板严格显示 18 个工具，且无 Plan Mode', async () => {
  await page.keyboard.press('Escape');
  await page.click('#btnTools');
  const cards = page.locator('#toolsGrid .tool-card');
  await expect(cards).toHaveCount(18);
  await expect(page.locator('#badge_plan_track')).toHaveCount(0);
  await expect(page.locator('#togglePlan')).toHaveCount(0);
});

test('帮助面板不再出现 Plan Mode', async () => {
  await page.keyboard.press('Escape');
  await page.click('#btnHelp', { force: true });
  const helpText = await page.locator('#helpModal').innerText();
  expect(helpText.toLowerCase()).not.toContain('plan mode');
  expect(helpText).toContain('18');
});
