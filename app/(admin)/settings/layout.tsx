import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { canAccessSystemSettings } from "@/lib/permissions";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (!canAccessSystemSettings(user.role)) redirect("/dashboard");
  return children;
}
