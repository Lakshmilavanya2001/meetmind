/**
 * Development seed. Idempotent: safe to run repeatedly.
 * Creates a demo workspace with deliberately ambiguous names (two "Rahul Sharma"s, a "Rahul Verma")
 * to exercise disambiguation, plus a second workspace to exercise cross-tenant isolation.
 *
 * All demo accounts use the password in SEED_PASSWORD (default: "MeetMind#2026"). Development only.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type OrgRole } from "../src/generated/prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo accounts in production.");
  process.exit(1);
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const PASSWORD = process.env.SEED_PASSWORD ?? "MeetMind#2026";

type SeedUser = { email: string; displayName: string; title?: string; department?: string; timezone: string; role: OrgRole };

const WORKSPACES: { name: string; slug: string; joinCode: string; users: SeedUser[] }[] = [
  {
    name: "Acme Corp",
    slug: "acme-corp",
    joinCode: "acme-demo",
    users: [
      { email: "aisha@acme.test", displayName: "Aisha Khan", title: "Engineering Manager", department: "Platform", timezone: "Asia/Kolkata", role: "OWNER" },
      { email: "rahul.sharma@acme.test", displayName: "Rahul Sharma", title: "Backend Engineer", department: "Platform", timezone: "Asia/Kolkata", role: "MEMBER" },
      { email: "rahul.s@acme.test", displayName: "Rahul Sharma", title: "Product Designer", department: "Design", timezone: "Europe/London", role: "MEMBER" },
      { email: "rahul.verma@acme.test", displayName: "Rahul Verma", title: "QA Lead", department: "Quality", timezone: "Asia/Kolkata", role: "MEMBER" },
      { email: "priya@acme.test", displayName: "Priya Patel", title: "Product Manager", department: "Product", timezone: "America/New_York", role: "ADMIN" },
      { email: "amit@acme.test", displayName: "Amit Kumar", title: "Frontend Engineer", department: "Platform", timezone: "Asia/Kolkata", role: "MEMBER" },
    ],
  },
  {
    name: "Globex",
    slug: "globex",
    joinCode: "globex-demo",
    users: [
      { email: "hank@globex.test", displayName: "Hank Scorpio", title: "CEO", timezone: "America/Los_Angeles", role: "OWNER" },
      { email: "rahul@globex.test", displayName: "Rahul Mehta", title: "Consultant", timezone: "Asia/Kolkata", role: "MEMBER" },
    ],
  },
];

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  for (const ws of WORKSPACES) {
    const org = await db.organization.upsert({
      where: { slug: ws.slug },
      update: {},
      create: { name: ws.name, slug: ws.slug, joinCode: ws.joinCode },
    });
    for (const u of ws.users) {
      const { role, ...profile } = u;
      const user = await db.user.upsert({
        where: { email: u.email },
        update: {},
        create: { ...profile, passwordHash },
      });
      await db.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
        update: {},
        create: { organizationId: org.id, userId: user.id, role },
      });
    }
    console.log(`✓ ${ws.name}: ${ws.users.length} users (join code: ${ws.joinCode})`);
  }
  console.log(`Demo password for all accounts: ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
