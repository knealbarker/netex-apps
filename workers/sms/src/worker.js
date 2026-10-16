// Cloudflare entry point for netex-sms. Kept apart from index.js because "cloudflare:workers" only exists in Workers (tests import index.js).
import { WorkerEntrypoint } from "cloudflare:workers";
import { handle, withHeaders } from "./index.js";
import { send, replies, markHandled } from "./texts.js";

export default {
  async fetch(req, env) { return withHeaders(await handle(req, env)); },
};

/**
 * What other apps call, over a service binding (never reachable from the internet). In the app's wrangler.toml:
 *   [[services]]
 *   binding = "TEXTS"
 *   service = "netex-sms"
 *   entrypoint = "Texts"
 * then:  await env.TEXTS.send({ app: "planner", to: "+12145550123", body: "…", ref: "late:2026-10-16:<id>" })
 *        await env.TEXTS.replies({ app: "planner" })            // unhandled replies to that app's texts, oldest first
 *        await env.TEXTS.markHandled({ app: "planner", ids })
 */
export class Texts extends WorkerEntrypoint {
  send(msg) { return send(this.env, msg); }
  replies(q) { return replies(this.env, q); }
  markHandled(q) { return markHandled(this.env, q); }
}
