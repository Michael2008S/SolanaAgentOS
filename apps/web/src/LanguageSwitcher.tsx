/** @jsxImportSource ./i18n */
import { useSyncExternalStore } from 'react';
import { getLocale, setLocale, subscribeLocale } from './i18n/locale';

export function LanguageSwitcher() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as const);
  return <div className="language-switcher" role="group" aria-label={locale === 'zh' ? '语言' : 'Language'} translate="no">
    <button type="button" lang="en" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
    <button type="button" lang="zh-CN" aria-pressed={locale === 'zh'} onClick={() => setLocale('zh')}>中文</button>
  </div>;
}
