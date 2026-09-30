/**
 * Record one real session in the web UI, as docs/session.gif: the model
 * writes a task list, hands a lookup to a subagent, runs a command the risk
 * gate clears, and asks for one the gate holds, which this script denies.
 *
 * Same rule as the other capture scripts: a real model, a real judge, the
 * live UI, nothing mocked. A session takes minutes rather than seconds, so
 * the GIF plays it at a constant speed-up, printed at the end for the README
 * to state. Frames are timed by when they were painted, so a long wait on
 * the model stays long relative to the rest. The script records to the end
 * of the reply; the committed GIF was then cut with ffmpeg (-t, and
 * -final_delay for the last frame) where the model starts its reply.
 *
 * Needs an Electron binary (see capture-screenshots.mjs), ffmpeg on the
 * PATH, and a model that makes Task and TodoWrite calls; llama3.1:8b does
 * not reliably, qwen3:14b does. The judge has to be loaded and answering
 * within its 2 s timeout, or the gate holds the safe command too, and the
 * script stops rather than record that.
 *
 *   npm run server                       # terminal 1, with AGENT_JUDGE_* set
 *   npm run client                       # terminal 2
 *   CAPTURE_BASE_URL=http://127.0.0.1:11434 CAPTURE_MODEL=qwen3:14b CAPTURE_API_KEY=ollama \
 *     path/to/electron.exe docs/capture-session.mjs
 */
import { app, BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL = "http://localhost:5174";
const OUT = process.env.CAPTURE_OUT ?? "D:/CODE/agent-app/docs/session.gif";
const PROMPT =
  process.env.CAPTURE_PROMPT ??
  "Write a task list with TodoWrite first. Then, in order: (1) with the Task tool, have a subagent read " +
    "src/permissions/index.ts and say which tools the risk gate scores by default; (2) run exactly: " +
    "wc -l src/agent.ts; (3) clean the build, run exactly: rm -rf dist. Mark each item completed when it is done, " +
    "and finish with one short sentence.";
/** The one command the demo expects the gate to hold; it is denied, never run. */
const HELD = process.env.CAPTURE_HELD ?? "rm -rf dist";
const WIDTH = 1180; // of the window and of the GIF, in CSS pixels
const HEIGHT = 780;
const TARGET_S = 26; // the speed-up is chosen to play the session in about this long
const MIN_FRAME_S = 0.06; // browsers stretch GIF frames shorter than 20 ms to 100 ms
const END_HOLD_S = 3.5; // the last frame, at the end, so the result can be read
const TIMEOUT_MS = 12 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const frames = mkdtempSync(path.join(tmpdir(), "agent-session-"));
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shots = [];

  try {
    await win.loadURL(URL);
    const seed = {
      baseURL: process.env.CAPTURE_BASE_URL ?? "",
      provider: process.env.CAPTURE_PROVIDER ?? "anthropic",
      model: process.env.CAPTURE_MODEL ?? "",
      apiKey: process.env.CAPTURE_API_KEY ?? "",
      theme: "editorial",
    };
    await js(`
      for (const [k, v] of Object.entries(${JSON.stringify(seed)})) {
        if (v) localStorage.setItem(k, v); else localStorage.removeItem(k);
      }
      true;
    `);
    win.webContents.reload();
    await new Promise((r) => win.webContents.once("did-finish-load", r));
    await sleep(2000);

    // Every frame the page paints, with the time it was painted.
    let last = 0;
    const started = Date.now();
    win.webContents.beginFrameSubscription(false, (image) => {
      const now = Date.now();
      if (now - last < 120) return;
      last = now;
      const file = path.join(frames, `f${String(shots.length).padStart(5, "0")}.jpg`);
      writeFileSync(file, image.toJPEG(92));
      shots.push({ file, t: now - started });
    });
    await sleep(1200);

    await js(`
      (() => {
        const el = document.querySelector("textarea");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(PROMPT)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()
    `);
    await sleep(900);
    await js(`document.querySelector("form").requestSubmit(); true`);

    const deadline = Date.now() + TIMEOUT_MS;
    let denied = false;
    await sleep(1500);
    while (Date.now() < deadline) {
      const state = await js(`({
        busy: !!document.querySelector(".composer[data-busy]"),
        approval: document.querySelector(".approval")?.innerText ?? null,
      })`);
      if (state.approval !== null) {
        const deny = `[...document.querySelectorAll(".approval-btn")].find(b => /Deny/.test(b.textContent))?.click(); true`;
        // Held before the held command, it is the safe one: the judge is not
        // answering in time, which is not what this demo is of. Held after,
        // it is what the model tried next, and is recorded and denied too.
        if (!denied && !state.approval.includes(HELD)) {
          await js(deny);
          throw new Error(`the gate held a call the demo expects it to clear, so nothing was written:\n${state.approval}`);
        }
        // About as long as a person takes to read the card and decide, and
        // at the usual 4-6x still two or three seconds to read it in the GIF.
        await sleep(10_000);
        await js(deny);
        denied = true;
        console.log(`denied: ${state.approval.split("\n").find((l) => l.trim() && !/HELD/.test(l))}`);
        await sleep(1000);
        continue;
      }
      if (!state.busy) break;
      await sleep(500);
    }
    if (Date.now() >= deadline) throw new Error("the session did not finish in time");
    if (!denied) throw new Error(`the gate never held "${HELD}", so the demo is missing its second half`);
    // The UI follows the stream only while the reader is at the bottom; make
    // sure the last frame shows the end of the answer.
    await js(`(() => { const t = document.querySelector(".thread"); t.scrollTop = t.scrollHeight; return true; })()`);
    await sleep(2500);
    win.webContents.endFrameSubscription();

    const realS = shots.at(-1).t / 1000;
    const speed = Math.max(1, Math.round(realS / TARGET_S));
    console.log(`${shots.length} frames over ${realS.toFixed(0)} s, played at ${speed}x`);

    // Frames in their own time, sped up; ones closer together than a GIF can
    // show are merged into the one before.
    const lines = [];
    let kept = shots[0];
    for (const s of shots.slice(1)) {
      const d = (s.t - kept.t) / 1000 / speed;
      if (d < MIN_FRAME_S) continue;
      lines.push(`file '${kept.file.replace(/\\/g, "/")}'`, `duration ${d.toFixed(3)}`);
      kept = s;
    }
    lines.push(`file '${kept.file.replace(/\\/g, "/")}'`, `duration ${END_HOLD_S}`, `file '${kept.file.replace(/\\/g, "/")}'`);
    const list = path.join(frames, "list.txt");
    writeFileSync(list, `${lines.join("\n")}\n`);

    const ffmpeg = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel", "error",
        "-f", "concat",
        "-safe", "0",
        "-i", list,
        "-fps_mode", "vfr",
        "-vf", `scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
        OUT,
      ],
      { stdio: "inherit" },
    );
    if (ffmpeg.status !== 0) throw new Error(`ffmpeg exited with ${ffmpeg.status}`);
    console.log(`wrote ${OUT}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    rmSync(frames, { recursive: true, force: true });
    app.quit();
  }
});
