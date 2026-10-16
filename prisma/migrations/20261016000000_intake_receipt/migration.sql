CREATE TABLE IF NOT EXISTS "IntakeReceipt" (
  "jobId" TEXT NOT NULL PRIMARY KEY,
  "batchId" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "completed" BOOLEAN NOT NULL DEFAULT false,
  "summaryJson" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "IntakeReceipt_batchId_key" ON "IntakeReceipt"("batchId");
