# Troubleshooting — common problems

> **Language:** [Español](TROUBLESHOOTING.es.md)

Real cases with the diagnosis behind them. All verified live.

## The app starts slowly (20+ s from double-click to usable UI)

**Symptom.** The splash stays for ~20–24 s before the UI appears.

**What happens.** Two causes were measured and fixed, and one may still live
on your machine:

1. **Code (fixed in 0.2.1)**: the shell used to probe the 8321–8330 ladder
   *sequentially* (ten probes in a row, 2 s timeout each). On top of that,
   the network stack was imported eagerly at startup. 0.2.1 made the probe
   parallel (one thread per port) and the imports lazy: startup went from
   22.7 s to 4.0 s **on a machine that still has cause 3**.
2. **Another Provisions backend already running**: the app reuses it by
   design (that is a feature for multiple instances), so "slow to open" can
   just be the redirect to a healthy neighbor port. Check
   `Get-NetTCPConnection -LocalPort 8321..8330` (or just look at which port
   the UI opened on).
3. **Machine (may still apply)**: a Windows TCP-stack anomaly where a SYN to
   a *closed* loopback port takes ~2 s to fail instead of <10 ms (the RST
   does not come back and the stack waits for retransmission). Until it is
   repaired, each probe costs ~2 s even in parallel.

**What to do.**
- Update to 0.2.1 or later (the in-app banner does it, or reinstall from
  [Releases](https://github.com/facebey/glyvex-provisions/releases/latest)).
- Repair the TCP stack: in an **admin** console run
  `netsh winsock reset` and `netsh int tcp reset`, then **reboot**.
  Afterwards a closed loopback port fails in <10 ms and startup drops to
  ~1.5–2 s.
- If it is still slow after that: the sidecar itself is fast (healthz in
  1–2 s measured), so read `sidecar-stderr.log` (see below) before
  reporting.

## Search fails with a 401/403 on a Hugging Face repo

**Symptom.** Friendly message: the repository is gated (private or
access-restricted).

**What happens.** Gated repos require the Hugging Face account to have
accepted the repository's access conditions (often a license form on the
repo page), and API calls need a token with that access.

**What to do.** Open the repo on huggingface.co with your account, accept
the access terms, and make sure the app uses an `HF_TOKEN` / logged-in
`huggingface_hub` with a token that carries that access. Public repos need
none of this.

## The UI opens on a port other than 8321

**Symptom.** The app works, but the address bar / network shows 8322–8330
or a high random port.

**What happens.** That is the port ladder doing its job: 8321 was busy
(some other process, or another Provisions instance), so the backend took
the next free neighbor — or, if the whole ladder is busy, an OS-assigned
port. The marker `#PORT_ASSIGNED:<port>#` is what tells the shell where the
backend actually is.

**What to do.** Nothing — it is by design. If you want 8321 back, find what
holds it (`Get-NetTCPConnection -LocalPort 8321`) and free it. Note: right
after killing a process that held 8321, the port can stay "owned" for a few
seconds (OwningProcess 0 — the kernel releasing it); wait ~3 s before
re-checking.

## Splash says "The backend did not start. Retrying…"

**Symptom.** The app never reaches the UI and loops on the retry message.

**What happens.** The sidecar process died before it could print its port
marker. The cause is almost always in the sidecar's stderr, which the shell
drains to a log.

**What to do.** Open `%LOCALAPPDATA%\glyvex-provisions\data\logs\sidecar-stderr.log`
(installed) — it contains the Python traceback. Common causes: the
`hf_down` core not installed in the venv (dev), a corrupt data dir, or a
dependency version drift. In dev, run the backend by hand
(`uvicorn app.main:app --host 127.0.0.1 --port 8321`) to see the error in
the console. You can also point the app at a different data dir with
`PROV_DATA_DIR` to rule out a corrupt one.

## The "Update and restart" button failed on an old install (401/ACL)

**Symptom.** On 0.1.0 or 0.1.1, the update button failed with
`Command stop_sidecar not allowed by ACL`.

**What happens.** In Tauri v2 every IPC command passes the window's ACL
check, including commands the app defines itself. The fix (the custom
permission `sidecar-control`) shipped in **0.1.2**.

**What to do.** 0.1.0/0.1.1 can check the feed but cannot finish the in-app
flow: install 0.1.2+ manually from Releases once, and every later update
works in-app from then on.

## Destination folder rejected (422)

**Symptom.** The search/download flow rejects the chosen destination.

**What happens.** The folder is validated before any download: it must
exist and be a writable local disk, NAS share or UNC path.

**What to do.** Create the folder, check permissions (the app runs
per-user, no admin), and pick a path inside a volume the user can write
to.

## "My models are gone" after a reinstall

**What happens.** They are not gone. User data lives in
`%LOCALAPPDATA%\glyvex-provisions\data` (library index, profiles, presets,
settings, logs), which the NSIS installer never touches.

**What to do.** Nothing — point the app at the same destination folder it
was using (the library index references the files on disk). If the data dir
itself was moved, set `PROV_DATA_DIR` to its new location.

## Still stuck?

Report it in the [repo issues](https://github.com/facebey/glyvex-provisions/issues)
with: version, the port the UI opened on, and the content of
`sidecar-stderr.log` (redact paths if needed). Security-related problems go
through the channels in [SECURITY.md](../SECURITY.md), never a public issue.
