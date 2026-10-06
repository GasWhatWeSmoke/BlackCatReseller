import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildIcons } from './build-icons.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackcat-icons-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('blackcat-icons-'));await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'assets/desktop'),{recursive:true});await fs.mkdir(path.join(root,'src/app'),{recursive:true});
  for(const name of ['icon','tray'])await fs.copyFile(path.join(source,'assets/desktop',name+'.svg'),path.join(root,'assets/desktop',name+'.svg'));
  await fs.writeFile(path.join(root,'src/app/globals.css'),':root { --accent: #112233; }');
  return root;
}

test('a fresh build generates visible transparent PNGs and six decodable RGBA Windows icon frames from tracked sources',async t=>{
  const root=await fixture(t),original=await fs.readFile(path.join(root,'assets/desktop/icon.svg'));
  const result=await buildIcons(root);assert.deepEqual(result.written,['icon.png','tray.png','icon.ico']);
  for(const [name,size] of [['icon.png',512],['tray.png',64]]){
    const file=path.join(root,'build',name),metadata=await sharp(file).metadata();
    assert.equal(metadata.width,size);assert.equal(metadata.height,size);assert.equal(metadata.channels,4);
    const pixels=await sharp(file).raw().toBuffer();let transparent=0,accent=0;
    for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]===0)transparent++;if(pixels[i]===17&&pixels[i+1]===34&&pixels[i+2]===51&&pixels[i+3]===255)accent++;}
    assert.ok(transparent>0);assert.ok(accent>0,`${name} must contain the configured accent`);
  }
  const ico=await fs.readFile(path.join(root,'build/icon.ico'));assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),6);
  const decoded=[];let end=102;
  for(let index=0;index<6;index++){
    const entry=6+index*16,offset=ico.readUInt32LE(entry+12),length=ico.readUInt32LE(entry+8);assert.equal(offset,end);assert.ok(length>0);end=offset+length;assert.ok(end<=ico.length);
    assert.equal(ico.readUInt16LE(entry+4),1);assert.equal(ico.readUInt16LE(entry+6),32);
    const image=await sharp(ico.subarray(offset,end)).metadata();assert.equal(image.format,'png');assert.equal(image.channels,4);
    assert.equal(image.width,ico[entry]||256);assert.equal(image.height,ico[entry+1]||256);decoded.push(image.width);
  }
  assert.deepEqual(decoded,[16,32,48,64,128,256]);assert.equal(end,ico.length);
  assert.deepEqual(await fs.readFile(path.join(root,'assets/desktop/icon.svg')),original);
});

test('unchanged icons keep their timestamps, a missing icon is rebuilt, and invalid input preserves previous outputs',async t=>{
  const root=await fixture(t);await buildIcons(root);const names=['icon.png','tray.png','icon.ico'];
  const before=await Promise.all(names.map(async name=>({name,bytes:await fs.readFile(path.join(root,'build',name)),stat:await fs.stat(path.join(root,'build',name),{bigint:true})})));
  assert.deepEqual((await buildIcons(root)).written,[]);
  for(const entry of before)assert.equal((await fs.stat(path.join(root,'build',entry.name),{bigint:true})).mtimeNs,entry.stat.mtimeNs);
  await fs.unlink(path.join(root,'build/tray.png'));assert.deepEqual((await buildIcons(root)).written,['tray.png']);
  await fs.writeFile(path.join(root,'assets/desktop/tray.svg'),'not an SVG');await assert.rejects(buildIcons(root));
  for(const entry of before)assert.deepEqual(await fs.readFile(path.join(root,'build',entry.name)),entry.bytes);
  assert.deepEqual((await fs.readdir(path.join(root,'build'))).sort(),names.sort());
  await fs.writeFile(path.join(root,'src/app/globals.css'),':root {}');await assert.rejects(buildIcons(root),/accent/);
});
