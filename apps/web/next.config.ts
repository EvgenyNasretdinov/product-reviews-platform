import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next 16 otherwise writes AGENTS.md/CLAUDE.md into this directory on
  // every dev/build run. This repository already has its own CLAUDE.md at
  // the root; an auto-generated one per app is unwanted noise, not
  // documentation anyone asked for.
  agentRules: false,
};

export default nextConfig;
