import { beforeEach } from "vitest";
import { resetRateLimits } from "@/server/rate-limit";

beforeEach(() => resetRateLimits());
