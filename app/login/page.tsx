import { redirect } from "next/navigation";
import { ensureLocalRuntime } from "@/lib/local-runtime";

export default async function LoginPage() {
  await ensureLocalRuntime();
  redirect("/dashboard");
}
