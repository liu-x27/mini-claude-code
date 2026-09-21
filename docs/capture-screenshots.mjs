/**
 * Capture the risk gate's two states from the live web UI.
 *
 * Drives the running vite client in an Electron window the way a user would,
 * waits for real agent turns, and writes PNGs. The numbers in the images come
 * from an actual run against a real judge — a screenshot of mocked data would
 * be the one dishonest artefact in the repo.
 *
 * Not wired into package.json, because it needs an Electron binary and adding
 * one as a devDependency would put 200 MB in everyone's install for two
 * images. Point it at any Electron you have:
 *
 *   npm run server                       # terminal 1, with AGENT_JUDGE_* set
 *   npm run client                       # terminal 2
 *   path/to/electron.exe docs/capture-screenshots.mjs
 *
 * It expects a provider reachable at the baseURL seeded below; edit those two
 * localStorage lines for your own.
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";

const URL = "http://localhost:5174";
const OUT = "D:/CODE/agent-app/docs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return true;
    await sleep(700);
  }
  console.warn(`  ! timed out waiting for ${label}`);
  return false;
}

async function typeAndSend(win, text) {
  await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector("textarea")
        || document.querySelector('input[placeholder^="Message"]');
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
  await sleep(400);
  await win.webContents.executeJavaScript(`
    (() => {
      const form = document.querySelector("form");
      if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return "form"; }
      const btns = [...document.querySelectorAll("button")].filter(b => !b.disabled);
      btns[btns.length - 1].click();
      return "button";
    })()
  `);
}

async function shoot(win, name) {
  const image = await win.webContents.capturePage();
  writeFileSync(`${OUT}/${name}.png`, image.toPNG());
  console.log(`  wrote docs/${name}.png`);
}

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });

  // The UI keeps provider settings in localStorage; seed them so the run does
  // not need the settings panel opened by hand.
  await win.loadURL(URL);
  await win.webContents.executeJavaScript(`
    localStorage.setItem("baseURL", "https://api.minimaxi.com/v1");
    localStorage.setItem("model", "MiniMax-M2");
    true;
  `);
  await win.loadURL(URL);
  await sleep(2500);

  // ── 1. A safe command: the gate clears it, no prompt appears ──
  console.log("shot 1: auto-approved");
  await typeAndSend(win, "Run exactly this shell command and report the number: wc -l src/agent.ts");
  await poll(win, `!!document.querySelector(".gate-auto")`, 90_000, "an auto-approved badge");
  await sleep(2500);
  await shoot(win, "gate-auto-approved");

  // ── 2. A destructive command: the gate defers to the user ──
  console.log("shot 2: approval requested");
  await typeAndSend(win, "Clean the stale build output. Run exactly: rm -rf dist");
  await poll(win, `!!document.querySelector(".approval")`, 90_000, "the approval card");
  await sleep(1200);
  await win.webContents.executeJavaScript(
    `document.querySelector(".approval").scrollIntoView({block:"center"}); true;`,
  );
  await sleep(600);
  await shoot(win, "gate-needs-approval");

  // Deny it so the run does not actually delete anything, then stop.
  await win.webContents.executeJavaScript(`
    (() => {
      const deny = [...document.querySelectorAll(".approval-btn")].find(b => /Deny/.test(b.textContent));
      if (deny) deny.click();
      return true;
    })()
  `);
  await sleep(1500);

  console.log("done");
  app.quit();
  process.exit(0);
});
