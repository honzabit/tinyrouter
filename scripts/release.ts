#!/usr/bin/env bun
// Prepares a release: bumps the version in package.json (the single source of
// truth), commits it, and creates the matching annotated tag. Pushing the tag
// is what starts the release workflow, which re-runs the suite, gates on the
// live smoke checks, and publishes executables only if everything passes.
//
//   bun run release 0.2.0
//   git push origin main --follow-tags

import { $ } from "bun";

const version = process.argv[2];
if (version === undefined) {
  console.error("Usage: bun run release <version>   (for example: bun run release 0.2.0)");
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`'${version}' is not a semantic version such as 0.2.0 or 1.0.0-rc.1.`);
  process.exit(2);
}

const tag = `v${version}`;
const packagePath = new URL("../package.json", import.meta.url);
const source = await Bun.file(packagePath).text();
const current = (JSON.parse(source) as { version: string }).version;

if (current === version) {
  console.error(`package.json is already at ${version}.`);
  process.exit(1);
}
if ((await $`git status --porcelain`.text()).trim() !== "") {
  console.error("The working tree has uncommitted changes; commit or stash them first.");
  process.exit(1);
}
if (
  await $`git rev-parse -q --verify refs/tags/${tag}`
    .quiet()
    .nothrow()
    .then((r) => r.exitCode === 0)
) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

// Replace only the version field so the file's formatting is preserved.
const updated = source.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
if (updated === source) {
  console.error("Could not find a version field to update in package.json.");
  process.exit(1);
}
await Bun.write(packagePath, updated);

await $`git add package.json`;
await $`git commit -m ${`Release ${tag}`}`.quiet();
await $`git tag -a ${tag} -m ${`TinyRouter ${tag}`}`;

console.log(`Bumped ${current} -> ${version} and tagged ${tag}.`);
console.log("Push it to start the release workflow:\n\n  git push origin main --follow-tags\n");
