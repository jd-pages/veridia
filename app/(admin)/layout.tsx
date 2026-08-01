import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import AdminShell from "@/components/AdminShell";
import { isLocalPreviewMode } from "@/lib/local-preview-mode";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSession();
  if (!user) redirect("/login");
  return (
    <AdminShell user={user} previewMode={isLocalPreviewMode()}>
      {children}
    </AdminShell>
  );
}
