export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
}

function buildWellKnownUrl(issuer: string): string {
  const normalizedIssuer = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const url = new URL(".well-known/openid-configuration", normalizedIssuer);
  return url.toString();
}

export async function discoverOidcMetadata(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000
): Promise<OidcMetadata> {
  const url = buildWellKnownUrl(issuer);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`OIDC discovery failed (${response.status})`);
    }

    const metadata = (await response.json()) as Partial<OidcMetadata>;
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error("OIDC metadata is missing required endpoints");
    }

    return {
      issuer: metadata.issuer ?? issuer,
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      jwks_uri: metadata.jwks_uri
    };
  } finally {
    clearTimeout(timeout);
  }
}
