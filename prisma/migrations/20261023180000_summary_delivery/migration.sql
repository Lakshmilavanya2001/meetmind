-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SENT', 'OUTBOX', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "summaryEmail" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "summarySms" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Recording" ADD COLUMN     "chunkCount" INTEGER,
ADD COLUMN     "language" TEXT;

-- CreateTable
CREATE TABLE "SummaryDelivery" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SummaryDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "SmsStatus" NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SummaryDelivery_meetingId_createdAt_idx" ON "SummaryDelivery"("meetingId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailMessage_userId_createdAt_idx" ON "EmailMessage"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "SummaryDelivery" ADD CONSTRAINT "SummaryDelivery_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SummaryDelivery" ADD CONSTRAINT "SummaryDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

