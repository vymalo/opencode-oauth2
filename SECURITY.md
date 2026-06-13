# Security Policy

## Reporting a vulnerability

If you find a vulnerability — especially anything exploitable in the OAuth token handling or the
browser bridge — please **report it privately** rather than opening a public PR or issue:

- Open a [GitHub security advisory](https://github.com/vymalo/opencode-oauth2/security/advisories/new), or
- Open a minimal private issue asking for a secure contact.

Please include the affected package/version, a description, and a reproduction if you have one.
We'll acknowledge and work a fix; coordinated disclosure is appreciated.

For non-sensitive hardening ideas, a normal issue or PR is welcome.

## Supported versions

All published packages are kept on a single version line; fixes land on the latest release. Pin
to a released version and upgrade forward for security fixes.

## Security model

The blast radius and posture of each plugin (token cache permissions, the loopback + token-gated
browser bridge, the off-by-default `debug` tools, password masking, and how to reduce exposure)
is documented in **[`docs/security.md`](docs/security.md)**. Read it before enabling the browser
plugin against a real profile.
