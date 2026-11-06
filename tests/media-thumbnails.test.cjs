const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeMessage}=require('../lib/evolution.cjs');

const key={id:'media-1',remoteJid:'5511998765432@s.whatsapp.net',fromMe:false};
const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x02,0xff,0xd9]);
const message=(type,media,extra={})=>normalizeMessage({key,message:{[type+'Message']:{caption:'Legenda original',mimetype:type==='image'?'image/jpeg':'video/mp4',...media}},...extra});

test('image and video thumbnails normalize local JPEG base64 without exposing connector URLs',()=>{
  for(const type of ['image','video']) {
    const normalized=message(type,{jpegThumbnail:jpeg.toString('base64'),url:'https://remote.example/private',thumbnailDirectPath:'/private-thumb'});
    assert.equal(normalized.jpegThumbnail,jpeg.toString('base64'));
    assert.equal(normalized.type,type);assert.equal(normalized.text,'Legenda original');
    assert.doesNotMatch(JSON.stringify(normalized),/remote\.example|private-thumb/);
  }
});

test('connector Buffer and Uint8Array thumbnail representations normalize to the same base64',()=>{
  const representations=[jpeg,new Uint8Array(jpeg),JSON.parse(JSON.stringify(jpeg)),JSON.parse(JSON.stringify(new Uint8Array(jpeg))),Array.from(jpeg)];
  for(const jpegThumbnail of representations) assert.equal(message('image',{jpegThumbnail}).jpegThumbnail,jpeg.toString('base64'));
});

test('thumbnail size limit uses decoded bytes and accepts the 256 KiB boundary',()=>{
  const boundary=Buffer.alloc(256*1024);jpeg.copy(boundary);
  for(const jpegThumbnail of [boundary,boundary.toString('base64'),{type:'Buffer',data:Array.from(boundary)}]) {
    const normalized=message('image',{jpegThumbnail});assert.equal(typeof normalized.jpegThumbnail,'string');
    assert.equal(Buffer.from(normalized.jpegThumbnail,'base64').length,boundary.length);
  }
  const oversized=Buffer.concat([boundary,Buffer.from([0])]);
  for(const jpegThumbnail of [oversized,oversized.toString('base64'),{type:'Buffer',data:Array.from(oversized)},JSON.parse(JSON.stringify(new Uint8Array(oversized)))]) {
    const normalized=message('image',{jpegThumbnail});assert.equal(Object.hasOwn(normalized,'jpegThumbnail'),false);assert.equal(normalized.text,'Legenda original');
  }
});

test('invalid thumbnails are ignored without losing the original message',()=>{
  for(const jpegThumbnail of [undefined,null,'','https://remote.example/photo.jpg','data:image/svg+xml;base64,PHN2Zz4=',jpeg.toString('base64')+'!',jpeg.toString('base64')+'=',Buffer.from('not a JPEG'),{type:'Buffer',data:[255,216,255,-1]},{type:'Buffer',data:[255,216,255,256]},{type:'Buffer',data:[255,216,255,1.5]},{type:'Buffer',data:'not bytes'},{0:255,1:216,3:255},{0:255,1:216,2:255,extra:1},{url:'https://remote.example/thumb'}]) {
    const normalized=message('video',{jpegThumbnail,seconds:12});
    assert.equal(Object.hasOwn(normalized,'jpegThumbnail'),false);assert.equal(normalized.type,'video');assert.equal(normalized.text,'Legenda original');
  }
});

test('video duration exposes only finite nonnegative numeric seconds',()=>{
  for(const seconds of [0,1,12.5]) assert.equal(message('video',{seconds}).durationSeconds,seconds);
  for(const seconds of [undefined,null,-1,NaN,Infinity,-Infinity,'12',false,{},[]]) assert.equal(Object.hasOwn(message('video',{seconds}),'durationSeconds'),false);
  for(const type of ['image','audio','document','sticker']) assert.equal(Object.hasOwn(message(type,{seconds:12,jpegThumbnail:jpeg}),'durationSeconds'),false);
});

test('nested media preserves preview metadata while deleted and unrelated media omit it',()=>{
  const video={videoMessage:{jpegThumbnail:jpeg.toString('base64'),seconds:5,caption:'Vídeo temporário'}};
  const nested=normalizeMessage({key,message:{ephemeralMessage:{message:video}}});
  assert.equal(nested.jpegThumbnail,jpeg.toString('base64'));assert.equal(nested.durationSeconds,5);assert.equal(nested.ephemeral,true);
  const deleted=normalizeMessage({key,message:video,status:'DELETED'});
  assert.equal(deleted.type,'deleted');assert.equal(Object.hasOwn(deleted,'jpegThumbnail'),false);assert.equal(Object.hasOwn(deleted,'durationSeconds'),false);
  for(const type of ['audio','document','sticker']) assert.equal(Object.hasOwn(message(type,{jpegThumbnail:jpeg}),'jpegThumbnail'),false);
});
