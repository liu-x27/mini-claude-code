# Sandboxing Bash on Windows

`--sandbox` runs every Bash command the model makes in an OS sandbox (see the README's
[The sandbox](../README.md#the-sandbox)). On Windows there are two backends. Neither is set
up by `npm install`, and this harness never sets either up for you: srt's install changes
system security settings, which is yours to decide. This page says what each changes on the
machine, how to undo it, and how to check it works.

What srt and MXC do is described from their own READMEs, release notes and source, at
sandbox-runtime 0.0.81 (2026-10-20) and MXC 1.0.1 (2026-10-17). Both are new and change
quickly; read their current docs before relying on this page.

## srt: sandbox-runtime (alpha on Windows)

Each command runs as a separate local account, `srt-sandbox`, under a restricted token that
is also write-restricted, in a job object. Its connections are blocked by Windows Filtering
Platform (WFP) filters except to srt's own proxy on the loopback interface, and its file access
comes from ACL entries srt adds for that account only.

Use 0.0.81 or later: before it, a sandboxed command could write wherever a folder already lets
every signed-in user modify it, which on a default install is every folder made at the top of a
drive and everything under it, `D:\CODE` included
([#402](https://github.com/anthropics/sandbox-runtime/issues/402)); and it could reach the
network from an AppContainer child process, or impersonate you through its stdin pipe.

### The one-time install

From a checkout where `npm ci` has run, in a terminal of your own:

```powershell
node node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js windows-install
```

It asks for elevation once (a UAC prompt; your account must be able to approve it). According
to srt's README, release notes and the source of its `srt-win.exe`, it:

1. creates the local account `srt-sandbox`, with a random 32-character password that does not
   expire, stored DPAPI-encrypted under `HKLM\SOFTWARE\sandbox-runtime`; makes it a member of
   `Users` and of a new local group `sandbox-runtime-users`; hides it from the sign-in screen;
2. denies that group network, batch, service and remote-desktop logon;
3. creates `%ProgramData%\sandbox-runtime`, which holds a certificate authority's key;
4. adds deny-write ACL entries for the account on `%ProgramData%`, `%PUBLIC%`,
   `%SystemRoot%\Temp` and a few other shared system folders;
5. adds a persistent WFP sublayer with filters that allow loopback connections to ports
   60080–60089 for everyone and block every other connection the account makes;
6. then, without elevation, makes your profile readable (read and execute only) to the
   sandbox account, minus a built-in list of credential stores: `.ssh`, `.gnupg`, `.aws`,
   `.azure`, `.kube`, `.docker`, `.claude`, `.config\gh`, `.config\gcloud`, `.git-credentials`,
   `.netrc` and about fifty more. It can take minutes on a large profile. Files that can hold a
   package feed's token are left readable on purpose: `.npmrc`, `.gitconfig`, pip and NuGet
   configuration. Add `--skip-profile-grant` to leave your profile closed instead (srt
   suggests that on a computer other people have accounts on), or
   `--profile-exclude <path>` to keep more of it closed.

It installs no service and no scheduled task. It needs the built-in Secondary Logon service
(`seclogon`). Your own network, and every other account's, are not filtered. srt does not
document which Windows editions it supports; its CI runs on GitHub's Windows Server runners.
The `srt-win.exe` that does all this, from the npm package, is not code-signed.

### While the harness runs

With `--sandbox srt`, srt adds an ACL entry giving `srt-sandbox` modify rights on the working
directory when the first command starts, and keeps it there after the harness exits, so the
next session in that folder starts at once; a kept folder can be written only by a session that
lists it, but read by any sandboxed session on the machine. `srt-win.exe acl forget <folder>`
(or `--all`) removes kept grants, and uninstalling does too. The executable is in
`node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/`.

When the working directory contains srt itself, as it does when you run the harness on this
checkout, the harness also has srt deny writes to srt's own folder: otherwise a command could
replace `srt-win.exe`, which starts the next command, as you.

### Undo

```powershell
node node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js windows-uninstall
```

One more UAC prompt. It removes the WFP filters, the account and its profile, the group, the
registry key and the kept grants. It leaves `%ProgramData%\sandbox-runtime` and
`%LOCALAPPDATA%\sandbox-runtime`, which you can delete by hand.

### Known gaps (srt's README and tracker, 2026-10-20)

- Deleting or moving a file out of a folder where `Users` or `Authenticated Users` hold full
  control is not covered by the write restriction, nor is any folder open to `Everyone`.
- Name resolution through the system resolver is not fenced; the connection that follows is.
  srt's README lists further gaps in the network fence (SMB, WSL, a connect made under the
  anonymous token).
- File-system denials are not reported back, only network ones
  ([#658](https://github.com/anthropics/sandbox-runtime/issues/658)).
- Tools that use schannel — the system `curl.exe`, .NET and PowerShell web requests — do not
  work under the write-restricted token. Git for Windows' own `curl` is built on schannel too
  (8.18.0, the one checked here), so HTTPS from Git Bash fails inside even to an allowed host;
  plain HTTP through srt's proxy works.
- A working directory two or more levels inside your profile has broken git and Node's
  `realpath` in the sandbox ([#657](https://github.com/anthropics/sandbox-runtime/issues/657)).
- Inside, `HOME` is the `srt-sandbox` profile, not yours.

### Check it

```powershell
npm run test:sandbox -- --backend srt
npm run test:sandbox -- --backend srt --root D:\CODE\sbx-test
```

The second puts the test's workspace on `D:\`, where #402 applied before 0.0.81.

In CI, on GitHub's `windows-latest` runner (Windows Server, not Windows 11) with 0.0.81, the
first passed 18 of 19, the 19th, a Node script, failing as #657 says, and the second all 19
([run 39366323349](https://github.com/liu-x27/mini-claude-code/actions/runs/39366323349)).
It has not been run on this repository owner's machine, which needs the install above first.

## MXC: Microsoft Execution Containers

Each command runs in a process container of the AppContainer family. On a build that has the
OS's own process-container API (MXC calls it the `base-container` tier), Windows enforces the
container's file grants and network rules itself: nothing is installed, no administrator is
needed, and no folder's permissions change. This harness accepts only that tier. MXC's other
tiers get the same effect by editing folder permissions, and the harness tells MXC not to
(`fallback.allowDaclMutation: false`).

### What it needs

- Windows 11 24H2 or 25H2 at build 26100.9278 / 26200.9278 or later. The OS part shipped in
  KB5120998 (2026-08-27), which Microsoft lists as a gradual rollout, so a machine on the right
  build may still not have it switched on.
- MXC's docs name no editions. Two reports on its tracker describe the `base-container` tier
  working on Windows 11 Home, one of them on build 26200.9711
  ([mxc#1464](https://github.com/microsoft/mxc/issues/1464),
  [mxc#1465](https://github.com/microsoft/mxc/issues/1465)).
- `wxc-exec.exe`, from the SDK's npm package, which is large (about 108 MB unpacked, and it
  brings node-pty and koffi with it):

  ```powershell
  npm install --no-save @microsoft/mxc-sdk@1.0.1
  ```

  or set `AGENT_MXC_EXEC` to a `wxc-exec.exe` you got elsewhere. It must not be inside a folder
  sandboxed commands can write; the harness refuses to start commands if it is.

You do not need MXC's `wxc-host-prep.exe`, which needs an administrator: it prepares the tiers
this harness does not use.

### What it does not do

- **No Git Bash.** Nothing built on msys-2.0.dll can start in a container
  ([mxc#1061](https://github.com/microsoft/mxc/issues/1061)), so under `--sandbox mxc` the Bash
  tool's commands run in cmd.exe, and the model is told so.
- **Reads are closed too.** A command reads only the working directory, the folders on PATH
  (granted read-only, except any that would expose your home directory or a credential store),
  and folders open to every AppContainer (Windows, much of Program Files). Its TEMP is a folder
  Windows makes for the container, and HOME, USERPROFILE and APPDATA point into a folder of its
  own that the harness removes on exit, so git and npm do not stop at your unreadable
  `.gitconfig` and `.npmrc`.
- **Node needs two flags.** Node's JavaScript `realpath` stats every folder from the drive root
  down, which the container cannot, so scripts, npm and npx fail before they start. The harness
  adds `--preserve-symlinks --preserve-symlinks-main` to `NODE_OPTIONS` inside the container,
  which changes how Node resolves symlinked packages. Code that calls `fs.realpathSync` itself
  still fails there.
- **The network is closed, not filtered by host.** MXC's rules match IP addresses, so
  `--sandbox-allow-domain` needs srt.
- MXC's tracker has further reports of Node and git failing in the `base-container` tier
  ([mxc#1464](https://github.com/microsoft/mxc/issues/1464)); on the machine tested here
  (below), `git init` and `git status` in the working directory worked.
- The harness has to run in your desktop session: from a service or over SSH (session 0) the
  container's programs fail to start ([mxc#1465](https://github.com/microsoft/mxc/issues/1465)).

### Check it

```powershell
npm run test:sandbox -- --backend mxc
```

On 2026-10-19, on Windows 11 Home China 25H2, build 26200.9711, MXC 1.0.1 chose the
`base-container` tier and all 17 cases passed. Inside, Node scripts, `npm`, `npx`, `git init` and
`git status` ran; listing `C:\` and calling `fs.realpathSync` from a script did not.
