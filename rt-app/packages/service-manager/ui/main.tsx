import './desktop.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ServiceManager,type ManagerClient} from './ServiceManager';
declare global {interface Window {rtAppServices:ManagerClient}}
createRoot(document.getElementById('root')!).render(<ServiceManager client={window.rtAppServices}/>);
