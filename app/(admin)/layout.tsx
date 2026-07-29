import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import AdminShell from "@/components/AdminShell";
import { prisma } from "@/lib/db";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSession();
  if (!user) {
    const initialized = (await prisma.user.count()) > 0;
    redirect(initialized ? "/login" : "/setup");
  }
  return <AdminShell user={user}>{children}</AdminShell>;
}
