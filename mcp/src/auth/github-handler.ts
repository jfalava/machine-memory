import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Schema } from "effect";

import {
  ACTIVATE_PATH,
  DEVICE_START_PATH,
  DEVICE_POLL_PATH,
  beginDeviceActivation,
  startDeviceLogin,
  pollDeviceLogin,
  deviceApprovedPage,
} from "./device-login";
import {
  claimDeviceApproval,
  finishDeviceApproval,
  rejectDeviceLogin,
  DEVICE_STATE_PREFIX,
} from "./device-store";
import type { OAuthEnv } from "./oauth-provider";
import {
  AuthRequestSchema,
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  isAllowedGithubUserId,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./oauth-utils";

export type GitHubAuthProps = {
  githubUserId: number;
  login: string;
  name: string;
  email: string;
  accessToken: string;
};

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const EncodedStateSchema = Schema.Struct({
  oauthReqInfo: AuthRequestSchema,
});

function upstreamAuthorizeUrl(params: {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
}): string {
  const upstream = new URL(GITHUB_AUTHORIZE_URL);
  upstream.searchParams.set("client_id", params.client_id);
  upstream.searchParams.set("redirect_uri", params.redirect_uri);
  upstream.searchParams.set("scope", params.scope);
  upstream.searchParams.set("state", params.state);
  upstream.searchParams.set("response_type", "code");
  return upstream.href;
}

async function exchangeGithubCode(params: {
  client_id: string;
  client_secret: string;
  code: string | undefined;
  redirect_uri: string;
}): Promise<[string, null] | [null, Response]> {
  if (params.code === undefined || params.code === "") {
    return [null, new Response("Missing code", { status: 400 })];
  }
  const resp = await fetch(GITHUB_TOKEN_URL, {
    body: new URLSearchParams({
      client_id: params.client_id,
      client_secret: params.client_secret,
      code: params.code,
      redirect_uri: params.redirect_uri,
    }).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "machine-memory-oauth",
    },
    method: "POST",
  });
  if (!resp.ok) {
    console.error(await resp.text());
    return [
      null,
      new Response("Failed to fetch access token", { status: 500 }),
    ];
  }
  const body = await resp.formData();
  const accessToken = body.get("access_token");
  if (accessToken === null || accessToken instanceof File) {
    return [null, new Response("Missing access token", { status: 400 })];
  }
  if (accessToken === "") {
    return [null, new Response("Missing access token", { status: 400 })];
  }
  return [accessToken, null];
}

const GitHubUserSchema = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});

async function fetchGithubUser(accessToken: string): Promise<{
  id: number;
  login: string;
  name: string;
  email: string;
}> {
  const resp = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "machine-memory-oauth",
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) {
    throw new Error(
      `GitHub /user failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`,
    );
  }
  const body = await resp.json();
  try {
    const user = Schema.decodeUnknownSync(GitHubUserSchema)(body);
    return {
      id: user.id,
      login: user.login,
      name: user.name ?? user.login,
      email: user.email ?? "",
    };
  } catch (_error) {
    throw new Error(
      `Failed to decode GitHub /user response: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
}

function redirectToGithub(
  request: Request,
  env: OAuthEnv,
  stateToken: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, {
    headers: {
      ...headers,
      location: upstreamAuthorizeUrl({
        client_id: env.MACHINE_MEMORY_GITHUB_CLIENT_ID,
        redirect_uri: new URL("/callback", request.url).href,
        scope: "read:user user:email",
        state: stateToken,
      }),
    },
    status: 302,
  });
}

function requireOAuthHelpers(env: OAuthEnv): OAuthHelpers {
  if (env.OAUTH_PROVIDER === undefined) {
    throw new Error("OAuth provider helpers not initialized.");
  }
  return env.OAUTH_PROVIDER;
}

function redirectToGithubFromState(
  request: Request,
  env: OAuthEnv,
  oauthReqInfo: AuthRequest,
  _clientId: string,
): Promise<Response> {
  return createOAuthState(oauthReqInfo, env.OAUTH_KV).then(({ stateToken }) =>
    bindStateToSession(stateToken).then(({ setCookie }) =>
      redirectToGithub(request, env, stateToken, {
        "Set-Cookie": setCookie,
      }),
    ),
  );
}

async function handleAuthorizeGet(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const helpers = requireOAuthHelpers(env);
  const oauthReqInfo = await helpers.parseAuthRequest(request);
  return authorizeRequest(request, env, oauthReqInfo);
}

async function authorizeRequest(
  request: Request,
  env: OAuthEnv,
  oauthReqInfo: AuthRequest,
): Promise<Response> {
  const helpers = requireOAuthHelpers(env);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return new Response("Invalid request", { status: 400 });
  }

  if (
    await isClientApproved(
      request,
      clientId,
      env.MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY,
    )
  ) {
    return redirectToGithubFromState(request, env, oauthReqInfo, clientId);
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(request, {
    client: await helpers.lookupClient(clientId),
    csrfToken,
    server: {
      description:
        "machine-memory: persistent project-scoped memory for LLM agents.",
      name: "Machine Memory MCP",
    },
    setCookie,
    state: { oauthReqInfo },
  });
}

function parseEncodedState(encoded: string): AuthRequest {
  let state: unknown;
  try {
    state = JSON.parse(atob(encoded));
  } catch {
    throw new OAuthError("invalid_request", "Invalid state data", 400);
  }
  return Schema.decodeUnknownSync(EncodedStateSchema)(state).oauthReqInfo;
}

async function handleAuthorizePost(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  try {
    const formData = await request.formData();

    validateCSRFToken(formData, request);

    const encodedState = formData.get("state");
    if (encodedState === null || encodedState instanceof File) {
      return new Response("Missing state in form data", { status: 400 });
    }

    const oauthReqInfo = parseEncodedState(encodedState);

    const approvedClientCookie = await addApprovedClient(
      request,
      oauthReqInfo.clientId,
      env.MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } =
      await bindStateToSession(stateToken);

    const response = redirectToGithub(request, env, stateToken);
    response.headers.append("Set-Cookie", approvedClientCookie);
    response.headers.append("Set-Cookie", sessionBindingCookie);
    return response;
  } catch (error) {
    console.error("POST /authorize error:", error);
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return new Response(
      `Internal server error: ${error instanceof Error ? error.message : "unknown"}`,
      { status: 500 },
    );
  }
}

async function fetchOrError(
  accessToken: string,
): Promise<
  { id: number; login: string; name: string; email: string } | Response
> {
  try {
    return await fetchGithubUser(accessToken);
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}${
            error.cause === undefined
              ? ""
              : ` (cause: ${
                  error.cause instanceof Error
                    ? `${error.cause.name}: ${error.cause.message}`
                    : JSON.stringify(error.cause)
                })`
          }`
        : String(error);
    console.error("GitHub user fetch error:", detail);
    return new Response(`Failed to fetch GitHub user info: ${detail}`, {
      status: 500,
    });
  }
}

async function resolveOAuthState(
  request: Request,
  env: OAuthEnv,
): Promise<{ oauthReqInfo: AuthRequest; clearCookie: string } | Response> {
  try {
    return await validateOAuthState(request, env.OAUTH_KV);
  } catch (error) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return new Response("Internal server error", { status: 500 });
  }
}

async function exchangeCodeForUser(
  request: Request,
  env: OAuthEnv,
): Promise<
  | {
      kind: "ok";
      accessToken: string;
      user: { id: number; login: string; name: string; email: string };
    }
  | { kind: "error"; response: Response }
> {
  const url = new URL(request.url);
  const redirectUri = new URL("/callback", request.url).href;
  const [accessToken, errResponse] = await exchangeGithubCode({
    client_id: env.MACHINE_MEMORY_GITHUB_CLIENT_ID,
    client_secret: env.MACHINE_MEMORY_GITHUB_CLIENT_SECRET,
    code: url.searchParams.get("code") ?? undefined,
    redirect_uri: redirectUri,
  });
  if (errResponse !== null) {
    return { kind: "error", response: errResponse };
  }
  const userOrError = await fetchOrError(accessToken);
  if (userOrError instanceof Response) {
    return { kind: "error", response: userOrError };
  }
  return { kind: "ok", accessToken, user: userOrError };
}

async function handleCallback(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const resolved = await resolveOAuthState(request, env);
  if (resolved instanceof Response) {
    return resolved;
  }
  const oauthReqInfo = resolved.oauthReqInfo;
  const clearSessionCookie = resolved.clearCookie;

  if (!oauthReqInfo.clientId) {
    return new Response("Invalid OAuth request data", { status: 400 });
  }

  if (new URL(request.url).searchParams.get("error") === "access_denied") {
    await denyDeviceLogin(env, oauthReqInfo);
    return new Response("Sign-in was denied.", { status: 403 });
  }
  const exchanged = await exchangeCodeForUser(request, env);
  if (exchanged.kind === "error") {
    return exchanged.response;
  }
  const { accessToken, user } = exchanged;

  if (
    !isAllowedGithubUserId(user.id, env.MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID)
  ) {
    await denyDeviceLogin(env, oauthReqInfo);
    return new Response(
      "This GitHub user is not authorized to access machine-memory.",
      { status: 403 },
    );
  }

  const response = await respondToCompletedGrant(
    env,
    oauthReqInfo,
    user,
    accessToken,
  );
  response.headers.set("Set-Cookie", clearSessionCookie);
  return response;
}

async function denyDeviceLogin(
  env: OAuthEnv,
  request: AuthRequest,
): Promise<void> {
  if (request.state.startsWith(DEVICE_STATE_PREFIX)) {
    await rejectDeviceLogin(env.OAUTH_DEVICES, request, "denied");
  }
}

async function respondToCompletedGrant(
  env: OAuthEnv,
  request: AuthRequest,
  user: { id: number; login: string; name: string; email: string },
  accessToken: string,
): Promise<Response> {
  const device = request.state.startsWith(DEVICE_STATE_PREFIX);
  if (device && !(await claimDeviceApproval(env.OAUTH_DEVICES, request))) {
    return new Response(
      "Device login expired, already used, or mismatched. Start again.",
      { status: 400 },
    );
  }
  try {
    const redirectTo = await completeGrant(
      requireOAuthHelpers(env),
      request,
      user,
      accessToken,
    );
    if (!device) {
      return new Response(null, {
        status: 302,
        headers: { Location: redirectTo },
      });
    }
    const code = new URL(redirectTo).searchParams.get("code");
    if (
      code === null ||
      !(await finishDeviceApproval(env.OAUTH_DEVICES, request.state, code))
    ) {
      throw new Error("Device approval could not be persisted.");
    }
    return deviceApprovedPage();
  } catch (error) {
    if (!device) {
      throw error;
    }
    await rejectDeviceLogin(env.OAUTH_DEVICES, request, "failed");
    return new Response("Device login failed. Start again.", { status: 500 });
  }
}

function completeGrant(
  helpers: OAuthHelpers,
  oauthReqInfo: AuthRequest,
  user: { id: number; login: string; name: string; email: string },
  accessToken: string,
): Promise<string> {
  return helpers
    .completeAuthorization({
      metadata: {
        label: user.name,
      },
      // SAFETY: the literal sets every GitHubAuthProps field explicitly.
      props: {
        accessToken,
        email: user.email,
        githubUserId: user.id,
        login: user.login,
        name: user.name,
      } as GitHubAuthProps,
      request: oauthReqInfo,
      scope: oauthReqInfo.scope,
      userId: user.login,
    })
    .then((completed) => completed.redirectTo);
}

export const githubHandler: ExportedHandler<OAuthEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isGet = request.method === "GET";
    const isPost = request.method === "POST";
    const isAuthorize = url.pathname === "/authorize";
    const isCallback = url.pathname === "/callback";

    if (url.pathname === DEVICE_START_PATH) {
      return startDeviceLogin(
        request,
        env.OAUTH_DEVICES,
        requireOAuthHelpers(env),
      );
    }
    if (url.pathname === DEVICE_POLL_PATH) {
      return pollDeviceLogin(request, env.OAUTH_DEVICES);
    }
    if (url.pathname === ACTIVATE_PATH) {
      const activation = await beginDeviceActivation(
        request,
        env.OAUTH_DEVICES,
      );
      return activation instanceof Response
        ? activation
        : authorizeRequest(request, env, activation);
    }
    if (isAuthorize && isGet) {
      return handleAuthorizeGet(request, env);
    }
    if (isAuthorize && isPost) {
      return handleAuthorizePost(request, env);
    }
    if (isCallback && isGet) {
      return handleCallback(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
