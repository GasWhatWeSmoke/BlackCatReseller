import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sizes=[16,32,48,64,128,256];

// Windows ICO directory followed by RGBA PNG frames; 0 encodes the 256px size.
// https://devblogs.microsoft.com/oldnewthing/20101022-00/?p=12473
function ico(frames){
  const directory=Buffer.alloc(6+16*frames.length);directory.writeUInt16LE(1,2);directory.writeUInt16LE(frames.length,4);
  let offset=directory.length;
  frames.forEach((frame,index)=>{
    const entry=6+index*16,size=sizes[index];directory[entry]=size===256?0:size;directory[entry+1]=directory[entry];
    directory.writeUInt16LE(1,entry+4);directory.writeUInt16LE(32,entry+6);
    directory.writeUInt32LE(frame.length,entry+8);directory.writeUInt32LE(offset,entry+12);offset+=frame.length;
  });
  return Buffer.concat([directory,...frames]);
}

export async function buildIcons(root=projectRoot){
  const css=await fs.readFile(path.join(root,'src/app/globals.css'),'utf8');
  const accent=/--accent:\s*(#[0-9a-f]{6})\s*;/i.exec(css)?.[1];
  if(!accent)throw Error('A six-digit --accent color is required for desktop icons.');
  const svg=async name=>Buffer.from((await fs.readFile(path.join(root,'assets/desktop',name+'.svg'),'utf8')).replaceAll('currentColor',accent));
  const [app,tray]=await Promise.all([svg('icon'),svg('tray')]);
  const png=(source,size)=>sharp(source).resize(size,size).ensureAlpha().png().toBuffer();
  const [icon,trayIcon,frames]=await Promise.all([png(app,512),png(tray,64),Promise.all(sizes.map(size=>png(app,size)))]);
  const outputs={'icon.png':icon,'tray.png':trayIcon,'icon.ico':ico(frames)};
  const directory=path.join(root,'build');await fs.mkdir(directory,{recursive:true});
  const written=[];
  for(const [name,bytes] of Object.entries(outputs)){
    const file=path.join(directory,name),previous=await fs.readFile(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(previous?.equals(bytes))continue;
    const temporary=file+'.'+randomUUID()+'.tmp';
    try {await fs.writeFile(temporary,bytes);await fs.rename(temporary,file);written.push(name);}
    finally {await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  return {files:Object.keys(outputs),written};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  buildIcons().then(result=>console.log(`Desktop icons ready (${result.written.length} updated).`)).catch(error=>{console.error(error);process.exitCode=1;});
}
