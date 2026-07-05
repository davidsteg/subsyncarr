# Security Policy

## Supported Versions

Only the latest release is supported. This project ships frequently and doesn't maintain long-term support branches — always run the most recent tag.

## No Authentication — Read This Before Deploying

Subsyncarr has **no built-in authentication**. Anyone who can reach the web UI or API can:

- Start, stop, or reconfigure sync runs
- View your media library's full file/folder structure and processing history
- Trigger deletion of subtitle files — the app deletes subtitles that repeatedly fail to align with their video across multiple runs (see the README's [Not-Fitting Delete Threshold](README.md#not-fitting-delete-threshold) section)

**Do not expose this port to the public internet.** Recommended setups:

- Keep it on a private/internal network only — `WEB_HOST=0.0.0.0` (the default) means the app itself doesn't restrict who connects, so your firewall/router must be the thing preventing external access
- Put it behind a reverse proxy that adds authentication (e.g., Authelia, Authentik, or basic auth in nginx/Caddy/Traefik)
- Access it only over a VPN or an overlay network (Tailscale, WireGuard, etc.)

## Reporting a Vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/davidsteg/subsyncarr/security/advisories/new) rather than a public issue, especially for anything that could bypass intended access controls or lead to arbitrary command/code execution.

For anything else (bugs, feature requests), open a regular [GitHub Issue](https://github.com/davidsteg/subsyncarr/issues).
