const {test:base,expect}=require('@playwright/test');
const {createDemo}=require('../../scripts/demo.cjs');
const test=base.extend({demo:async({},use)=>{const demo=await createDemo({port:0});try {await use(demo);}finally {await demo.close();}}});
async function setup(page,demo) {
  const html=await(await fetch(demo.base)).text(),token=html.match(/name="whatsapp-session" content="([a-f0-9]+)"/)[1];
  const support=await(await fetch(demo.base+'/api/accounts',{method:'POST',headers:{'X-WhatsApp-Token':token,'Content-Type':'application/json'},body:JSON.stringify({name:'suporte'})})).json();
  const items=Array.from({length:10},(_,i)=>({messageId:'m'+i,conversationId:'c'+i,businessId:'b'+i,name:'Empresa '+i,phone:'551199999000'+i,body:'Olá, empresa '+i})),calls=[];
  await page.route('**/api/prospection/drafts',async route=>{
    const request=route.request();calls.push({method:request.method(),headers:request.headers(),body:request.postDataJSON()});
    if(request.method()==='PATCH') {const input=request.postDataJSON();items.find(item=>item.messageId===input.messageId).body=input.body;}
    await route.fulfill({json:{items,accountId:support.id,accountName:'suporte',systemUrl:'http://localhost:3000/rascunhos'}});
  });
  await page.goto(demo.base+'/?prospeccao=1&conta='+support.id);
  return {support,calls,items};
}
test('support deep link opens ten editable drafts and dirty text blocks refresh and preparation',async({page,demo})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));const {support,calls}=await setup(page,demo);
  await expect(page.locator('#page-prospection')).toBeVisible();await expect(page.locator('#account-name')).toHaveText('suporte');
  const cards=page.locator('.prospection-card');await expect(cards).toHaveCount(10);
  await expect(page.getByRole('link',{name:'Abrir prospecção',exact:true})).toHaveAttribute('href','http://localhost:3000/rascunhos');
  await expect(cards.first().getByRole('link',{name:'Abrir no sistema'})).toHaveAttribute('href','http://localhost:3000/inbox?c=c0');
  await cards.first().locator('textarea').fill('Revisão pessoal');
  await page.locator('#prospection-refresh').click();await expect(page.locator('#prospection-status')).toContainText('Salve');
  await page.locator('#prospection-prepare').click();await expect(page.locator('#prospection-status')).toContainText('Salve');
  expect(calls).toHaveLength(1);await expect(cards.first().locator('textarea')).toHaveValue('Revisão pessoal');
  await cards.first().getByRole('button',{name:'Salvar rascunho'}).click();await expect(cards.first().getByRole('status')).toContainText('salvo');
  expect(calls[1].body).toEqual({messageId:'m0',body:'Revisão pessoal',expectedBody:'Olá, empresa 0'});
  await page.locator('#prospection-prepare').click();await expect.poll(()=>calls.length).toBe(3);
  expect(calls.map(call=>call.method)).toEqual(['GET','PATCH','POST']);expect(calls.every(call=>call.headers['x-whatsapp-account']===support.id)).toBe(true);
  await page.locator('#nav-conversations').click();await expect(page.locator('#page-prospection')).toBeHidden();
  await page.locator('#nav-prospection').click();await expect(cards.first().locator('textarea')).toHaveValue('Revisão pessoal');
  expect(errors).toEqual([]);
});
test('principal cannot prepare drafts and the panel fits a narrow screen',async({page,demo})=>{
  await page.setViewportSize({width:390,height:844});await page.goto(demo.base+'/?prospeccao=1');
  await expect(page.locator('#page-prospection')).toBeVisible();await expect(page.locator('#prospection-prepare')).toBeDisabled();
  await expect(page.locator('#prospection-status')).toContainText('suporte');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
