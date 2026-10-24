-- Voice/video calling: call type, direct calls, ringing; user language + phone.
-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('VIDEO', 'VOICE');
-- CreateEnum
CREATE TYPE "RingStatus" AS ENUM ('RINGING', 'ACCEPTED', 'DECLINED', 'MISSED', 'CANCELED');
-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "callType" "CallType" NOT NULL DEFAULT 'VIDEO',
ADD COLUMN     "isDirectCall" BOOLEAN NOT NULL DEFAULT false;
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "preferredLanguage" TEXT NOT NULL DEFAULT 'en';
-- CreateTable
CREATE TABLE "CallRing" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "calleeId" TEXT NOT NULL,
    "status" "RingStatus" NOT NULL DEFAULT 'RINGING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallRing_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "CallRing_calleeId_status_expiresAt_idx" ON "CallRing"("calleeId", "status", "expiresAt");
-- CreateIndex
CREATE INDEX "CallRing_meetingId_idx" ON "CallRing"("meetingId");
-- AddForeignKey
ALTER TABLE "CallRing" ADD CONSTRAINT "CallRing_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CallRing" ADD CONSTRAINT "CallRing_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "CallRing" ADD CONSTRAINT "CallRing_calleeId_fkey" FOREIGN KEY ("calleeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
