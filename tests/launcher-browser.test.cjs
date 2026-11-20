const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
const {runVisualLauncher}=require('../scripts/launcher-ui.cjs');

test('Playwright abre o carregamento e entra na central pelo iniciador real',{skip:process.env.WHATSAPP_LAUNCHER_LIVE_TEST!=='1',timeout:240000},async t=>{
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const result=await runVisualLauncher({
    openBrowser:async url=>{
      await page.goto(url);
      assert.match(await page.locator('h1').innerText(),/Abrindo Whats AI/);
    }
  });
  assert.equal(result,0);
  await page.waitForURL(/http:\/\/127\.0\.0\.1:8766\//,{timeout:30000});
  await page.locator('#account-switcher').waitFor({state:'visible',timeout:30000});
  const response=await page.request.get('http://127.0.0.1:8766/health');
  assert.equal(response.ok(),true);
  assert.equal((await response.json()).service,'whatsapp-local');
  await page.reload();
  await page.locator('#account-switcher').waitFor({state:'visible',timeout:30000});
  await page.waitForFunction(()=>globalThis.WhatsAppCentral?.connection()?.state && /^\d+$/.test(document.getElementById('metric-unread').textContent),{},{timeout:90000});
  const screenshot=path.join(__dirname,'..','data','launcher-playwright.png');
  await page.screenshot({path:screenshot});
  assert.deepEqual(errors,[]);
  console.log('Webapp aberto e pronto. Captura em '+screenshot);
});
