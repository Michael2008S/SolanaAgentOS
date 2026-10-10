import { messages } from './messages';
import { templates } from './templates';

export type Locale = 'en' | 'zh';
const storageKey = 'agentos:language';
const listeners = new Set<() => void>();
function savedLocale(): Locale {
  try { return localStorage.getItem(storageKey) === 'zh' ? 'zh' : 'en'; } catch { return 'en'; }
}
let current: Locale = typeof window === 'undefined' ? 'en' : savedLocale();
export function getLocale(): Locale { return current; }
export function subscribeLocale(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function apply(locale: Locale) {
  current = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  listeners.forEach(listener => listener());
}
export function setLocale(locale: Locale) {
  try { localStorage.setItem(storageKey, locale); } catch { /* Language remains usable without storage. */ }
  apply(locale);
}
if (typeof window !== 'undefined') {
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  window.addEventListener('storage', event => { if (event.key === storageKey || event.key === null) apply(savedLocale()); });
}
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const catalog = new Map(Object.entries(messages).map(([en, zh]) => [normalize(en), zh]));
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(templates).map(([en, zh]) => {
  const indices: number[] = [];
  const literals: string[] = [];
  const parts = en.split(/(\{\d+\})/g).map(part => {
    if (/^\{\d+\}$/.test(part)) { indices.push(Number(part.slice(1, -1))); return '([\\s\\S]*?)'; }
    if (part.trim().length > 1) literals.push(part.trim());
    return escapeRegex(part);
  });
  const localizedValues = /^(Automatic |Encrypted key backup:|Session pays |Actions:|Enabled actions:|Current status:|New status:|Decision )/.test(en);
  return { regex: new RegExp('^' + parts.join('') + '$'), indices, zh, literals, localizedValues };
});
/** Presentation only. Never apply to transaction bytes, task content or stored artifacts. */
export function translate(text: string, locale = current): string {
  const normalized = normalize(text);
  if (locale === 'en') return text;
  if (text.startsWith('Error: ')) return '错误：' + translate(text.slice(7), locale);
  const translated = catalog.get(normalized);
  if (translated !== undefined) return text.match(/^\s*/)?.[0] + translated + (text.match(/\s*$/)?.[0] ?? '');
  for (const pattern of patterns) {
    if (!pattern.literals.every(literal => text.includes(literal))) continue;
    const match = pattern.regex.exec(text.trim());
    if (!match) continue;
    const values = new Map(pattern.indices.map((index, at) => {
      const value = match[at + 1];
      return [index, pattern.localizedValues ? catalog.get(normalize(value)) ?? value : value];
    }));
    return (text.match(/^\s*/)?.[0] ?? '') + pattern.zh.replace(/\{(\d+)\}/g, (_token, index) => values.get(Number(index)) ?? '') + (text.match(/\s*$/)?.[0] ?? '');
  }
  // Dynamic review labels have a fixed prefix followed by an address, amount,
  // hash, timestamp or original diagnostic. Leave those values byte-for-byte intact.
  const colon = text.indexOf(':');
  if (colon >= 0) {
    const prefix = text.slice(0, colon + 1);
    const label = catalog.get(normalize(prefix));
    if (label !== undefined) return (prefix.match(/^\s*/)?.[0] ?? '') + label + text.slice(colon + 1);
  }
  return text;
}
export function displayLocale() { return current === 'zh' ? 'zh-CN' : 'en-US'; }
