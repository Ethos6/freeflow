# Security policy

freeflow stores provider API keys and forwards requests on your behalf, so security reports are very welcome.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting**: open the repository's *Security* tab and choose *Report a vulnerability*. Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the impact you expect. You will get a reply within a few days.

## What freeflow already does

- Listens on `127.0.0.1` by default and rejects requests whose `Host` header is not a local name (DNS-rebinding protection).
- The admin API requires a per-install random token and rejects cross-origin requests; keys are never returned in full.
- The config file holding keys is written atomically with `0600` permissions.
- The dashboard uses a strict Content-Security-Policy and `frame-ancestors 'none'`.
- An optional proxy token protects the `/v1` endpoints.
- No runtime dependencies, so no third-party code runs with access to your keys.

## Supported versions

Security fixes go into the latest release.
