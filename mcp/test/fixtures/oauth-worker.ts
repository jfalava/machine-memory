import {
  createOauthProvider,
  type OAuthEnv,
} from "../../src/auth/oauth-provider";

export default {
  async fetch(request, env, ctx) {
    return (await createOauthProvider(new URL("/mcp", request.url).href)).fetch(
      request,
      env,
      ctx,
    );
  },
} satisfies ExportedHandler<OAuthEnv>;
