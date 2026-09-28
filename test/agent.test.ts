import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPiAgent, isPermanentError } from "../extensions/ultracode/agent.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-agent-"));
const argv = process.argv[1];
const fixture = path.join(root, "fake-pi.cjs");
fs.writeFileSync(fixture, `
const fs = require('node:fs');
const emit = (event) => fs.writeSync(1, JSON.stringify(event) + '\\n');
const message = (text, stopReason, errorMessage) => emit({type: 'message_end', message: {
 role: 'assistant', content: [{type:'text', text}], stopReason, errorMessage,
 usage: { input: 10, output: 2, cost: {total: 0.01} }
}});
 message('', 'error', 'temporary error');
 emit({type: 'auto_retry_end', success: false});
 message(JSON.stringify({args: process.argv.slice(2), depth: process.env.PI_ULTRACODE_DEPTH}), 'stop');
 // Split a UTF-8 code point across pipe writes, and leave the final record unterminated.
 const event = Buffer.from(JSON.stringify({type: 'message_end', message: {
 role:'assistant', content:[{type:'text',text:'héllo 🦊'}], stopReason:'stop'
 }}));
 const boundary = event.indexOf(Buffer.from('🦊')) + 2;
 fs.writeSync(1, event.subarray(0, boundary));
 setTimeout(() => fs.writeSync(1, event.subarray(boundary)), 10);
`);

try {
	process.argv[1] = fixture;
	const options = { prompt: "--not-an-option", cwd: root, sessionDir: path.join(root, "session"), signal: new AbortController().signal };
	const result = await runPiAgent(options);
	assert.equal(result.text, "héllo 🦊");
	assert.equal(result.error, undefined, "successful recovery clears stale error");
	assert.equal(result.retryExhausted, false);
	assert.equal(result.usage.turns, 3);
	assert.equal(result.usage.cost, 0.02);

	fs.writeFileSync(fixture, `console.log(JSON.stringify({type:'message_end', message:{role:'assistant', stopReason:'stop', content:[{type:'text', text:JSON.stringify({args:process.argv.slice(2), depth:process.env.PI_ULTRACODE_DEPTH})}]}}));`);
	const invocation = JSON.parse((await runPiAgent({ ...options, tools: [] })).text);
	const args: string[] = invocation.args;
	assert.ok(args.includes("--no-tools"));
	assert.equal(args.at(-2), "--");
	assert.equal(args.at(-1), "--not-an-option");
	assert.match(args[args.indexOf("--exclude-tools") + 1]!, /spawn_agent.*wait_agent.*workflow/);
	assert.ok(Number(invocation.depth) >= 1);

	fs.writeFileSync(fixture, `console.log(JSON.stringify({type:'auto_retry_start', attempt:3, maxAttempts:3, delayMs:2000})); console.log(JSON.stringify({type:'auto_retry_end', success:false}));`);
	const activity: string[] = [];
	const exhausted = await runPiAgent({ ...options, onToolCall: (text) => activity.push(text) });
	assert.equal(exhausted.retryExhausted, true);
	assert.match(activity[0]!, /API retry 3\/3/);

	const controller = new AbortController();
	controller.abort();
	assert.equal((await runPiAgent({ ...options, signal: controller.signal })).aborted, true);
	fs.writeFileSync(fixture, "setInterval(() => {}, 1000)");
	const live = new AbortController();
	const pending = runPiAgent({ ...options, signal: live.signal });
	setTimeout(() => live.abort(), 50);
	assert.equal((await pending).aborted, true);

	for (const error of ["401 Unauthorized", "No API key for provider", "Unknown model: nope", "insufficient_quota"])
		assert.equal(isPermanentError(error), true, error);
	for (const error of [undefined, "503 overloaded", "connection reset", "429 too many requests"])
		assert.equal(isPermanentError(error), false, error);
	console.log("ok: child framing, UTF-8, tool exclusions, retry telemetry, cancellation");
} finally {
	process.argv[1] = argv;
	fs.rmSync(root, { recursive: true, force: true });
}
