/**
 * Strip credentials (`user:pass@`) and the query string from a URL before
 * including it in user-facing error messages or thrown exceptions. The query
 * string can contain access tokens, session ids, or other secrets supplied by
 * caller-controlled config — `baseURL` and `issuer` are not validated as
 * credential-free.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Not a parseable URL — strip anything that looks like a query and any
    // userinfo separator, then return.
    return rawUrl
      .replace(/\/\/[^/@]*@/, "//")
      .replace(/\?.*$/, "")
      .replace(/#.*$/, "");
  }
}

/**
 * Read at most `maxChars` characters from a `Response`'s body without
 * buffering the rest. Cancels the underlying stream once the cap is reached so
 * the network isn't drained on a huge error page.
 *
 * Returns an empty string if the body is unreadable or empty.
 */
export async function readResponseBodyPreview(response: Response, maxChars = 500): Promise<string> {
  if (!response.body) {
    // Some runtimes attach the body lazily; fall back to text() but still cap.
    try {
      const text = await response.text();
      return text.slice(0, maxChars);
    } catch {
      return "";
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let collected = "";

  try {
    while (collected.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      collected += decoder.decode(value, { stream: true });
      if (collected.length >= maxChars) {
        collected = collected.slice(0, maxChars);
        break;
      }
    }
  } catch {
    // partial body is fine
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
  }

  return collected;
}
