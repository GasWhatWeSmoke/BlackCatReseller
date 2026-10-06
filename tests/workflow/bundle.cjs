const fs=require('fs'),path=require('path'),root=path.resolve(__dirname,'../..').replaceAll('\\','/'),out=path.resolve(process.argv[2]);
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {Toaster} from 'sonner';
import {Nav} from '${root}/src/components/Nav';import shell from '${root}/src/components/AppShell.module.css';
import Dashboard from '${root}/src/app/page';import {SurfaceMotion} from '${root}/src/components/SurfaceMotion';
import {DailyTheme} from '${root}/src/components/DailyTheme';import {AppearanceSettings} from '${root}/src/components/AppearanceSettings';
import {AmbientBackdrop} from '${root}/src/components/AmbientBackdrop';
import Review from '${root}/src/app/review/page';import Editor from '${root}/src/app/inventory/[id]/page';
import Ready from '${root}/src/components/DirectPublishPanel';import ReadyLayout from '${root}/src/app/ready/layout';
import Activity from '${root}/src/app/ready/activity/page';import Recovery from '${root}/src/components/RecoveryCenter';
import Sales from '${root}/src/app/sales/page';import Insights from '${root}/src/components/SalesInsights';import {InventoryBrowser} from '${root}/src/components/InventoryBrowser';
import {OrderReviews} from '${root}/src/components/OrderReviews';
import {listReviewCheckpoints} from '${root}/src/lib/reviewCheckpointStore';import {listItemDrafts} from '${root}/src/lib/itemDrafts';
const w=window as any;w.readCheckpoints=listReviewCheckpoints;w.readDrafts=listItemDrafts;w.frontendCalls=[];w.workflowReplies=[];
window.fetch=async(input:any,init:any={})=>{
 if(init.signal?.aborted)throw new DOMException('Superseded','AbortError');
 const url=new URL(String(input),location.origin),method=init.method||'GET';
 if(url.origin!==location.origin)throw Error('External request is not allowed in the workflow fixture');
 const body=typeof init.body==='string'?JSON.parse(init.body):null;
 w.frontendCalls.push({path:url.pathname,method});
 const result=await w.workflowCall({op:'request',args:{url:url.pathname+url.search,method,body}});
 if(!result.ok)throw Error(result.error);
 const value=result.data;if(method!=='GET')w.workflowReplies.push({path:url.pathname,body,ok:value?.ok??value?.body?.ok});const wrapped=value&&typeof value.status==='number'&&Object.hasOwn(value,'body');
 return Response.json(wrapped?value.body:value,{status:wrapped?value.status:200});
};
const pathname=location.pathname;
const content=pathname==='/settings'?<><h1 className="hub-title" style={{marginBottom:24}}>Appearance</h1><AppearanceSettings/></>:pathname==='/'?<Dashboard/>:pathname==='/review'?<Review/>:pathname.startsWith('/inventory/')?<Editor/>:pathname==='/inventory'?<InventoryBrowser/>:
 pathname==='/sales'?<Sales/>:pathname==='/sales/returns'?<OrderReviews/>:pathname==='/sales/insights'?<Insights/>:<ReadyLayout>{pathname==='/ready/activity'?<Activity/>:pathname==='/ready/recovery'?<Recovery/>:<Ready/>}</ReadyLayout>;
createRoot(document.getElementById('root')!).render(<><DailyTheme/><div className={shell.shell}><AmbientBackdrop/><Nav/><main className={shell.content}>{content}</main></div><SurfaceMotion/><Toaster/></>);
`;
fs.writeFileSync(path.join(out,'workflow.entry.tsx'),entry);
fs.writeFileSync(path.join(out,'navigation.cjs'),"exports.useParams=()=>({id:location.pathname.split('/').at(-1)});exports.usePathname=()=>location.pathname;exports.useRouter=()=>({push:href=>location.href=href});");
const wp=require(root+'/node_modules/next/dist/compiled/webpack/webpack');wp.init();
wp.webpack({mode:'development',devtool:false,entry:path.join(out,'workflow.entry.tsx'),output:{path:out,filename:'workflow.bundle.js'},resolve:{extensions:['.tsx','.ts','.js','.cjs'],alias:{'@':root+'/src','next/link':path.join(__dirname,'link.cjs'),'next/navigation':path.join(out,'navigation.cjs')},modules:[root+'/node_modules']},plugins:[new wp.webpack.DefinePlugin({'process.env.NEXT_PUBLIC_APP_VERSION':JSON.stringify('isolated-workflow')})],module:{rules:[{test:/\.tsx?$/,use:path.join(__dirname,'ts-loader.cjs')},{test:/\.css$/,use:path.join(__dirname,'css-loader.cjs')}]},},(error,stats)=>{if(error||stats.hasErrors()){console.error(error||stats.toString({all:false,errors:true}));process.exitCode=1;}else console.log('Actual workflow screens bundled for an isolated local-function fixture.');});
