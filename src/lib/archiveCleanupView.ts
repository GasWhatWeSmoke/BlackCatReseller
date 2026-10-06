export interface ArchivePreview { kind:'preview';path:string;requestedPath:string;token:string;files:number;bytes:number;retained:number;missing:boolean;examples:string[];retainedExamples:{path:string;reason:string}[] }
export interface ArchiveResult { kind:'result';path:string;token:string;requested:number;removed:number;missing:number;changed:number;failed:number;bytesRemoved:number;retained:number;notes:{path:string;reason:string}[] }
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const notes=(value:unknown)=>Array.isArray(value)&&value.length<=20&&value.every(row=>row&&typeof row.path==='string'&&typeof row.reason==='string');
export function archivePreview(value:unknown):ArchivePreview {
  const data=value as ArchivePreview;
  if(!data||data.kind!=='preview'||typeof data.path!=='string'||!data.path||typeof data.requestedPath!=='string'||!data.requestedPath||typeof data.token!=='string'||!/^[a-f0-9]{64}$/.test(data.token)
    ||![data.files,data.bytes,data.retained].every(count)||typeof data.missing!=='boolean'
    ||!Array.isArray(data.examples)||data.examples.length!==Math.min(20,data.files)||data.examples.some(path=>typeof path!=='string')||!notes(data.retainedExamples)||data.retainedExamples.length!==Math.min(20,data.retained))
    throw Error('The archive preview is incomplete. Review it again before deleting files.');
  return data;
}
export function archiveResult(value:unknown,preview:ArchivePreview):ArchiveResult {
  const data=value as ArchiveResult;
  if(!data||data.kind!=='result'||data.path!==preview.path||data.token!==preview.token||data.requested!==preview.files
    ||![data.requested,data.removed,data.missing,data.changed,data.failed,data.bytesRemoved,data.retained].every(count)
    ||data.removed+data.missing+data.changed+data.failed!==data.requested||data.bytesRemoved>preview.bytes||data.retained!==preview.retained||!notes(data.notes))
    throw Error('Archive cleanup could not be confirmed. Review the remaining files before trying again.');
  return data;
}
