-- CreateTable
CREATE TABLE "Item" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sku" TEXT NOT NULL,
    "originalQrValue" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Photographed',
    "brand" TEXT NOT NULL DEFAULT 'Unknown',
    "size" TEXT,
    "itemType" TEXT,
    "color" TEXT,
    "pattern" TEXT,
    "weightOz" INTEGER,
    "whenMade" TEXT,
    "department" TEXT,
    "material" TEXT,
    "style" TEXT,
    "secondaryColor" TEXT,
    "fit" TEXT,
    "description" TEXT,
    "tertiaryColor" TEXT,
    "closure" TEXT,
    "neckline" TEXT,
    "lining" TEXT,
    "graphics" TEXT,
    "keyDetails" TEXT,
    "aesthetic" TEXT,
    "condition" TEXT,
    "niftyTitle" TEXT,
    "etsyEligible" TEXT DEFAULT 'none',
    "trueVintage" BOOLEAN NOT NULL DEFAULT false,
    "inseam" TEXT,
    "chestIn" TEXT,
    "lengthIn" TEXT,
    "sleeveIn" TEXT,
    "shoulderIn" TEXT,
    "waistIn" TEXT,
    "hipIn" TEXT,
    "riseIn" TEXT,
    "aiFields" TEXT,
    "aiRaw" TEXT,
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "processingFolderPath" TEXT,
    "readyFolderPath" TEXT,
    "niftyStatus" TEXT NOT NULL DEFAULT 'Not Uploaded',
    "listedPrice" REAL,
    "salePrice" REAL,
    "platformSold" TEXT,
    "itemCost" REAL,
    "marketplaceFees" REAL,
    "feesEstimated" BOOLEAN NOT NULL DEFAULT false,
    "shippingCost" REAL,
    "shippingEstimated" BOOLEAN NOT NULL DEFAULT false,
    "listingUrl" TEXT,
    "finalTitle" TEXT,
    "finalPrice" REAL,
    "earningsReady" BOOLEAN NOT NULL DEFAULT false,
    "datePhotographed" DATETIME,
    "dateListed" DATETIME,
    "dateSold" DATETIME,
    "notes" TEXT,
    "publicNotes" TEXT,
    "batchId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Item_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "itemId" INTEGER,
    "originalFilename" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "thumbPath" TEXT,
    "sha256" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCover" BOOLEAN NOT NULL DEFAULT false,
    "isMarker" BOOLEAN NOT NULL DEFAULT false,
    "includeInListing" BOOLEAN NOT NULL DEFAULT true,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "decodedValue" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "exifDateTimeOriginal" TEXT,
    "exifSubSec" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Photo_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileHash" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sha256" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "processedPath" TEXT,
    "sku" TEXT,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "data" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Vocabulary" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "itemsCreated" INTEGER NOT NULL DEFAULT 0,
    "photosProcessed" INTEGER NOT NULL DEFAULT 0,
    "duplicatesSkipped" INTEGER NOT NULL DEFAULT 0,
    "problems" INTEGER NOT NULL DEFAULT 0,
    "collisions" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "summaryJson" TEXT
);

-- CreateTable
CREATE TABLE "ProblemLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "batchId" INTEGER,
    "type" TEXT NOT NULL,
    "sku" TEXT,
    "photoPath" TEXT,
    "message" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProblemLog_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Collision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "batchId" INTEGER,
    "sku" TEXT NOT NULL,
    "existingItemId" INTEGER,
    "incomingPhotosJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId" INTEGER,
    "sku" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Item_sku_key" ON "Item"("sku");

-- CreateIndex
CREATE INDEX "Item_status_idx" ON "Item"("status");

-- CreateIndex
CREATE INDEX "Item_brand_idx" ON "Item"("brand");

-- CreateIndex
CREATE INDEX "Item_batchId_idx" ON "Item"("batchId");

-- CreateIndex
CREATE INDEX "Photo_itemId_idx" ON "Photo"("itemId");

-- CreateIndex
CREATE INDEX "Photo_sha256_idx" ON "Photo"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "FileHash_sha256_key" ON "FileHash"("sha256");

-- CreateIndex
CREATE INDEX "Vocabulary_type_idx" ON "Vocabulary"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Vocabulary_type_value_key" ON "Vocabulary"("type", "value");

-- CreateIndex
CREATE INDEX "ProblemLog_batchId_idx" ON "ProblemLog"("batchId");

-- CreateIndex
CREATE INDEX "ProblemLog_resolved_idx" ON "ProblemLog"("resolved");

-- CreateIndex
CREATE INDEX "Collision_status_idx" ON "Collision"("status");

-- CreateIndex
CREATE INDEX "SyncLog_runAt_idx" ON "SyncLog"("runAt");

-- CreateIndex
CREATE INDEX "SyncLog_itemId_idx" ON "SyncLog"("itemId");
