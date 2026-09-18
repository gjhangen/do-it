const CACHE='do-it-shell-v2';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon.svg'];

self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});

self.addEventListener('activate',e=>{
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  ]));
});

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(
    fetch(e.request).then(r=>{
      const copy=r.clone();
      caches.open(CACHE).then(c=>c.put(e.request,copy));
      return r;
    }).catch(()=>caches.match(e.request))
  );
});

function notificationOptions(data={}){
  return {
    body:data.body||'Something needs your attention.',
    icon:'./icon.svg',
    badge:'./icon.svg',
    tag:data.tag||'do-it',
    timestamp:data.timestamp||Date.now(),
    renotify:true,
    data:{url:data.url||'./'}
  };
}

self.addEventListener('push',e=>{
  let data={};
  try{ data=e.data?e.data.json():{} }catch{ data={body:e.data?e.data.text():''} }
  e.waitUntil(self.registration.showNotification(data.title||'Do It',notificationOptions(data)));
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{
      const existing=ws.find(w=>'focus' in w);
      return existing?existing.focus():clients.openWindow(e.notification.data?.url||'./');
    })
  );
});
