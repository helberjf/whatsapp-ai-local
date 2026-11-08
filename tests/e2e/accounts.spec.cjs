const {test:base,expect}=require('@playwright/test');
const {createDemo}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});
const conversations=page=>page.locator('#chat-list .chat-item');

test('second account pairs by QR, keeps its own data and can be removed without touching the first',async({page,demo})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(demo.base);await expect(conversations(page)).toHaveCount(10);
  await expect(page.locator('#account-name')).toHaveText('Conta principal');await expect(page.locator('#account-state')).toHaveText('Conectada');

  await page.locator('#account-switcher').click();await expect(page.locator('#accounts-list .account-row')).toHaveCount(1);
  await page.locator('#account-add').click();await page.locator('#account-name-input').fill('Loja');await page.locator('#account-name-save').click();

  await expect(page.locator('#qr-dialog')).toBeVisible();await expect(page.locator('#qr-title')).toHaveText('Conectar Loja');await expect(page.locator('#qr-image')).toBeVisible();
  await expect(page.locator('#qr-dialog')).not.toBeVisible({timeout:10000});
  await expect(page.locator('#account-name')).toHaveText('Loja');await expect(page.locator('#composer-account')).toHaveText('Enviando por: Loja',{useInnerText:false});
  await expect(page.locator('#status-whatsapp')).toHaveText('Conectado');await expect(page.locator('#chat-list .chat-item')).toHaveCount(0);

  await page.locator('#account-switcher').click();
  const rows=page.locator('#accounts-list .account-row');await expect(rows).toHaveCount(2);
  await expect(rows.filter({hasText:'Em uso'})).toContainText('Loja');await expect(rows.filter({hasText:'Conta principal'})).toContainText('Conectada');
  await rows.filter({hasText:'Conta principal'}).getByRole('button',{name:'Usar esta conta'}).click();
  await expect(page.locator('#account-name')).toHaveText('Conta principal');await expect(conversations(page)).toHaveCount(10);

  await page.reload();await expect(page.locator('#account-name')).toHaveText('Conta principal');

  await page.locator('#account-switcher').click();await rows.filter({hasText:'Loja'}).getByRole('button',{name:'Remover'}).click();
  await expect(page.locator('#account-remove-confirm')).toBeDisabled();await page.locator('#account-remove-input').fill('Loja');await page.locator('#account-remove-confirm').click();
  await expect(rows).toHaveCount(1);await expect(rows).toContainText('Conta principal');await expect(conversations(page)).toHaveCount(10);
  expect(errors).toEqual([]);
});

test('account switcher stays usable on a phone-sized screen',async({page,demo})=>{
  await page.setViewportSize({width:390,height:844});await page.goto(demo.base);await expect(page.locator('#account-state')).toBeAttached();
  await expect(page.locator('#account-switcher')).toBeVisible();await page.locator('#account-switcher').click();
  await expect(page.locator('#accounts-dialog')).toBeVisible();await expect(page.locator('#account-add')).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
