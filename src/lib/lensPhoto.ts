import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { isUnderManagedRoots } from './paths.ts';
import type { AppSettingsData } from './types';

type LensPhoto = { id:number; itemId:number|null; storedPath:string; rotation:number };

/** Read one managed snapshot; a reused ID or changed file cannot reuse its URL. */
export function readLensPhoto(photo:LensPhoto,settings:AppSettingsData) {
  if(!isUnderManagedRoots(photo.storedPath,settings))throw Error('This photo is outside the saved photo folders. Check its location before using Lens.');
  if(![0,90,180,270].includes(photo.rotation))throw Error('This photo has an invalid rotation. Correct it before using Lens.');
  let raw:Buffer;
  try { raw=fs.readFileSync(photo.storedPath); }
  catch { throw Error('This photo could not be read. Check its location and folder access before using Lens.'); }
  const hash=createHash('sha256').update(raw).digest('hex');
  const revision=JSON.stringify([photo.id,photo.itemId,path.resolve(photo.storedPath),hash,photo.rotation]);
  return {raw,rotation:photo.rotation,revision};
}

/** Public uploads must be decoded, resized and stripped of source metadata. */
export async function prepareLensPhoto(raw:Buffer,rotation:number):Promise<Buffer> {
  try {
    if(![0,90,180,270].includes(rotation))throw Error('Invalid rotation');
    return await sharp(raw).autoOrient().rotate(rotation)
      .resize(1280,1280,{fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer();
  } catch {
    throw Error('This photo could not be prepared safely for public upload. Replace or re-export it as a readable JPEG and retry; the original was not uploaded.');
  }
}
