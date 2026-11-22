/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readLauncherBundle } from "../core/host-launcher-migration.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

test("the pinned launcher matches its release sources and a complete Windows checkout", async () => {
  const files = await readLauncherBundle(fileURLToPath(new URL("../core/", import.meta.url)));
  const root = await temporaryDirectory("whale-launcher-bundle-");
  for (const [name, bytes] of files)
    await writeFile(join(root, name), bytes.toString("utf8").replaceAll("\n", "\r\n"));
  assert.deepEqual(await readLauncherBundle(root), files);
  await writeFile(join(root, "host-child.ts"), "// different build\n", {flag:"a"});
  await assert.rejects(readLauncherBundle(root), /与已验证清单不符/);
});
