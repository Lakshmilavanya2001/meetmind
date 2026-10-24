import { redirect } from "next/navigation";
import { getAuth } from "@/server/auth/current";

export default async function Home() {
  redirect((await getAuth()) ? "/dashboard" : "/login");
}
