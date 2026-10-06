import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { readLensPhoto, prepareLensPhoto } from './lensPhoto.ts';
import type { AppSettingsData } from './types';

function fixture(t: { after: (fn: () => void) => void }) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackcat-lens-photo-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const managed=path.join(root,'photos');fs.mkdirSync(managed);
  const settings={processingPath:managed,readyPath:managed,archivePath:managed,needsReviewPath:managed,incomingPath:managed,exportsPath:managed} as AppSettingsData;
  const photo={id:1,itemId:1,storedPath:path.join(managed,'photo.jpg'),rotation:0};
  return {root,managed,settings,photo};
}

test('public Lens preparation rejects invalid image bytes instead of returning the source',async()=>{
  await assert.rejects(prepareLensPhoto(Buffer.from('private fixture bytes that are not an image'),0),/original was not uploaded/);
  await assert.rejects(prepareLensPhoto(Buffer.alloc(0),90),/original was not uploaded/);
});

test('Lens images apply EXIF and reviewed rotation, bound dimensions, and remove metadata',async()=>{
  const raw=await sharp({create:{width:1600,height:800,channels:3,background:'#3188aa'}})
    .jpeg().withMetadata({orientation:6}).withExif({IFD0:{ImageDescription:'private fixture metadata'}}).toBuffer();
  assert.ok((await sharp(raw).metadata()).exif);
  const output=await prepareLensPhoto(raw,90), metadata=await sharp(output).metadata();
  assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,1280);assert.equal(metadata.height,640);
  assert.equal(metadata.exif,undefined);assert.equal(metadata.orientation,undefined);assert.equal(metadata.icc,undefined);
  assert.equal(output.includes(Buffer.from('private fixture metadata')),false);
});

test('Lens refuses outside and junction-escaped files before reading image bytes',t=>{
  const h=fixture(t), outside=path.join(h.root,'outside');fs.mkdirSync(outside);
  const privateFile=path.join(outside,'private.jpg');fs.writeFileSync(privateFile,'private fixture');
  assert.throws(()=>readLensPhoto({...h.photo,storedPath:privateFile},h.settings),/outside the saved photo folders/);
  const linked=path.join(h.managed,'linked');fs.symlinkSync(outside,linked,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>readLensPhoto({...h.photo,storedPath:path.join(linked,'private.jpg')},h.settings),/outside the saved photo folders/);
});

test('Lens cache identity changes for content, ownership, path and reviewed rotation',t=>{
  const h=fixture(t);fs.writeFileSync(h.photo.storedPath,'first fixture');
  const original=readLensPhoto(h.photo,h.settings), stat=fs.statSync(h.photo.storedPath);
  assert.equal(readLensPhoto(h.photo,h.settings).revision,original.revision);
  fs.writeFileSync(h.photo.storedPath,'other fixture');fs.utimesSync(h.photo.storedPath,stat.atime,stat.mtime);
  assert.notEqual(readLensPhoto(h.photo,h.settings).revision,original.revision,'Actual content detects replacement even when size and timestamps match');
  fs.writeFileSync(h.photo.storedPath,'first fixture');
  assert.notEqual(readLensPhoto({...h.photo,rotation:90},h.settings).revision,original.revision);
  assert.notEqual(readLensPhoto({...h.photo,itemId:2},h.settings).revision,original.revision);
  const relocated=path.join(h.managed,'relocated.jpg');fs.copyFileSync(h.photo.storedPath,relocated);
  assert.notEqual(readLensPhoto({...h.photo,storedPath:relocated},h.settings).revision,original.revision);
});

test('missing files and invalid rotations produce actionable errors',t=>{
  const h=fixture(t);
  assert.throws(()=>readLensPhoto(h.photo,h.settings),/could not be read/);
  fs.writeFileSync(h.photo.storedPath,'fixture');
  assert.throws(()=>readLensPhoto({...h.photo,rotation:45},h.settings),/invalid rotation/);
});
