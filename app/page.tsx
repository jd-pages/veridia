import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/local-runtime";

export default async function HomePage() {
  const initialized = await isSetupComplete();
  redirect(initialized ? "/dashboard" : "/setup");
}
