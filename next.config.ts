import type { NextConfig } from "next";

// Cache Components is intentionally off: every page here is per-user and real-time,
// so plain dynamic rendering is simpler and avoids stale authenticated data.
const isDev = process.env.NODE_ENV !== "production";
// Next.js injects inline bootstrap scripts, hence 'unsafe-inline' for scripts (no nonces without dynamic CSP);
// everything else is locked to this origin. LiveKit signalling/media use wss:/https: (same origin via the proxy,
// or LiveKit Cloud), so connect-src allows secure WebSocket/HTTPS endpoints only.
const csp = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets the RNNoise noise-cancellation WebAssembly compile (it does not allow JS eval).
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  `connect-src 'self' wss: https:${isDev ? " ws: http:" : ""}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (.next/standalone/server.js).
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // camera/microphone/display-capture are needed by the meeting room (Phase 2).
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), display-capture=(self), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
          // Browsers ignore HSTS over plain HTTP, so this is safe to send unconditionally.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
