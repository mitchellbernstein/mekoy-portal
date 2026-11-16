import type { Config } from "@react-router/dev/config";
export default { ssr: true,buildDirectory:process.env.CLOUDFLARE_BUILD==="1"?"build-cloudflare":"build" } satisfies Config;
