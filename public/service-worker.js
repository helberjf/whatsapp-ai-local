const CACHE='whats-ai-shell-v1';
const FALLBACK=['/offline.html','/offline.css','/icons/whats-ai.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FALLBACK)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name.startsWith('whats-ai-shell-') && name!==CACHE).map(name=>caches.delete(name)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const {request}=event,url=new URL(request.url),{pathname}=url;
  if(url.origin!==self.location.origin || request.method!=='GET' || pathname.startsWith('/api/') || pathname==='/health') return;
  if(FALLBACK.includes(pathname)) {event.respondWith(caches.match(request).then(cached=>cached || fetch(request)));return;}
  if(request.mode==='navigate') event.respondWith(fetch(request).catch(()=>caches.match('/offline.html')));
});
