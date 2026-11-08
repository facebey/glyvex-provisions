# Security Policy

> **Language:** [Español](SECURITY.es.md)

## Supported Versions

Only the latest released version receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

If you find a security vulnerability, **do not open a public issue**.

Report it privately through one of these channels:
- **GitHub Security Advisories**: use the "Report a vulnerability" button on
  this repo's **Security** tab (preferred — creates a private draft).
- **Email**: info@glyvexgroup.com

### What to expect

- Acknowledgement of receipt within 72 hours.
- A first assessment (accepted / rejected / needs more info) within 7 days.
- If accepted, you will be kept informed of the progress until the fix
  ships. Credit goes in the changelog/release notes unless you ask
  otherwise.
- If rejected, we explain why.

### Scope

Provisions binds only to `127.0.0.1` and has no telemetry. Its outgoing
traffic is limited to Hugging Face (search, metadata, downloads) and the
update feed (GitHub) — vulnerabilities in those services belong to those
providers. Vulnerabilities in third-party binaries it launches
(for example `llama-server` of llama.cpp, or Ollama) must be reported to
their respective projects.

In scope for this policy: the FastAPI backend (`app/`), the Tauri/Rust
shell (`web/src-tauri/`), the React UI (`web/src/`), the NSIS installer and
the updater (the minisign **public** key is versioned by design; the private
key and password live outside the repo and are gitignored — if you ever see
them inside the repo, that is itself a security incident).
