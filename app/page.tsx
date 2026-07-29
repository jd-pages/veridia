import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";

export default async function HomePage() {
  const initialized = (await prisma.user.count()) > 0;
  redirect(initialized ? "/dashboard" : "/setup");
}
