export async function loadHome(apiUrl,request=fetch) {
  const response=await request(`${apiUrl}/`,{cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('The API could not load the home page.');
  const home=await response.json();
  if(typeof home.title!=='string'||typeof home.content!=='string')throw new Error('Invalid home response.');
  return {title:home.title,content:home.content};
}
