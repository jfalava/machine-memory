// Full-corpus markdown for AI agents — served from Nimbus's prepared
// endpoint artifact so generated partials and build-time context are kept.
import { getLlmsPayload } from "@cloudflare/nimbus-docs/agent-endpoints";

export const prerender = true;

export async function GET({ request }: { request: Request }) {
  const payload = await getLlmsPayload(
    { scope: "site", surface: "full" },
    { request },
  );

  if (!payload) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(payload.body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
