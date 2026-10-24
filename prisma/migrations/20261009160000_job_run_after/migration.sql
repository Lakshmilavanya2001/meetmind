-- Retry back-off for transcription jobs.
DROP INDEX "TranscriptionJob_status_createdAt_idx";
-- AlterTable
ALTER TABLE "TranscriptionJob" ADD COLUMN     "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- CreateIndex
CREATE INDEX "TranscriptionJob_status_runAfter_idx" ON "TranscriptionJob"("status", "runAfter");
