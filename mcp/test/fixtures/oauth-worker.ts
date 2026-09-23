import {
  createOauthProvider,
  type OAuthEnv,
} from "../../src/auth/oauth-provider";

export default {
  async fetch(request, env, ctx) {
    return (await createOauthProvider()).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<OAuthEnv>;
