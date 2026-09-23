import {publicConfig} from '@gsalgadotoledo/rt-app-config';
import SiteHeader from './site-header';
import branding from '../branding.json';
import type {Metadata} from 'next';
import './style.css';
export const metadata:Metadata={title:branding.name,description:'Your ideas. Your workspace.'};
export default function Layout({children}:{children:React.ReactNode}) {return <html lang="en"><body><div className="site-shell"><SiteHeader config={publicConfig()}/>{children}</div></body></html>;}
