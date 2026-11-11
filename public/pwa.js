(()=>{
  'use strict';
  if(!('serviceWorker' in navigator) || location.protocol!=='http:') return;
  addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js',{scope:'/'}).catch(()=>{}),{once:true});
})();
