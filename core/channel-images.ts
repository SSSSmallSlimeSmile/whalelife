/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ChannelImage } from "./plugin-api.ts";
import { modelImagePart, TOOL_CONTENT_LIMITS, toolContentSnapshot } from "./tool-content.ts";
import { ModelImageInputUnsupportedError } from "./model-http.ts";

export const CHANNEL_IMAGE_LIMITS = TOOL_CONTENT_LIMITS;
const privateImages = new AsyncLocalStorage<readonly ChannelImage[]>();
export const withPrivateChannelImages = <T>(run: () => T, images: readonly ChannelImage[] = []): T => privateImages.run(images, run);
export const channelImagesArePrivate = () => privateImages.getStore() !== undefined;

export function snapshotChannelImages(value: unknown): ChannelImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CHANNEL_IMAGE_LIMITS.images || value.some(part => part?.type !== "image"))
    throw Error("渠道图片必须是图片块数组，最多16张");
  if (!value.length) return [];
  return toolContentSnapshot(value) as ChannelImage[];
}

/** A receipt fingerprints the ordered media without storing a URL or any bytes. */
export function channelImageFingerprint(images: ChannelImage[]): string {
  const digest = createHash("sha256");
  for (const image of images) {
    digest.update(JSON.stringify([image.mimeType, image.detail ?? "auto", image.data.byteLength]));
    digest.update(image.data);
  }
  return digest.digest("hex");
}

export const channelImageParts = (images: ChannelImage[]) => images.map(modelImagePart);
export const isUnsupportedChannelImage = (error: unknown) => error instanceof ModelImageInputUnsupportedError;

export function containsChannelImageData(text: string, images: readonly ChannelImage[]): boolean {
  return /data:image\/[\w.+-]+;base64,/i.test(text) || containsAttachedImageBytes(text, images);
}

export function containsAttachedImageBytes(text: string, images: readonly ChannelImage[]): boolean {
  return images.some(({ data }) => text.length >= 4 * Math.ceil(data.byteLength / 3) &&
    text.includes(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64")));
}

/** Prevent an ordinary tool from persisting a copy of the current channel attachment. */
export function echoesPrivateChannelImage(value: unknown): boolean {
  const images = privateImages.getStore();
  if (!images?.length) return false;
  const seen = new WeakSet<object>();
  const contains = (item: unknown): boolean => {
    if (typeof item === "string") return containsAttachedImageBytes(item, images);
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (item instanceof Uint8Array) {
      const bytes = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
      return images.some(({ data }) => data.byteLength === bytes.length && bytes.equals(data));
    }
    return Object.values(item).some(contains);
  };
  return contains(value);
}

export function safeChannelDescription(value: unknown, images: ChannelImage[] = []): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || containsChannelImageData(value, images))
    throw Error("渠道辅助识图返回的描述无效");
  return value.trim();
}
