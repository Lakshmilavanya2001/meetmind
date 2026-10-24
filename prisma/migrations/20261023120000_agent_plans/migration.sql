-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('PROPOSED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'REJECTED', 'EXPIRED');

-- DropIndex

-- CreateTable
CREATE TABLE "AgentPlan" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'PROPOSED',
    "parentId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "decidedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentPlan_conversationId_idx" ON "AgentPlan"("conversationId");

-- CreateIndex
CREATE INDEX "AgentPlan_userId_status_idx" ON "AgentPlan"("userId", "status");

-- AddForeignKey
ALTER TABLE "AgentPlan" ADD CONSTRAINT "AgentPlan_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

