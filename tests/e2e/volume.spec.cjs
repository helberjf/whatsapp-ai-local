const {test:base,expect}=require('@playwright/test');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppServer}=require('../../server.cjs');

// Central com milhares de conversas fictícias e conector simulado; nada sai do processo.
const COUNT=3000,jidOf=i=>'55119'+String(i).padStart(8,'0')+'@s.whatsapp.net';
const test=base.extend({central:async({},use)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-central-volume-'));
  const rows=Array.from({length:COUNT},(_,i)=>({remoteJid:jidOf(i),pushName:'Cliente '+String(i).padStart(4,'0'),unreadCount:i%5===0?1:0,lastMessage:{key:{id:'m'+i,remoteJid:jidOf(i),fromMe:false},message:{conversation:'Mensagem '+i},messageTimestamp:1793200000+COUNT-i}}));
  const fetchImpl=async(url,options={})=>{
    const route=new URL(url).pathname,input=options.body?JSON.parse(options.body):{};
    const output=route.includes('/connectionState/')?{instance:{state:'open'}}:route.includes('/fetchInstances')?[{name:'t',ownerJid:'5511000000000@s.whatsapp.net'}]:route.includes('/findChats/')?(input.where?.remoteJid?rows.filter(item=>item.remoteJid===input.where.remoteJid):rows):route.includes('/findContacts/')?[]:route.includes('/findMessages/')?{messages:{records:rows.filter(item=>item.remoteJid===input.where?.key?.remoteJid).map(item=>item.lastMessage),currentPage:1,pages:1,total:1}}:{};
    return new Response(JSON.stringify(output));
  };
  const credentials={has:async()=>false,get:async()=>null,set:async()=>{},remove:async()=>{},close:async()=>{}};
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:9',apiKey:'k',instanceName:'t'},storeDir:dir,fetchImpl,credentials,disableWorkers:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {await use('http://127.0.0.1:'+server.address().port);}
  finally {await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;await fs.rm(dir,{recursive:true,force:true});}
}});

test('thousands of conversations render only visible rows and stay searchable and clickable',async({page,central})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(central);await expect(page.locator('#chat-count')).toHaveText(String(COUNT));
  const rendered=await page.locator('#chat-list .chat-item').count();expect(rendered).toBeGreaterThan(5);expect(rendered).toBeLessThan(80);
  await expect(page.locator('#chat-list .chat-item').first()).toContainText('Cliente 0000');
  const cost=await page.evaluate(()=>{const start=performance.now();for(let i=0;i<5;i++) globalThis.WhatsAppCentral.renderChats();return (performance.now()-start)/5;});
  expect(cost).toBeLessThan(150);
  await page.locator('#chat-list').evaluate(list=>{list.scrollTop=list.scrollHeight;});
  await expect(page.locator('#chat-list .chat-item').filter({hasText:'Cliente 2999'})).toBeVisible();
  await page.locator('#chat-list .chat-item').filter({hasText:'Cliente 2999'}).click();await expect(page.locator('#contact-name')).toHaveText('Cliente 2999');
  await page.locator('#search').fill('Cliente 1234');await expect(page.locator('#chat-list .chat-item')).toHaveCount(1);
  await page.locator('#search').fill('');await expect(page.locator('#chat-count')).toHaveText(String(COUNT));
  const syncs=await page.evaluate(async()=>{const token=document.querySelector('meta[name="whatsapp-session"]').content,first=await (await fetch('/api/chats?delta=1',{headers:{'X-WhatsApp-Token':token}})).json(),second=await (await fetch('/api/chats?delta=1&since='+encodeURIComponent(first.version),{headers:{'X-WhatsApp-Token':token}})).json();return {full:first.chats.length,changed:second.changed.length};});
  expect(syncs).toEqual({full:COUNT,changed:0});
  expect(errors).toEqual([]);
});
