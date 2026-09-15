import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next 16 otherwise writes AGENTS.md/CLAUDE.md into this directory on
  // every dev/build run. This repository already has its own CLAUDE.md at
  // the root; an auto-generated one per app is unwanted noise, not
  // documentation anyone asked for.
  agentRules: false,
  // Produces .next/standalone: a self-contained server bundle (its own
  // minimal node_modules, traced from the monorepo root) that the runtime
  // Docker stage can copy without carrying the whole workspace. Without
  // this, "next start" needs the full node_modules tree, which is exactly
  // what a slim runtime image is trying to avoid.
  output: 'standalone',
};

export default nextConfig;
