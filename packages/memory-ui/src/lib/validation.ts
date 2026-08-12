export const MAX_SEARCH_QUERY_BYTES = 1024;
export const MAX_MEMORY_CONTENT_BYTES = 32 * 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
