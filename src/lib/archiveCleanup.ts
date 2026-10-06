import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AppSettingsData } from './types.ts';
import type { ArchivePreview,ArchiveResult } from './archiveCleanupView.ts';

type Settings=Pick<AppSettingsData,'dataRoot'|'archivePath'|'incomingPath'|'processingPath'|'needsReviewPath'|'readyPath'|'backupsPath'|'exportsPath'|'logsPath'|'pythonWorkerPath'>;
type Store=Pick<PrismaClient,'$transaction'>;
interface Context { projectRoot:string;databasePath:string }
interface Stamp { dev:string;ino:string;birth:string;mtime:string;ctime:string;size:string;links:string }
interface Candidate { file:string;relative:string;stamp:Stamp }
interface Plan { preview:ArchivePreview;root:Stamp|null;files:Candidate[];directories:{file:string;stamp:Stamp}[] }
export class ArchiveCleanupError extends Error { readonly status:number;constructor(message:string,status=409){super(message);this.status=status;} }
const key=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const contains=(root:string,file:string)=>{const relative=path.relative(key(root),key(file));return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
const rootKeys=['incomingPath','processingPath','needsReviewPath','readyPath','backupsPath','exportsPath','logsPath'] as const;
const stamp=async(file:string):Promise<Stamp>=>{const s=await fs.lstat(file,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),birth:String(s.birthtimeNs),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),size:String(s.size),links:String(s.nlink)};};
const same=(a:Stamp,b:Stamp)=>Object.keys(a).every(name=>a[name as keyof Stamp]===b[name as keyof Stamp]);
const sameIdentity=(a:Stamp,b:Stamp)=>a.dev===b.dev&&a.ino===b.ino&&a.birth===b.birth;
function absolute(value:unknown,label:string):string {
  if(typeof value!=='string'||!value||value!==value.trim()||!path.isAbsolute(value)||value.length>4096)throw new ArchiveCleanupError(`${label} must be a saved absolute path.`);
  return path.resolve(value);
}
async function realLocation(file:string):Promise<string>{
  let ancestor=file;
  for(;;){try{return path.resolve(await fs.realpath(ancestor),path.relative(ancestor,file));}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const parent=path.dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;
  }}
}
/** Never follow a linked ancestor, including a swapped directory during cleanup. */
async function plainPath(file:string,allowMissing=false):Promise<boolean>{
  const resolved=path.resolve(file),base=path.parse(resolved).root;
  let current=base;
  for(const part of path.relative(base,resolved).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try {const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw new ArchiveCleanupError('Linked archive paths are not eligible for cleanup.');}
    catch(error){if(allowMissing&&(error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  }
  if(key(await fs.realpath(resolved))!==key(resolved))throw new ArchiveCleanupError('The archive resolves to a different location. Check its saved path.');
  return true;
}
export async function validateArchiveTarget(settings:Settings,expected:unknown,context:Context):Promise<{root:string;exists:boolean}>{
  const root=absolute(settings.archivePath,'Archive location');
  if(absolute(expected,'Confirmed archive location')!==root)throw new ArchiveCleanupError('The saved archive location changed. Review it again.');
  if(key(root)===key(path.parse(root).root))throw new ArchiveCleanupError('A filesystem root cannot be cleared as an archive. Choose a dedicated archive folder.');
  const exists=await plainPath(root,true),real=await realLocation(root);
  if(exists&&!(await fs.lstat(root)).isDirectory())throw new ArchiveCleanupError('The archive location is not a directory.');
  for(const protectedRoot of [absolute(settings.dataRoot,'Data location'),absolute(context.projectRoot,'Application location'),os.homedir()])
    if(contains(root,protectedRoot)||contains(real,await realLocation(protectedRoot)))throw new ArchiveCleanupError('The archive location contains application or personal data. Choose a dedicated archive folder.');
  const protectedPaths=[...rootKeys.map(name=>absolute(settings[name],name)),absolute(context.databasePath,'Database location'),absolute(settings.pythonWorkerPath,'Worker location'),
    ...['src','electron','worker','scripts','config','node_modules','.next','.git','public'].map(name=>path.join(context.projectRoot,name)),
    ...[process.env.SystemRoot,process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter((value):value is string=>!!value)];
  for(const other of protectedPaths){const actual=await realLocation(other);if(contains(root,other)||contains(other,root)||contains(real,actual)||contains(actual,real))
    throw new ArchiveCleanupError('The archive overlaps a working, backup, database or application location. Save separate folders before cleanup.');}
  return {root,exists};
}
async function references(db:Store):Promise<string[]>{
  const values=await db.$transaction(async tx=>{
    const [photos,hashes,groups,problems]=await Promise.all([
      tx.photo.findMany({select:{storedPath:true,thumbPath:true}}),tx.fileHash.findMany({select:{processedPath:true}}),
      tx.collision.findMany({where:{status:'pending'},select:{incomingPhotosJson:true}}),tx.problemLog.findMany({where:{resolved:false},select:{photoPath:true}}),
    ]);
    const result:unknown[]=[...photos.flatMap(row=>[row.storedPath,row.thumbPath]),...hashes.map(row=>row.processedPath),...problems.map(row=>row.photoPath)];
    for(const group of groups){const rows:unknown=JSON.parse(group.incomingPhotosJson);if(!Array.isArray(rows))throw Error('Invalid unresolved photos');
      for(const row of rows){if(!row||typeof row!=='object'||typeof row.storedPath!=='string')throw Error('Invalid unresolved photos');result.push(row.storedPath,row.thumbPath);}}
    return result.filter(value=>value!==null&&value!==undefined&&value!=='').map(value=>absolute(value,'Photo reference'));
  });
  const result:string[]=[],unique=[...new Set(values)];let next=0;
  await Promise.all(Array.from({length:Math.min(12,unique.length)},async()=>{while(next<unique.length){const file=unique[next++];result.push(key(file),key(await realLocation(file)));}}));
  return [...new Set(result)];
}
async function photoFile(file:string):Promise<boolean>{
  const extension=path.extname(file).toLowerCase();if(!['.jpg','.jpeg','.png','.webp'].includes(extension))return false;
  const handle=await fs.open(file,'r');try{const buffer=Buffer.alloc(12),{bytesRead}=await handle.read(buffer,0,12,0);
    if(extension==='.jpg'||extension==='.jpeg')return bytesRead>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255;
    if(extension==='.png')return bytesRead>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    return bytesRead===12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';
  }finally{await handle.close();}
}
async function inspect(db:Store,settings:Settings,expected:unknown,context:Context):Promise<Plan>{
  const target=await validateArchiveTarget(settings,expected,context),root=target.exists?await stamp(target.root):null;
  const protectedPaths=await references(db),files:Candidate[]=[],directories:Plan['directories']=[],kept:{path:string;reason:string}[]=[];
  const protectedSet=new Set(protectedPaths),rootProtected=protectedPaths.some(reference=>contains(reference,target.root));
  const referenced=(file:string)=>{if(rootProtected)return true;let current=file;while(contains(target.root,current)){if(protectedSet.has(key(current)))return true;const parent=path.dirname(current);if(parent===current)break;current=parent;}return false;};
  const stack=target.exists?[{file:target.root,depth:0}]:[];let seen=0;
  while(stack.length){const directory=stack.pop()!;if(directory.depth>128)throw new ArchiveCleanupError('The archive directory structure is too deep to verify safely.');
    await plainPath(directory.file);
    const entries=await fs.readdir(directory.file,{withFileTypes:true});
    for(const entry of entries){if(++seen>500000)throw new ArchiveCleanupError('The archive is too large for one verified cleanup. Split older backups into separate archive folders first.');
      const file=path.join(directory.file,entry.name),relative=path.relative(target.root,file);if(!contains(target.root,file)||file===target.root)throw new ArchiveCleanupError('An archive entry escaped its folder.');
      const info=await fs.lstat(file);
      if(info.isSymbolicLink()){kept.push({path:relative,reason:'Linked entry kept'});continue;}
      if(referenced(file)){kept.push({path:relative,reason:'Referenced by inventory or unresolved work'});continue;}
      if(info.isDirectory()){directories.push({file,stamp:await stamp(file)});stack.push({file,depth:directory.depth+1});continue;}
      if(!info.isFile()||info.nlink!==1){kept.push({path:relative,reason:'Non-regular or shared file kept'});continue;}
      if(!await photoFile(file)){kept.push({path:relative,reason:'Unsupported or unrecognized photo file kept'});continue;}
      files.push({file,relative,stamp:await stamp(file)});
    }
  }
  files.sort((a,b)=>a.relative.localeCompare(b.relative));kept.sort((a,b)=>a.path.localeCompare(b.path));directories.sort((a,b)=>a.file.localeCompare(b.file));
  const roots=Object.fromEntries(['dataRoot','archivePath',...rootKeys,'pythonWorkerPath'].map(name=>[name,settings[name as keyof Settings]]));
  const token=createHash('sha256').update(JSON.stringify({roots,context,path:target.root,root,files,kept,directories})).digest('hex');
  const bytes=files.reduce((sum,file)=>sum+Number(file.stamp.size),0);if(!Number.isSafeInteger(bytes))throw new ArchiveCleanupError('Archive size could not be verified.');
  return {root,files,directories,preview:{kind:'preview',path:target.root,requestedPath:String(expected),token,files:files.length,bytes,retained:kept.length,missing:!target.exists,examples:files.slice(0,20).map(row=>row.relative),retainedExamples:kept.slice(0,20)}};
}
export async function previewArchiveCleanup(db:Store,settings:Settings,expected:unknown,context:Context):Promise<ArchivePreview>{return (await inspect(db,settings,expected,context)).preview;}
export async function applyArchiveCleanup(db:Store,settings:Settings,expected:unknown,token:unknown,context:Context,remove:(file:string)=>Promise<void>=fs.unlink):Promise<ArchiveResult>{
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new ArchiveCleanupError('Review the archive before deleting files.',400);
  const plan=await inspect(db,settings,expected,context);
  if(plan.preview.token!==token)throw new ArchiveCleanupError('The archive, its references or saved paths changed. Review a fresh preview; no files were removed.');
  const result:ArchiveResult={kind:'result',path:plan.preview.path,token,requested:plan.files.length,removed:0,missing:0,changed:0,failed:0,bytesRemoved:0,retained:plan.preview.retained,notes:[]};
  const note=(file:string,reason:string)=>{if(result.notes.length<20)result.notes.push({path:file,reason});};
  for(const file of plan.files){
    try{
      if(!plan.root||!sameIdentity(plan.root,await stamp(plan.preview.path))||!await plainPath(file.file)||!contains(plan.preview.path,file.file)||!same(file.stamp,await stamp(file.file))){result.changed++;note(file.relative,'Changed since the preview; kept');continue;}
      await remove(file.file);result.removed++;result.bytesRemoved+=Number(file.stamp.size);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){result.missing++;note(file.relative,'Already absent; not counted as deleted');}
      else if(error instanceof ArchiveCleanupError){result.changed++;note(file.relative,'Location changed or linked; kept');}
      else{result.failed++;note(file.relative,'Removal failed or could not be confirmed');}}
  }
  if(!plan.files.length)return result;
  for(const directory of plan.directories.sort((a,b)=>b.file.length-a.file.length)){
    try{if(plan.root&&sameIdentity(plan.root,await stamp(plan.preview.path))&&await plainPath(directory.file)&&sameIdentity(directory.stamp,await stamp(directory.file)))await fs.rmdir(directory.file);}catch{/* Only verified empty folders may be removed. */}
  }
  return result;
}
export async function runArchiveCleanup(deps:{db:Store;settings:()=>Promise<Settings>;reserve:()=>boolean;release:()=>void;context:Context},input:unknown):Promise<ArchivePreview|ArchiveResult>{
  const request=input as {action?:unknown;expectedArchivePath?:unknown;token?:unknown}|null;
  if(!request||typeof request.action!=='string'||!['preview','apply'].includes(request.action))throw new ArchiveCleanupError('Review the archive before choosing cleanup.',400);
  if(!deps.reserve())throw new ArchiveCleanupError('Photo operations are active. Wait for them to finish before archive cleanup.');
  try{const settings=await deps.settings();return request.action==='preview'?await previewArchiveCleanup(deps.db,settings,request.expectedArchivePath,deps.context):await applyArchiveCleanup(deps.db,settings,request.expectedArchivePath,request.token,deps.context);}
  finally{deps.release();}
}
