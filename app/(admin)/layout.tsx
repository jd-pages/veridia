import { getSession } from "@/lib/auth";
import AdminShell from "@/components/AdminShell";
import { ensureLocalRuntime } from "@/lib/local-runtime";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = (await getSession()) || (await ensureLocalRuntime());
  return <AdminShell user={user}>{children}</AdminShell>;
}
