import type { Metadata } from "next";
import { requireAuth } from "@/server/auth/current";
import { getProfile } from "@/server/services/profile";
import { PageHeader } from "@/components/common/page-header";
import { ProfileForm, PasswordForm } from "./profile-forms";
import { PhoneCard, SummaryPrefsCard } from "./phone-card";
import { canTextUser, isSmsAvailable } from "@/server/services/sms";
import { getUberStatus } from "@/server/services/uber";
import { UberCard } from "./uber-card";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  const ctx = await requireAuth();
  const [profile, uber] = await Promise.all([getProfile(ctx), getUberStatus(ctx)]);
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <PageHeader title="Profile" description="How colleagues find you, and the time zone used for scheduling." />
      <ProfileForm
        initial={{
          displayName: profile.displayName,
          email: profile.email,
          title: profile.title ?? "",
          department: profile.department ?? "",
          timezone: profile.timezone,
          preferredLanguage: profile.preferredLanguage,
          phoneNumber: profile.phoneNumber ?? "",
          phoneVerified: !!profile.phoneVerifiedAt,
        }}
      />
      <PhoneCard key={`${profile.phoneNumber}:${canTextUser(profile)}:${profile.smsReminders}`} available={isSmsAvailable()} phone={profile.phoneNumber} verified={canTextUser(profile)} smsReminders={profile.smsReminders} />
      <SummaryPrefsCard key={`${profile.summaryEmail}:${profile.summarySms}:${canTextUser(profile)}`} email={profile.summaryEmail} sms={profile.summarySms} smsPossible={canTextUser(profile)} />
      {ctx.orgRole !== "GUEST" && (
        <Suspense>
          <UberCard configured={uber.configured} env={uber.env} connected={uber.connected} needsReconnect={uber.needsReconnect} />
        </Suspense>
      )}
      <PasswordForm />
    </div>
  );
}
