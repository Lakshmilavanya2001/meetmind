import type { CompletionRequest, CompletionResult } from "@/server/ai/llm";

/** The agent team's coordinator asks for a route first; scripted tests send everything to one agent. */
export function routeReply(req: CompletionRequest, agent = "general"): CompletionResult | null {
  if (req.jsonSchema?.name !== "route_request") return null;
  return { content: JSON.stringify({ steps: [{ agent, task: "Handle the user's latest message." }] }), toolCalls: [], finishReason: "stop" };
}
