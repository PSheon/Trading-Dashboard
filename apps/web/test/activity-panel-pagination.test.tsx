// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ActivityPanel } from '@/components/copy/activity-panel';
import { I18nProvider } from '@/i18n/provider';
import { catalogs } from '@/i18n/messages';
import { actionsFeed } from '@/fixtures/data';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh(){}})}));
vi.mock('@/lib/auth',()=>({useAuth:()=>({status:'signedIn',identity:'owner'})}));
vi.mock('@/lib/copy',()=>({useCopyOverview:()=>({data:{strategies:[]}}),useCopyEvents:()=>({data:{items:Array.from({length:23},(_,i)=>({id:String(i+1),strategyId:1,type:'funds_added',payload:{amount:10},createdAt:'2026-10-07T00:00:00Z'}))}})}));
vi.mock('@/lib/queries',()=>({useActions:()=>({data:Array.from({length:23},(_,i)=>({...actionsFeed()[0],id:String(i+1)}))})}));
vi.mock('@/lib/wallet',()=>({useWalletHistory:()=>({data:{address:'owner',transfers:Array.from({length:23},(_,i)=>({kind:'deposit',hash:String(i),time:'2026-10-07T00:00:00Z',amount:10}))}})}));
vi.mock('@/components/copy/copy-portfolio',()=>({useLeaders:()=>new Map()}));

it('pages copy, following and deposit activity at ten rows each',async ()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
  try {
    await act(async ()=>root.render(<I18nProvider locale="en" messages={catalogs.en}><ActivityPanel open onClose={()=>{}} /></I18nProvider>));
    for(const i of [0,1,2]) {
      await act(async ()=>document.querySelectorAll<HTMLButtonElement>('[role=tab]')[i].click());
      expect(document.querySelectorAll('[data-slot=data-list] > li')).toHaveLength(10);
      const pager=document.querySelector('[data-pager]')!;
      expect(pager).not.toBeNull();
      await act(async ()=>pager.querySelectorAll<HTMLButtonElement>('button')[1].click());
      expect(pager.textContent).toContain('Page 2');
    }
  } finally {await act(async ()=>root.unmount());el.remove();}
});
