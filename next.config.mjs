// Plain ESM, NOT TypeScript, and that is the whole point.
//
// This was next.config.ts. `next start` inside the PACKAGED app has to load the config
// before it can serve anything, and loading a .ts config requires the `typescript`
// package — a devDependency, which electron-builder prunes. So the packaged app booted,
// found no TypeScript, tried to `npm install typescript` INTO ITS OWN INSTALL DIRECTORY
// at runtime (26 seconds, mutating node_modules, needing network), failed anyway, and
// the server exited code 1. A fresh install never came up at all.
//
// Nothing here needs types. Keep it .mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file rather than the working directory: `next start` is spawned by
// Electron, and a relative "./package.json" is only correct while cwd happens to be the
// app root.
const here = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the app version: package.json. Baked into the client bundle
// (NEXT_PUBLIC_*) so the sidebar badge always matches the installed build.
let appVersion = "0.0.0";
try {
  appVersion = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).version || "0.0.0";
} catch {
  /* a missing/unreadable package.json must not stop the server from starting */
}

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Normally ".next". A verification build can target an isolated folder
  // (NEXT_DISTDIR=.next-verify npx next build) so it never touches the .next
  // a RUNNING app is serving from. Launcher/Electron don't set this.
  distDir: process.env.NEXT_DISTDIR || ".next",
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // Electron loads the app from a local Next.js server bound to localhost only.
  // Keep server features (API routes, Prisma) — do NOT use static export.
  reactStrictMode: true,
  // Each page worker loads its own Prisma engine. Keep desktop builds usable
  // while the local vision model and the operator's other apps are running.
  experimental: { cpus: 1 },
  // The Prisma client and the Python worker are spawned server-side; keep them external.
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
