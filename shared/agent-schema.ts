import { z } from "zod";
import { agentTemplateIds } from "./agent-templates.ts";

export const demoPresentationSchema=z.object({template:z.enum(agentTemplateIds),recipient:z.string().trim().max(120),brief:z.string().trim().max(3000),narration:z.discriminatedUnion("kind",[z.object({kind:z.literal("default")}).strict(),z.object({kind:z.literal("personal"),name:z.string().trim().min(1).max(200)}).strict()])}).strict();

export const demoActionSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("click"),role:z.enum(["button","link","tab","checkbox"]),name:z.string().min(1).max(160)}).strict(),
  z.object({kind:z.literal("fill"),label:z.string().min(1).max(160),value:z.string().max(500)}).strict(),
  z.object({kind:z.literal("assert"),text:z.string().min(1).max(500)}).strict(),
]);
const command=z.array(z.string().min(1).max(500)).min(1).max(20);
export const demoManifestSchema=z.object({install:command.optional(),build:command.optional(),start:command,port:z.number().int().min(1024).max(65535),goal:z.string().min(1).max(2000),actions:z.array(demoActionSchema).min(1).max(20).optional()}).strict();
export const demoResultSchema=z.object({status:z.enum(["succeeded","partial"]),mode:z.enum(["ai","scripted"]),narration:z.string().max(15_000),presentation:demoPresentationSchema.optional(),chapters:z.array(z.object({repository:z.string().max(200),commitSha:z.string().regex(/^[a-f0-9]{40}$/),status:z.enum(["succeeded","failed"]),error:z.string().max(2000).nullable().optional(),actions:z.array(z.object({kind:z.string().max(40),status:z.enum(["succeeded","failed"]),positionMs:z.number().int().nonnegative(),description:z.string().max(1000),observedText:z.string().max(2000).optional()}).strict()).max(20)}).strict()).max(30)}).strict();
