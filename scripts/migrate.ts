import { readFile } from "node:fs/promises";
import { createPool } from "../app/server/runtime";
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the application's PostgreSQL database");
const db=createPool(process.env.DATABASE_URL);
try { await db.query(await readFile(new URL("../app/server/schema.sql", import.meta.url), "utf8")); console.log("Schema ready"); }
finally { await db.end(); }
