import { readFile, writeFile, mkdir } from "node:fs/promises";
const value=process.env.APP_ORIGIN;if(!value||!value.startsWith("https://")) throw new Error("Set APP_ORIGIN to the reachable HTTPS app origin before generating a Slack manifest");
const origin=new URL(value).origin;
await mkdir(".local",{recursive:true});
const manifest=JSON.parse((await readFile("infra/slack-manifest.json","utf8")).replaceAll("https://YOUR_APP_ORIGIN",origin));
await writeFile(".local/slack-manifest.json",JSON.stringify(manifest,null,2)+"\n");console.log("Generated .local/slack-manifest.json. No Slack app was created or messages sent");
