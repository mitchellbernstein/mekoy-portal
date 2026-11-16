import { index, route, type RouteConfig } from "@react-router/dev/routes";

export function portalRoutes(workspaceModule: string): RouteConfig {
  return [route("s/:token", "routes/shared.tsx"), index(workspaceModule, { id: "home" }), route("*", workspaceModule, { id: "workspace" })];
}
