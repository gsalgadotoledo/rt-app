'use client';
import {useEffect} from 'react';
import {trackPage} from '@gsalgadotoledo/rt-app-observer/browser';
import {browserApiUrl} from '@gsalgadotoledo/rt-app-config';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import type {PublicConfig} from '@gsalgadotoledo/rt-app-config';
import branding from '../branding.json';
import Account from './account';
export default function SiteHeader({config}:{config:PublicConfig}) {
 const pathname=usePathname();
 useEffect(()=>{trackPage(browserApiUrl(config),'ssr',pathname);},[pathname,config]);
 return <header className="topbar"><Link className="brand" href="/">{branding.name}</Link><div className="site-navigation"><nav aria-label="Pages">{[['/','Home'],['/about','About'],['/services','Services']].map(([href,label])=><Link key={href} href={href} aria-current={pathname===href?'page':undefined}>{label}</Link>)}</nav><Account config={config}/></div></header>;
}
