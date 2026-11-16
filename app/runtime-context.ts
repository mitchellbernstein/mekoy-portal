import { createContext, type RouterContext } from "react-router";
import type { Runtime } from "./server/runtime";

const shared = globalThis as typeof globalThis & { videoWorkspaceRuntimeContext?: RouterContext<Runtime> };
// Keep one token across Node's tsx loader and Vite's separate server module graph.
export const runtimeContext = shared.videoWorkspaceRuntimeContext ??= createContext<Runtime>();
