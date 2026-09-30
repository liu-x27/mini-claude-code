// A PreToolUse hook in Claude Code's format, and runs unchanged under either:
// the call arrives as JSON on stdin, exit code 2 blocks it, and what is written
// to stderr is the reason the model is given.
let raw = "";
process.stdin
  .on("data", (d) => (raw += d))
  .on("end", () => {
    const { tool_input } = JSON.parse(raw);
    if (/\bgit\s+push\b/.test(String(tool_input?.command ?? ""))) {
      process.stderr.write("Pushing is done by a person in this repository, not by the agent. Say what is ready to push instead.\n");
      process.exit(2);
    }
  });
