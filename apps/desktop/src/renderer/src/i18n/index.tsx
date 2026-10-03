import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_LANG, format, getLang, isLang, setLang, translator, type Entry, type Lang, type Params } from '@bm/shared';
import { useBm } from '../lib/query';
import { messages } from './messages';

/**
 * Interface language (D69). `t()` returns a string in the current language; `tx()` also takes React nodes as
 * parameters and wraps `<tag>…</tag>` parts of the text with the given renderers. Texts with a module-level life
 * (labels, constants) are functions, so they follow a change of language; the tree under the provider is remounted.
 */
export type MessageKey = keyof typeof messages;
export const t = translator(messages);
export { getLang };

type NodeParams = Record<string, ReactNode>;
type Tags = Record<string, (children: ReactNode) => ReactNode>;

const TOKEN = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;

export function tx(key: MessageKey, params: NodeParams = {}, tags: Tags = {}): ReactNode {
  const lang = getLang();
  const plain: Params = {};
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' || typeof v === 'number') plain[k] = v;
  const text = format((messages[key] as Entry)[lang], plain, lang);
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [whole, tag, inner, name] = m;
    if (tag !== undefined) out.push(<Fragment key={i++}>{tags[tag] ? tags[tag](inner) : inner}</Fragment>);
    else out.push(name !== undefined && name in params ? <Fragment key={i++}>{params[name]}</Fragment> : whole);
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 1 ? out[0] : out;
}

const STORE_KEY = 'bm.lang';

function storedLang(): Lang | null {
  try {
    const l = localStorage.getItem(STORE_KEY);
    return isLang(l) ? l : null;
  } catch {
    return null;
  }
}

interface LangState {
  lang: Lang;
  /** Switches the window only (the first-run wizard, before app.yaml exists); the setting itself is app.yaml `language`. */
  setLang: (lang: Lang) => void;
}

const LangContext = createContext<LangState>({ lang: DEFAULT_LANG, setLang: () => undefined });
export const useLang = (): LangState => useContext(LangContext);

/** Follows app.yaml `language`; the last one is remembered so the window does not flash another language on start. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const app = useBm('config.app', {});
  const [lang, setLangState] = useState<Lang>(() => storedLang() ?? DEFAULT_LANG);
  const fromConfig = app.data?.language;
  useEffect(() => {
    if (isLang(fromConfig)) setLangState(fromConfig);
  }, [fromConfig]);
  setLang(lang);
  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem(STORE_KEY, lang);
    } catch {
      /* storage unavailable */
    }
  }, [lang]);
  return (
    <LangContext.Provider value={{ lang, setLang: setLangState }}>
      <Fragment key={lang}>{children}</Fragment>
    </LangContext.Provider>
  );
}

export type { Entry };
