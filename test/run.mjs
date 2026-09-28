// Use Pi's own TypeScript loader: some Node 22 builds lack --experimental-strip-types.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const jitiPackage = pathToFileURL(piRequire.resolve("jiti/package.json"));
const jiti = JSON.parse(readFileSync(jitiPackage, "utf8"));
const loader = new URL(jiti.exports["./register"].import, jitiPackage).href;
const dir = fileURLToPath(new URL(".", import.meta.url));
for (const file of readdirSync(dir).filter((name) => name.endsWith(".test.ts")).sort()) {
	console.log(`\n${file}`);
	const result = spawnSync(process.execPath, ["--import", loader, `${dir}${file}`], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
