import type { Logger } from "../logging.js";
import type { TokenSet } from "../types.js";
import { toTokenSet } from "./client.js";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const ERROR_BODY_PREVIEW_CHARS = 500;

export interface AcquireTokenViaDeviceCodeOptions {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  serverId: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  /**
   * Sleep function used between polls. Overridable for tests.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Clock used to measure elapsed time. Overridable for tests.
   */
  now?: () => number;
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenErrorPayload {
  error?: string;
  error_description?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readResponseBodyPreview(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, ERROR_BODY_PREVIEW_CHARS);
  } catch {
    return "";
  }
}

function parseDeviceAuthorizationResponse(payload: unknown): DeviceAuthorizationResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("device authorization response is not a JSON object");
  }

  const record = payload as Record<string, unknown>;
  const deviceCode = record.device_code;
  const userCode = record.user_code;
  const verificationUri = record.verification_uri;
  const expiresIn = record.expires_in;

  if (typeof deviceCode !== "string" || deviceCode.length === 0) {
    throw new Error("device authorization response is missing device_code");
  }
  if (typeof userCode !== "string" || userCode.length === 0) {
    throw new Error("device authorization response is missing user_code");
  }
  if (typeof verificationUri !== "string" || verificationUri.length === 0) {
    throw new Error("device authorization response is missing verification_uri");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("device authorization response is missing a valid expires_in");
  }

  const verificationUriComplete =
    typeof record.verification_uri_complete === "string" &&
    record.verification_uri_complete.length > 0
      ? record.verification_uri_complete
      : undefined;

  const interval =
    typeof record.interval === "number" && Number.isFinite(record.interval) && record.interval > 0
      ? Math.floor(record.interval)
      : undefined;

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: expiresIn,
    interval
  };
}

export async function acquireTokenViaDeviceCode(
  options: AcquireTokenViaDeviceCodeOptions
): Promise<TokenSet> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const { logger, serverId } = options;

  // Step 1: request a device code.
  const deviceAuthBody = new URLSearchParams({
    client_id: options.clientId,
    scope: options.scopes.join(" ")
  });

  if (options.clientSecret) {
    deviceAuthBody.set("client_secret", options.clientSecret);
  }

  const deviceAuthController = new AbortController();
  const deviceAuthTimeout = setTimeout(() => deviceAuthController.abort(), options.timeoutMs);

  let deviceAuthResponse: Response;
  try {
    deviceAuthResponse = await fetchImpl(options.deviceAuthorizationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: deviceAuthBody,
      signal: deviceAuthController.signal
    });
  } finally {
    clearTimeout(deviceAuthTimeout);
  }

  if (!deviceAuthResponse.ok) {
    const preview = await readResponseBodyPreview(deviceAuthResponse);
    throw new Error(
      `device authorization request failed (${deviceAuthResponse.status})${preview ? `: ${preview}` : ""}`
    );
  }

  const deviceAuthPayload = (await deviceAuthResponse.json()) as unknown;
  const deviceAuth = parseDeviceAuthorizationResponse(deviceAuthPayload);

  const verificationUri = deviceAuth.verification_uri_complete ?? deviceAuth.verification_uri;

  // user_code is an ephemeral, single-use code with no value outside the active
  // flow — that is the spec's intent (RFC 8628). Log it so operators can see the
  // active code and forward it to the user if needed.
  logger.info("oauth_device_code_issued", {
    verificationUri,
    userCode: deviceAuth.user_code,
    expiresIn: deviceAuth.expires_in,
    serverId
  });

  // Also surface to stderr so terminal users can see the code regardless of log
  // routing. Mirrors the browser-fallback pattern in client.ts.
  process.stderr.write(
    `\n[lightbridge-opencode] device-code login for ${serverId}:\n  visit: ${verificationUri}\n  code:  ${deviceAuth.user_code}\n  (expires in ${deviceAuth.expires_in}s)\n\n`
  );

  // Step 2: poll the token endpoint.
  let intervalSeconds = deviceAuth.interval ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const deadlineMs = now() + deviceAuth.expires_in * 1000;

  while (true) {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      throw new Error("device code expired before authorization completed");
    }

    await sleep(Math.min(intervalSeconds * 1000, remainingMs));

    const pollBody = new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceAuth.device_code,
      client_id: options.clientId
    });

    if (options.clientSecret) {
      pollBody.set("client_secret", options.clientSecret);
    }

    const pollController = new AbortController();
    const pollTimeout = setTimeout(() => pollController.abort(), options.timeoutMs);

    let pollResponse: Response;
    try {
      pollResponse = await fetchImpl(options.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: pollBody,
        signal: pollController.signal
      });
    } finally {
      clearTimeout(pollTimeout);
    }

    if (pollResponse.ok) {
      const payload = (await pollResponse.json()) as Record<string, unknown>;
      const token = toTokenSet(payload, { requireRefreshToken: true });

      logger.info("oauth_device_code_success", {
        serverId,
        hasRefreshToken: true
      });

      return token;
    }

    if (pollResponse.status >= 400 && pollResponse.status < 500) {
      let errorPayload: TokenErrorPayload = {};
      const text = await readResponseBodyPreview(pollResponse);
      try {
        if (text.length > 0) {
          errorPayload = JSON.parse(text) as TokenErrorPayload;
        }
      } catch {
        // Body was not valid JSON; keep the raw preview for the error message.
      }

      const errorCode = errorPayload.error;

      if (errorCode === "authorization_pending") {
        continue;
      }

      if (errorCode === "slow_down") {
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
        continue;
      }

      if (errorCode === "expired_token") {
        throw new Error("device code expired before user completed authorization");
      }

      if (errorCode === "access_denied") {
        throw new Error("device code authorization denied by user");
      }

      throw new Error(
        `device code token poll failed (${pollResponse.status}): ${text || errorCode || "unknown error"}`
      );
    }

    // 5xx — surface to caller; do not retry indefinitely on server errors.
    const preview = await readResponseBodyPreview(pollResponse);
    throw new Error(
      `device code token poll failed (${pollResponse.status})${preview ? `: ${preview}` : ""}`
    );
  }
}
