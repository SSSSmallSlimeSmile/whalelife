/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

// Check every ancestor before crossing it. readdir also detects case aliases on case-insensitive volumes.
export async function directoryAt(root: string, relative: string, create = false, made?: Set<string>) {
  let parent = root;
  const rootInfo = await lstat(parent);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error("宿主目录不是普通目录");
  for (const part of relative.split("/").filter(Boolean)) {
    const names = await readdir(parent), aliases = names.filter(name => name.toLowerCase() === part.toLowerCase());
    if (aliases.some(name => name !== part)) throw Error(`目录名大小写冲突：${part}`);
    parent = join(parent, part);
    if (!aliases.length && !create) return undefined;
    if (!aliases.length) {
      try { await mkdir(parent); made?.add(parent); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    }
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`目录使用了链接或不是目录：${part}`);
  }
  return parent;
}
