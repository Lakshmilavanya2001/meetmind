import { authed } from "@/server/http";
import { cinemaPortal } from "@/server/services/partners";

// GET ?cinema=cn-galaxy-kor — the sandbox cinema's view of your bookings.
export const GET = authed(async (req, ctx) => cinemaPortal(ctx, req.nextUrl.searchParams.get("cinema") ?? "cn-galaxy-kor"));
