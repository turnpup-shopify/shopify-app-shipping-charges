import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

export default {
  ssr: true,
  // Lets routes export `config = { maxDuration }` and splits functions on Vercel.
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
