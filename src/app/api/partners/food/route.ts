import { authed } from "@/server/http";
import { foodPortal } from "@/server/services/partners";

// GET ?restaurant=r-slice-republic — the sandbox restaurant's view of your orders.
export const GET = authed(async (req, ctx) => foodPortal(ctx, req.nextUrl.searchParams.get("restaurant") ?? "r-slice-republic"));
