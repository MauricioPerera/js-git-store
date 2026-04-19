# Example: skills-catalog

Migrate [a2e-skills](https://github.com/MauricioPerera/a2e-skills) from its current CI-regenerated `index` branch workflow to programmatic writes via `GitDocStoreAdapter`.

## Goal

- Prove that the adapter can read a2e-skills' existing layout (skills.json, docs.json, prompts.json, templates.json partitions)
- Prove that writing a new skill via the adapter produces a valid commit that a2e-shell can consume without changes

## Prerequisites

- Clone a2e-skills locally: `git clone https://github.com/MauricioPerera/a2e-skills ./a2e-skills-fixture`
- Clone js-doc-store locally or install from its repo: `npm install github:MauricioPerera/js-doc-store`
- Implement js-git-store (this project)

## What the script does

```ts
import { DocStore } from "js-doc-store";
import { GitDocStoreAdapter } from "js-git-store";

const adapter = new GitDocStoreAdapter({
  repoUrl: "file:///absolute/path/to/a2e-skills-fixture",
  localCacheDir: "./.cache/a2e-skills",
  authEnvVar: undefined,  // local file:// needs no auth
  autoCommit: true,
  pushOnWrite: false,
});

const db = new DocStore({ adapter });

// Read the existing skills catalog
const skills = await db.collection("skills").find({});
console.log(`Found ${skills.length} skills in the catalog`);

// Add a new skill programmatically
await db.collection("skills").insert({
  _id: "semantic-search",
  name: "semantic-search",
  when_to_use: "when the user wants similarity search over documents",
  description: "...",
  entry: "run.sh",
  args: [{ name: "query", type: "string", required: true }],
  requires: ["curl"],
});

await adapter.flush();
// At this point the local fixture has a new commit adding the skill to
// the collection. a2e-shell can mount this repo as a catalog and will
// see the new skill on its next bootstrap.
```

## Acceptance for this example

- [ ] Reading all 4 existing a2e-skills categories (skills, docs, prompts, templates) returns the same data as `cat` on the index branch partitions
- [ ] Writing a new skill via the adapter leaves the repo in a state where `cat $repo/skills.json | jq '.entries["semantic-search"]'` returns the new entry
- [ ] `a2e-shell` can mount this migrated repo as a catalog and its reachability analysis succeeds
- [ ] No changes required to a2e-shell's catalog consumer code

## What this example does NOT do

- Does not push to the remote (file:// local only)
- Does not regenerate the `index` branch — that's the `regenerateIndexHook`'s job, wired in the full migration story, deferred to when the adapter supports it cleanly
