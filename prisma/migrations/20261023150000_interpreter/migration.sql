-- DropIndex

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "interpretationEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MeetingParticipant" ADD COLUMN     "callLanguage" TEXT;

-- CreateTable
CREATE TABLE "InterpretationEvent" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "segmentId" TEXT,
    "speakerUserId" TEXT,
    "sourceLanguage" TEXT NOT NULL,
    "targetLanguage" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "translatedText" TEXT NOT NULL,
    "speechEndAt" TIMESTAMP(3) NOT NULL,
    "asrMs" INTEGER NOT NULL,
    "mtMs" INTEGER NOT NULL,
    "ttsMs" INTEGER NOT NULL,
    "queueMs" INTEGER NOT NULL,
    "totalMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterpretationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterpretationEvent_meetingId_createdAt_idx" ON "InterpretationEvent"("meetingId", "createdAt");

-- AddForeignKey
ALTER TABLE "InterpretationEvent" ADD CONSTRAINT "InterpretationEvent_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

