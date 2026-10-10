/** @jsxImportSource react */
import React, { createContext, createElement, useContext, useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, translate } from './locale';
export { Fragment } from 'react';
export type { JSX } from 'react';
const OriginalContent = createContext(false);
const attributes = ['title', 'placeholder', 'aria-label', 'alt', 'aria-description'] as const;
const originalTags = new Set(['pre', 'code', 'textarea', 'script', 'style']);

/** Localize host presentation without changing component state or form values. */
function LocalizedHost({ elementType, ...props }: Record<string, unknown> & { elementType: string }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as const);
  const inherited = useContext(OriginalContent);
  const original = inherited || props.translate === 'no' || props['data-i18n'] === 'off';
  const next = { ...props };
  if (!original) {
    for (const attribute of attributes) if (typeof next[attribute] === 'string') next[attribute] = translate(next[attribute] as string, locale);
    if (!originalTags.has(elementType)) next.children = React.Children.map(props.children as React.ReactNode, child => typeof child === 'string' ? translate(child, locale) : child);
  }
  const element = createElement(elementType, next);
  return original || originalTags.has(elementType) ? createElement(OriginalContent.Provider, { value: true }, element) : element;
}
export function jsx(type: React.ElementType, props: Record<string, unknown> | null, key?: React.Key) {
  if (type === React.Fragment) return createElement(LocalizedFragment, { ...props, key });
  return typeof type === 'string' ? createElement(LocalizedHost, { ...props, elementType: type, key }) : createElement(type, { ...props, key });
}
export const jsxs = jsx;

function LocalizedFragment({ children }: { children?: React.ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as const);
  const original = useContext(OriginalContent);
  return createElement(React.Fragment, null, React.Children.map(children, child => !original && typeof child === 'string' ? translate(child, locale) : child));
}
