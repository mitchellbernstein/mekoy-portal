import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
export default defineConfig(async()=>({ plugins: [
  ...(process.env.CLOUDFLARE_BUILD === "1" ? [(await import("@cloudflare/vite-plugin")).cloudflare({ viteEnvironment: { name: "ssr" },configPath:process.env.CLOUDFLARE_CONFIG||"wrangler.jsonc" })] : []),
  reactRouter(),
] }));
