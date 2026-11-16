# Mekoy portal

Run a shared video workspace in your own account. The portal and HTTP service use the same source as the managed service. PostgreSQL owns users, sessions, membership, videos, comments, transcripts, and jobs. A Node server with filesystem media and a Cloudflare Worker with R2 and Stream are included.

## Prepare Cloudflare deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mitchellbernstein/mekoy-portal)

The button uses the separately published [Mekoy portal source](https://github.com/mitchellbernstein/mekoy-portal). Complete the prerequisites below before deploying.

This is not a fully verified one-click setup. The button can copy a public repository, detect the package commands, and provision supported Cloudflare bindings. It cannot create the external PostgreSQL database, apply this schema, buy Stream storage, or supply your credentials.

1. Provide PostgreSQL 17 with `pgvector`. Neon is one supported provider. Keep the database owner credential separate from the runtime credential. Apply `app/server/schema.sql` through the authorized database owner. For an existing database, review the schema before running `npm run db:migrate`. Preserve existing data and the stable `BETTER_AUTH_SECRET`.
2. Create a Hyperdrive connection to that database with query caching disabled. Membership revocation requires fresh database reads. Use `wrangler hyperdrive create <name> --connection-string <connection> --caching-disabled` in your own account. In the button's Hyperdrive field, select that existing connection. The observed create-new form has no caching toggle. The all-zero ID in `wrangler.jsonc` is only a template placeholder; predeploy rejects it before Wrangler can deploy.
3. Enable R2, provide an originals bucket and scoped S3 credentials, and enable a queue. The Wrangler file declares `ORIGINALS`, `JOBS`, and `HYPERDRIVE`. If you rename the bucket, update both its binding and `R2_BUCKET_NAME`. Configure bucket CORS for each exact HTTPS app origin, allow `PUT` and the `Content-Type` header, expose `ETag`, and use a 3600-second maximum age. Verify an `OPTIONS` preflight with the real `Origin` and `Access-Control-Request-Method: PUT` before browser upload. No wildcard origin is needed. Enable Stream and purchase storage before uploading hosted video. Supply a token authorized for the app's Stream and Workers AI calls.
4. Fill the declared Worker variables and required secrets using the binding descriptions. Expand Advanced settings and add the fields if they are not shown. Set `APP_ORIGIN` to the chosen HTTPS Worker origin, `CLOUDFLARE_ACCOUNT_ID` to the resource account, and `R2_BUCKET_NAME` to the selected originals bucket. Generate `BETTER_AUTH_SECRET` once with `openssl rand -base64 48`. Supply the scoped R2 keys and a separate narrow runtime `CLOUDFLARE_API_TOKEN` for Stream and Workers AI. `.dev.vars.example` is a local example, not proof of rendered form fields. Wrangler's [required-secret declarations](https://developers.cloudflare.com/workers/configuration/secrets/#validate-secrets-before-deploy) reject missing runtime secrets. Worker transcription uses the declared `AI` binding and Cloudflare-hosted `@cf/deepgram/nova-3`; no separate Deepgram key is needed.
5. Select `npm run build` and `npm run deploy`. Use a separate build/deployment token with the deployment grants and Hyperdrive Read. Cloudflare's [documented generated build token](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token) omits Hyperdrive Read, so choose or configure an appropriate build token. This is not the runtime token from step 4. Predeploy performs a GET-only check of the selected connection and rejects caching or unresolved values. It never changes Hyperdrive or uploads build credentials. Inspect the resulting bindings and run the full acceptance flow before sharing the deployment. A successful Worker deployment alone does not prove database, upload, playback, or AI readiness.

For a CLI deployment, copy `.env.example` to `.env` and enter the existing resource IDs. `CLOUDFLARE_CONFIG_API_TOKEN` is an operator-only token with Hyperdrive Read access. Never deploy that token or copy it into `.dev.vars`. The runtime `CLOUDFLARE_API_TOKEN` remains limited to Stream Edit and Workers AI Read and Edit. Run `npm run configure:cloudflare`. It verifies query caching and atomically writes a mode-600 `wrangler.configured.jsonc` containing bindings and public variables only. Copy `.dev.vars.example` to ignored `.dev.vars` and supply only the four runtime secrets there. Run `CLOUDFLARE_CONFIG=wrangler.configured.jsonc npm run build`, then `CLOUDFLARE_CONFIG=wrangler.configured.jsonc npm run deploy -- --config wrangler.configured.jsonc --secrets-file .dev.vars`. The predeploy script uses the operator token; Wrangler uses its separate authenticated deployment identity. Never pass the operator `.env` as a secrets file. Preserve `.env`, `.dev.vars`, and generated configuration outside git.

The Cloudflare build disables implicit `.env` and process-secret inference. This prevents Vite from writing the build token into generated preview `.dev.vars` files. An intentionally supplied local `.dev.vars` can still produce private preview output, so it must contain runtime secrets only. Never publish generated build directories or preview secrets.

Visual indexing and Feedback use `@cf/meta/llama-3.2-11b-vision-instruct`. Its account owner must review and accept the [model's license and usage policy](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/) before enabling those operations. The service never accepts terms on your behalf. Recording, playback, Nova-3 transcription, cited summaries and chapters remain usable while vision setup is pending.

Hyperdrive is a connection pool to an external database, so the full product is not Cloudflare-only hosting. Worker transcription streams media directly to the Cloudflare-hosted model. The application's upload limits do not establish the model's supported duration or byte range; large-recording inference has not been provider verified. The Node runtime uses external Deepgram when its optional key is configured. Slack, GitHub, custom narration, and demo recording require their own authorized integrations. Demo recording needs a separately operated Node and Docker service using `scripts/agents/runner.mjs`. Its pinned container provides Playwright. The Worker does not run that container, and the portal package does not install Playwright. No runner or provider capability is implied by an empty token.

To operate the optional demo runner, set `APP_ORIGIN` to the reachable portal and configure the same separate `DEMO_RUNNER_TOKEN` on both services. Run `npm run agent:runner` on the customer Node/Docker host. Keep `DEMO_OUTPUT_ROOT` durable so interrupted runs retain their recovery files. Provider consent and repository membership checks remain required before the runner can claim work.

## Run the Node server

1. Use Node 24 or newer and install the locked dependencies with `npm ci`. Install `ffmpeg` for local video processing.
2. Copy `.env.example` to `.env`. Set your database URL and a stable auth secret. Local files stay under `MEDIA_ROOT`. Set `DEEPGRAM_API_KEY` for real timed transcription; without it, the Node app retains playable recordings and shows the missing setup.
3. Apply the schema through your authorized database owner. Run `npm run build:node`, then `npm start`. `npm run dev` runs the same concrete Node adapter during development.
4. Keep the media directory and PostgreSQL data durable. Back up both. Run one job runner per intended deployment, and preserve recordings after failed uploads.

`npm run typecheck` checks both adapters. `npm run build` produces `build-cloudflare/`. `npm run build:node` produces `build/`. The Dockerfile uses the Node build and keeps its HTTP contract identical to the Worker service. It starts the app without running schema changes. Apply the schema first with the authorized database owner, then give the app its separate runtime credential.

## Verify a deployment

Use two synthetic members and one outsider. Upload a recording, interrupt and retry the upload, verify durable original bytes, signed playback, comments, transcript timing, and shared notes. Revoke membership and verify video, media, search, activity, and provider access on fresh requests. Repeat deployment and confirm persisted data, stable secrets, and existing resources survive. No clean-account provider run has been recorded for this template yet.

The managed installation at [mekoy.com](https://mekoy.com) passed this flow on 2026-11-16 with an 84-second synthetic recording: exact original integrity, signed Stream playback, private JPEG/GIF previews, 172 timed words, cited summary, 3 grounded chapters, collaboration and membership revocation survived deployment. This does not establish large-recording limits, capacity for 200 users, or a complete button deployment in a fresh Cloudflare account.

## Provider documentation

Reviewed on 2026-11-16 for Wrangler 4.162.0 and React Router 8.5.1.

- [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Required Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/#validate-secrets-before-deploy)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
- [Hyperdrive with node-postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)
- [R2 S3 tokens](https://developers.cloudflare.com/r2/api/tokens/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Stream setup](https://developers.cloudflare.com/stream/get-started/)
- [Workers AI REST setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Cloudflare-hosted Nova-3](https://developers.cloudflare.com/workers-ai/models/nova-3/)
