const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('@playwright/test');

const root=path.join(__dirname,'..'),icons=path.join(root,'public','icons'),source=path.join(icons,'whats-ai.svg');
async function render(browser,size,file,scale=1) {
  const page=await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
  const svg=await fs.readFile(source,'utf8');
  await page.setContent(`<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;display:grid;place-items:center;background:transparent}svg{width:${scale*100}%;height:${scale*100}%}</style>${svg}`);
  const output=await page.screenshot({omitBackground:true});
  await page.close();await fs.writeFile(path.join(icons,file),output);return output;
}
function ico(png) {
  const header=Buffer.alloc(22);header.writeUInt16LE(0,0);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);
  header[6]=0;header[7]=0;header[8]=0;header[9]=0;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  return Buffer.concat([header,png]);
}
(async()=>{
  await fs.mkdir(icons,{recursive:true});const browser=await chromium.launch({headless:true});
  try {
    await render(browser,192,'whats-ai-192.png');
    await render(browser,512,'whats-ai-512.png');
    await render(browser,512,'whats-ai-maskable-512.png',.8);
    const png=await render(browser,256,'.whats-ai-256.png');await fs.writeFile(path.join(icons,'whats-ai.ico'),ico(png));await fs.rm(path.join(icons,'.whats-ai-256.png'));
  } finally {await browser.close();}
  console.log('Ícones Whats AI atualizados.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
