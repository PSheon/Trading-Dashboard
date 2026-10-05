import { ReferralLanding } from "@/components/settings/referral";
export const metadata = { robots: { index: false, follow: false } };
export default async function ReferralPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <ReferralLanding code={code} />;
}
