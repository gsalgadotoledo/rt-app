import Link from 'next/link';
import branding from '../../branding.json';
export default function Services() {
 return <>

  <main className="home"><div className="home-copy"><p className="eyebrow">OUR SERVICES</p><h1>Simple ideas. Thoughtful solutions.</h1><p className="description">From the first conversation to the final details, we help turn your next idea into something useful.</p><Link className="marketing-cta" href="/about">Get to know us →</Link><Link className="marketing-secondary" href="/">Back to home</Link></div></main>
  <section className="marketing-features"><div><span>01 / DISCOVER</span><h2>Find the right direction.</h2><p>Clarify your goals and focus on what matters most.</p></div><div><span>02 / CREATE</span><h2>Bring your idea to life.</h2><p>Shape a clear, useful experience around your needs.</p></div><div><span>03 / IMPROVE</span><h2>Keep moving forward.</h2><p>Learn, refine and make the next step a little better.</p></div></section>
  <footer><span>{branding.name}</span><Link href="/">Home →</Link></footer>
 </>;
}
