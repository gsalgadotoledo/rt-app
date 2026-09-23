import Link from 'next/link';
import branding from '../branding.json';
import {publicConfig} from '@gsalgadotoledo/rt-app-config';
import {loadHome} from './home.mjs';
export const dynamic='force-dynamic';
export default async function Home() {
  const config=publicConfig();
  let home;let unavailable=false;
  try {home=await loadHome(config.urls.api);} catch {unavailable=true;}
  return <>

    <main className="home"><div className="home-copy">
      <p className="eyebrow">LESS FRICTION. MORE POSSIBILITY.</p>
      <h1>{home?.title ?? 'Your API is not available yet'}</h1>
      <p className="description">{home?.content ?? 'Start the local services with npm run dev, then reload this page.'}</p>
      {unavailable && <p role="alert">Unable to load the Home content.</p>}
      <Link className="marketing-cta" href="/services">Explore our services <span>→</span></Link>
      <Link className="marketing-secondary" href="/about">About us →</Link>
    </div></main>
    <section id="possibilities" className="marketing-features"><div><span>01 / CONNECT</span><h2>Your own starting point.</h2><p>A simple home for your ideas, ready to grow with you.</p></div><div><span>02 / ORGANIZE</span><h2>Make room for your work.</h2><p>Keep your account and everyday tools together in one clear space.</p></div><div><span>03 / GROW</span><h2>Build at your own pace.</h2><p>Start small and shape the application around what matters to you.</p></div></section>
    <footer><span>{branding.name}</span><Link href="/services">Our services →</Link></footer>
  </>;
}
