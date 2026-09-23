import React, {useEffect, useId, useRef, useState} from 'react';
import {currencyCodes} from '@gsalgadotoledo/rt-app-subscriptions/currency';
const english=new Intl.DisplayNames(['en'],{type:'currency'}), spanish=new Intl.DisplayNames(['es'],{type:'currency'});
const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const options=currencyCodes.map(code=>({code,name:english.of(code.toUpperCase())??code,search:normalize(`${code} ${english.of(code.toUpperCase())} ${spanish.of(code.toUpperCase())}`)}));
export function CurrencyPicker({value,onChange}:{value:string;onChange:(code:string)=>void}) {
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0);
 const id=useId(),root=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const matches=options.filter(o=>o.search.includes(normalize(query.trim())));
 useEffect(()=>{if(open) input.current?.focus();},[open]);
 useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
 useEffect(()=>{if(open) document.getElementById(`${id}-${active}`)?.scrollIntoView({block:'nearest'});},[active,open,id]);
 const choose=(code:string)=>{onChange(code);setOpen(false);trigger.current?.focus();};
 return <div ref={root} className="currency-picker" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
  <span id={`${id}-label`}>Currency</span>
  <button type="button" ref={trigger} className="currency-trigger" aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="listbox" aria-expanded={open} onClick={()=>{setOpen(!open);setQuery('');setActive(0);}}><span id={`${id}-value`}>{value.toUpperCase()} · {english.of(value.toUpperCase())}</span><span aria-hidden="true">⌄</span></button>
  {open && <div className="currency-popup"><input ref={input} role="combobox" aria-label="Search currencies" aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list" aria-activedescendant={matches[active]?`${id}-${active}`:undefined} placeholder="Search name or code…" value={query} onChange={e=>{setQuery(e.target.value);setActive(0);}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setOpen(false);trigger.current?.focus();}else if(e.key==='ArrowDown'){e.preventDefault();setActive(i=>Math.min(i+1,matches.length-1));}else if(e.key==='ArrowUp'){e.preventDefault();setActive(i=>Math.max(0,i-1));}else if(e.key==='Enter'){e.preventDefault();if(matches[active])choose(matches[active].code);}}}/>
   <div className="currency-options" id={`${id}-options`} role="listbox" aria-label="Currencies">{matches.map((o,i)=><button type="button" tabIndex={-1} role="option" id={`${id}-${i}`} key={o.code} aria-selected={o.code===value} className={i===active?'highlighted':''} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(o.code)}><strong>{o.code.toUpperCase()}</strong><span>{o.name}</span>{o.code===value&&<span aria-hidden="true">✓</span>}</button>)}{!matches.length&&<p role="status">No currencies found</p>}</div>
  </div>}
 </div>;
}
