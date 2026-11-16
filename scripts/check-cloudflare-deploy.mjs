import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(process.env.CLOUDFLARE_CONFIG || "wrangler.jsonc", "utf8"));
const id = config.hyperdrive?.find(binding => binding.binding === "HYPERDRIVE")?.id;
assert(typeof id === "string" && /^[a-f0-9]{32}$/i.test(id) && !/^0+$/.test(id), "Select an existing cache-disabled Hyperdrive connection before deploying. The template ID is not a database connection");
const account = config.vars?.CLOUDFLARE_ACCOUNT_ID;
assert(typeof account === "string" && /^[a-f0-9]{32}$/i.test(account), "Set CLOUDFLARE_ACCOUNT_ID in the Worker variables to the account containing the selected resources");
assert(!config.account_id || config.account_id === account, "The deployment account and runtime account must match");
let appOrigin;
try { appOrigin = new URL(config.vars?.APP_ORIGIN); } catch { throw new Error("Set APP_ORIGIN in the Worker variables to the app's HTTPS origin"); }
assert(appOrigin.protocol === "https:" && appOrigin.origin === config.vars.APP_ORIGIN.replace(/\/$/, ""), "APP_ORIGIN must be an HTTPS origin without credentials, a path, query or fragment");
const originals = config.r2_buckets?.find(binding => binding.binding === "ORIGINALS")?.bucket_name;
assert(originals && config.vars.R2_BUCKET_NAME === originals, "Set R2_BUCKET_NAME to the same bucket selected for ORIGINALS");
assert(config.ai?.binding === "AI" && config.queues?.producers?.some(binding => binding.binding === "JOBS"), "Select the required AI and JOBS bindings before deploying");
const token = process.env.CLOUDFLARE_CONFIG_API_TOKEN || (process.env.WORKERS_CI === "1" ? process.env.CLOUDFLARE_API_TOKEN : undefined);
assert(token, "Hyperdrive verification needs an operator token in CLOUDFLARE_CONFIG_API_TOKEN, or a separate Workers Builds deployment token with Hyperdrive Read. Never use the runtime token for this check");
let response, resource;
try {
  response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive/configs/${id}`, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  resource = await response.json();
} catch { throw new Error("Cannot read the selected Hyperdrive. Check the operator or build token's Hyperdrive Read access and retry"); }
assert(response.ok && resource.success === true, "Cannot verify the selected Hyperdrive. Give the operator or build token Hyperdrive Read access to this account");
assert(resource.result?.caching?.disabled === true, "The selected Hyperdrive has query caching enabled. Select an existing cache-disabled connection or have its owner disable caching. This check never changes shared resources");
console.log("Verified cache-disabled Hyperdrive and required public bindings. No resources or Worker secrets were changed");
