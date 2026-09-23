// Only declared public page names leave the browser. No query strings or fragments.
export async function countView(message,{url,apiUrl,source='spa',pages=['/','/about','/services','/account','/login']}) {
 if(typeof window==='undefined'||navigator.doNotTrack==='1')return false;
 try {
  const pathname=new URL(url,window.location.origin).pathname;
  const path=pages.includes(pathname)?pathname:'/other';
  const response=await fetch(apiUrl.replace(/\/$/,'')+'/observer/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,path,message:message.slice(0,200)}),keepalive:true,credentials:'omit'});
  return response.ok;
 }catch{return false;}
}
export function trackPage(api,source,pathname,pages) {
 void countView('Page viewed',{apiUrl:api,url:pathname,source,pages});
}
