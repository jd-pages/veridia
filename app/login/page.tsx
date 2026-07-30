import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ensureLocalRuntime } from "@/lib/local-runtime";
import LocalLoginScreen from "@/components/LocalLoginScreen";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  await ensureLocalRuntime();
  if (await getSession()) redirect("/dashboard");
  return <LocalLoginScreen />;
}
