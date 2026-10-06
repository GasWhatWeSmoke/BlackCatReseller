import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupFiles, backupHealth, recordBackupHealth } from "./backupHealth.ts";
test("backup health keeps the last success after failure and orders actual file times",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"blackcat-backups-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  recordBackupHealth(root,{lastSuccessAt:"2026-01-01",lastError:null});recordBackupHealth(root,{lastError:"Disk full"});assert.equal(backupHealth(root).lastSuccessAt,"2026-01-01");assert.equal(backupHealth(root).lastError,"Disk full");
  fs.writeFileSync(path.join(root,"black-cat-old-special.db"),"");fs.utimesSync(path.join(root,"black-cat-old-special.db"),1,1);
  fs.writeFileSync(path.join(root,"black-cat-2026-09-14.db"),"");assert.equal(backupFiles(root)[0].name,"black-cat-2026-09-14.db");
});
