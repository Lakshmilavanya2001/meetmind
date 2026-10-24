-- DropIndex

-- AlterTable
ALTER TABLE "TranscriptSegment" ADD COLUMN     "language" TEXT;

-- CreateTable
CREATE TABLE "SegmentTranslation" (
    "segmentId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentTranslation_pkey" PRIMARY KEY ("segmentId","language")
);

-- CreateIndex
CREATE INDEX "TranscriptSegment_meetingId_createdAt_idx" ON "TranscriptSegment"("meetingId", "createdAt");

-- AddForeignKey
ALTER TABLE "SegmentTranslation" ADD CONSTRAINT "SegmentTranslation_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "TranscriptSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

