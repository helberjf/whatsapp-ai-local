const {test:base,expect}=require('@playwright/test');
const path=require('node:path');
const fs=require('node:fs/promises');

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK9sAAAAASUVORK5CYII=';
const videoFile=path.join(__dirname,'..','fixtures','demo.mp4');
// Browser and public assets are real; API fixtures keep media UI checks independent
// of connector/database state and Windows loopback connection failures.
const test=base.extend({demo:async({page},use)=>{
  const fixture={base:'http://127.0.0.1:8899',videoThumbnail:null,imageBase64:png,failImageOnce:false,imageAttempts:0};
  const jids=['5511000000000@s.whatsapp.net','5511000000001@s.whatsapp.net'];
  const message=(id,jid,type,text)=>({id,jid,type,text,fromMe:false,timestamp:Date.now(),status:'READ',key:{id,remoteJid:jid,fromMe:false},canForward:true});
  const history=[message('demo-image',jids[0],'image','Imagem recebida'),{...message('demo-video',jids[0],'video','Vídeo recebido'),fileName:'product-demo.mp4'},message('hello',jids[1],'text','Outra conversa')];
  const chats=jids.map((jid,index)=>({jid,name:index?'Sam Rivera':'Alex Morgan',unread:0,status:'open',labels:[],notes:[],crm:{stage:'new'},lastMessage:history.find(item=>item.jid===jid)}));
  await page.route(fixture.base+'/**',async route=>{
    const request=route.request(),url=new URL(request.url()),pathname=url.pathname;
    if(pathname==='/') {const html=(await fs.readFile(path.join(__dirname,'..','..','public','index.html'),'utf8')).replace('<head>','<head><meta name="whatsapp-session" content="media-test"><meta name="whatsapp-accounts" content="demo">');return route.fulfill({contentType:'text/html',body:html});}
    if(pathname.startsWith('/assets/')) {try {const name=path.basename(pathname),body=await fs.readFile(path.join(__dirname,'..','..','public',name));return route.fulfill({contentType:name.endsWith('.css')?'text/css':'application/javascript',body});}catch {return route.fulfill({status:404,body:''});}}
    let result;
    if(pathname==='/api/settings') result={templates:[]};
    else if(pathname==='/api/accounts') result=[{id:'demo',name:'Conta de teste',state:'connected',reachable:true}];
    else if(pathname==='/api/connection') result={state:'connected',reachable:true,exists:true,phone:'5511000000000'};
    else if(pathname==='/api/chats') result=chats;
    else if(pathname==='/api/contact') result={status:'open',labels:[],notes:[]};
    else if(pathname==='/api/avatar') result={url:null};
    else if(pathname==='/api/transcriptions') result=[];
    else if(pathname==='/api/messages') result={messages:history.filter(item=>item.jid===url.searchParams.get('jid')).map(item=>item.type==='video' && fixture.videoThumbnail?{...item,jpegThumbnail:fixture.videoThumbnail,durationSeconds:3}:item),page:1,pages:1};
    else if(pathname==='/api/media') {
      if(url.searchParams.get('id')==='demo-image') {if(++fixture.imageAttempts===1 && fixture.failImageOnce) return route.fulfill({status:503,json:{error:'Mídia indisponível'}});result={base64:fixture.imageBase64,mimeType:fixture.imageBase64===png?'image/png':'image/jpeg',fileName:'foto'};}
      else result={base64:(await fs.readFile(videoFile)).toString('base64'),mimeType:'video/mp4',fileName:'demo.mp4'};
    }
    else if(pathname==='/api/send-media') {const input=request.postDataJSON();result=message('sent-'+history.length,input.jid,input.mediaType,input.caption);history.push(result);}
    else if(pathname==='/api/read') result={read:true};
    else if(pathname==='/api/kb') result={documents:[],ai:false};
    else if(pathname==='/api/products') result={products:[]};
    else if(pathname==='/api/ai') result={provider:'openai',model:'',baseUrl:'',hasKey:false,configured:false,providers:{openai:{label:'OpenAI',model:'gpt-4o-mini',baseUrl:'',key:true}}};
    else if(pathname==='/api/automation/settings') result={enabled:false,rules:[],cooldownSeconds:0};
    else return route.fulfill({status:404,json:{error:'Unexpected media test route: '+pathname}});
    await route.fulfill({json:result});
  });
  await use(fixture);
}});

async function openChat(page,name='Alex Morgan') {
  await page.locator('.chat-item').filter({hasText:name}).click();
  await expect(page.locator('#conversation-content')).toBeVisible();
}
async function ready(page,demo) {
  const response=await page.goto(demo.base);expect(response.status()).toBe(200);await expect(page.locator('#chat-list .chat-item')).toHaveCount(2);await openChat(page);
}
async function watchUrls(page) {
  await page.addInitScript(()=>{
    window.__revokedMediaUrls=[];const revoke=URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL=url=>{window.__revokedMediaUrls.push(url);revoke(url);};
  });
}

test('received image is visible immediately and video poster loads without downloading the video',async({page,demo})=>{
  const errors=[],mediaRequests=[];page.on('pageerror',error=>errors.push(error.message));
  const thumbnail=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const paint=canvas.getContext('2d');paint.fillStyle='#174d3c';paint.fillRect(0,0,320,180);paint.fillStyle='#a8efcd';paint.font='24px sans-serif';paint.fillText('Prévia do vídeo',70,96);return canvas.toDataURL('image/jpeg').split(',')[1];});
  demo.videoThumbnail=thumbnail;demo.imageBase64=thumbnail;
  page.on('request',request=>{if(request.url().includes('/api/media?')) mediaRequests.push(new URL(request.url()).searchParams.get('id'));});
  await ready(page,demo);
  const image=page.locator('.conversation-image-preview'),player=page.locator('.video-player');
  await expect(image).toBeVisible();await expect.poll(()=>image.evaluate(node=>node.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('#media-viewer')).not.toBeVisible();await expect(player).toBeVisible();await expect(player).toHaveAttribute('poster',/^data:image\/jpeg;base64,/);
  await expect(player).not.toHaveAttribute('src');await expect(player).toHaveAttribute('preload','none');expect(await player.evaluate(node=>node.paused && !node.autoplay)).toBe(true);
  expect(mediaRequests.filter(id=>id==='demo-image')).toHaveLength(1);expect(mediaRequests.filter(id=>id==='demo-video')).toHaveLength(0);await expect(page.locator('.video-metadata')).toContainText('0:03');
  await page.screenshot({path:test.info().outputPath('received-previews.png')});
  await page.getByRole('button',{name:'Reproduzir vídeo',exact:true}).click();await expect.poll(()=>player.evaluate(node=>node.currentTime)).toBeGreaterThan(.1);
  expect(mediaRequests.filter(id=>id==='demo-video')).toHaveLength(1);expect(errors).toEqual([]);
});

test('local image and video previews remain drafts and release URLs when replaced, removed, switched or sent',async({page,demo})=>{
  const sent=[];page.on('request',request=>{if(request.url().endsWith('/api/send-media') && request.method()==='POST') sent.push(request.postDataJSON());});
  await watchUrls(page);await page.setViewportSize({width:390,height:844});await ready(page,demo);
  await page.locator('#attachment').setInputFiles({name:'foto.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  const preview=page.locator('#attachment-preview');await expect(preview.locator('img')).toBeVisible();await expect.poll(()=>preview.locator('img').evaluate(node=>node.naturalWidth)).toBeGreaterThan(0);
  const imageUrl=await preview.locator('img').getAttribute('src');await page.locator('#attachment').setInputFiles(videoFile);
  const localVideo=preview.locator('video');await expect(localVideo).toBeVisible();await expect.poll(()=>localVideo.evaluate(node=>node.readyState)).toBeGreaterThanOrEqual(1);
  expect(await localVideo.evaluate(node=>node.paused && !node.autoplay && node.controls && node.currentTime===0)).toBe(true);
  await expect.poll(()=>page.evaluate(url=>window.__revokedMediaUrls.includes(url),imageUrl)).toBe(true);expect(sent).toHaveLength(0);
  await page.screenshot({path:test.info().outputPath('local-video-preview-mobile.png')});const videoUrl=await localVideo.getAttribute('src');
  await page.locator('#remove-attachment').click();await expect(preview).not.toBeVisible();expect(await page.evaluate(url=>window.__revokedMediaUrls.includes(url),videoUrl)).toBe(true);
  await page.locator('#attachment').setInputFiles({name:'foto-2.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});const switched=await preview.locator('img').getAttribute('src');
  await page.locator('#back-to-chats').click();await openChat(page,'Sam Rivera');await expect(preview).not.toBeVisible();expect(await page.evaluate(url=>window.__revokedMediaUrls.includes(url),switched)).toBe(true);expect(sent).toHaveLength(0);
  await page.locator('#attachment').setInputFiles(videoFile);const submitted=await preview.locator('video').getAttribute('src');await page.locator('#message-text').fill('Legenda revisada');await page.locator('#send').click();
  await expect(preview).not.toBeVisible();await expect.poll(()=>sent.length).toBe(1);expect(sent[0].caption).toBe('Legenda revisada');expect(await page.evaluate(url=>window.__revokedMediaUrls.includes(url),submitted)).toBe(true);
});

test('failed image preview keeps the conversation usable and an explicit retry opens the image',async({page,demo})=>{
  demo.failImageOnce=true;
  await ready(page,demo);await expect(page.locator('.attachment-preview-status').filter({hasText:'Prévia indisponível'})).toBeVisible();await expect(page.locator('#notice')).not.toBeVisible();
  await page.locator('#message-text').fill('Ainda posso escrever');await expect(page.locator('#message-text')).toHaveValue('Ainda posso escrever');
  await page.getByRole('button',{name:'Abrir imagem',exact:true}).click();await expect(page.locator('#media-viewer')).toBeVisible();await expect.poll(()=>page.locator('#media-viewer-content img').evaluate(node=>node.naturalWidth)).toBeGreaterThan(0);expect(demo.imageAttempts).toBe(2);
});
