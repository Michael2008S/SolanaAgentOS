/** RFC 8785 canonicalization for JSON data; reject invalid Unicode and non-JSON values. */
export function canonicalJson(value: unknown): string {
  const text = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode surrogate.');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Invalid Unicode surrogate.');
    }
    return JSON.stringify(value);
  };
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return text(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Non-finite JSON number.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + Array.from(value, canonicalJson).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(key => text(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  throw new Error('Only JSON data can be canonicalized.');
}
