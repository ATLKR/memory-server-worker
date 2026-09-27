/** Pure owned target-set identity. These bytes/digests select no operational
 * target and do not attest database state, runtime configuration or admission. */
export const SEOUL_TARGET_SET_MAX_BYTES = 134145;
export const SEOUL_TARGET_MANIFEST_MAX_BYTES = 134539;

export type SeoulTargetManifest = Readonly<{
  version: 1;
  manifestId: string;
  expectedGeneration: number | null;
  operatorReference: string;
  spaceIds: readonly string[];
}>;
export type SeoulTargetSetCandidate = Readonly<{
  spaceIds: readonly string[];
  setText: string;
  setSha256: string;
}>;
export type SeoulTargetManifestCandidate = Readonly<{
  manifest: SeoulTargetManifest;
  manifestText: string;
  manifestSha256: string;
  setText: string;
  setSha256: string;
}>;

const encoder = new TextEncoder();
const manifestKeys = ['version', 'manifestId', 'expectedGeneration', 'operatorReference', 'spaceIds'] as const;
const MANIFEST_DOMAIN = 'memory:seoul-target-manifest:v1\n';
const SET_DOMAIN = 'memory:seoul-target-set:v1\n';
const MANIFEST_INVALID = 'seoul_target_manifest_invalid';
const SET_INVALID = 'seoul_target_set_invalid';

function invalid(): never { throw Error(); }
function boundary<T>(message: string, action: () => T): T {
  try { return action(); } catch { throw new Error(message); }
}
function identifier(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || !/^[A-Za-z0-9]/.test(value) || /[^A-Za-z0-9._:-]/.test(value)) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}
function generation(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) invalid();
  return value;
}
function ownSet(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 1024) invalid();
  const count = length.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== count + 1 || keys.some(key => typeof key !== 'string'
    || (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= count)))) invalid();
  const result: string[] = [], seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    const id = identifier(descriptor.value, 128);
    if (seen.has(id)) invalid();
    seen.add(id); result.push(id);
  }
  return Object.freeze(result.sort());
}
function ownManifest(value: unknown): SeoulTargetManifest {
  if (!value || typeof value !== 'object'
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== manifestKeys.length || keys.some(key => typeof key !== 'string' || !manifestKeys.includes(key as typeof manifestKeys[number]))) invalid();
  const owned = Object.create(null) as Record<typeof manifestKeys[number], unknown>;
  for (const key of manifestKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    owned[key] = descriptor.value;
  }
  if (owned.version !== 1) invalid();
  return Object.freeze({ version: 1, manifestId: uuid(owned.manifestId), expectedGeneration: generation(owned.expectedGeneration),
    operatorReference: identifier(owned.operatorReference, 256), spaceIds: ownSet(owned.spaceIds) });
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || encoder.encode(value).byteLength > max) invalid();
  return value;
}
function manifestText(value: SeoulTargetManifest): string {
  return boundedText(JSON.stringify(value), SEOUL_TARGET_MANIFEST_MAX_BYTES);
}
function setText(value: readonly string[]): string {
  return boundedText(JSON.stringify(value), SEOUL_TARGET_SET_MAX_BYTES);
}
async function digest(text: string): Promise<string> {
  const bytes = encoder.encode(text);
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(result, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function parseSeoulTargetSet(value: unknown): readonly string[] {
  return boundary(SET_INVALID, () => ownSet(value));
}
export function encodeSeoulTargetSet(value: unknown): string {
  return boundary(SET_INVALID, () => setText(ownSet(value)));
}
export function decodeSeoulTargetSet(text: unknown): readonly string[] {
  return boundary(SET_INVALID, () => {
    const bytes = boundedText(text, SEOUL_TARGET_SET_MAX_BYTES);
    const result = ownSet(JSON.parse(bytes));
    if (setText(result) !== bytes) invalid();
    return result;
  });
}
export async function prepareSeoulTargetSet(value: unknown): Promise<SeoulTargetSetCandidate> {
  // Both the set and its exact text are owned synchronously before Web Crypto.
  const spaceIds = parseSeoulTargetSet(value), text = setText(spaceIds);
  const setSha256 = await digest(SET_DOMAIN + text);
  return Object.freeze({ spaceIds, setText: text, setSha256 });
}

export function parseSeoulTargetManifest(value: unknown): SeoulTargetManifest {
  return boundary(MANIFEST_INVALID, () => ownManifest(value));
}
export function encodeSeoulTargetManifest(value: unknown): string {
  return boundary(MANIFEST_INVALID, () => manifestText(ownManifest(value)));
}
export function decodeSeoulTargetManifest(text: unknown): SeoulTargetManifest {
  return boundary(MANIFEST_INVALID, () => {
    const bytes = boundedText(text, SEOUL_TARGET_MANIFEST_MAX_BYTES);
    const result = ownManifest(JSON.parse(bytes));
    if (manifestText(result) !== bytes) invalid();
    return result;
  });
}
export async function prepareSeoulTargetManifest(value: unknown): Promise<SeoulTargetManifestCandidate> {
  const manifest = parseSeoulTargetManifest(value), text = manifestText(manifest), spacesText = setText(manifest.spaceIds);
  const [manifestSha256, setSha256] = await Promise.all([digest(MANIFEST_DOMAIN + text), digest(SET_DOMAIN + spacesText)]);
  return Object.freeze({ manifest, manifestText: text, manifestSha256, setText: spacesText, setSha256 });
}
