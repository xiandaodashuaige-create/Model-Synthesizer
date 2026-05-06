import React, { useEffect, useMemo, useState } from "react";
import { Converter } from "opencc-js";
import { LangCtx, STORAGE_KEY, dict, type Lang, type Key } from "./i18n";

const VALID_LANGS: Lang[] = ["zh", "zh-TW", "en"];

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window === "undefined") return "zh";
    const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
    return saved && VALID_LANGS.includes(saved) ? saved : "zh";
  });

  useEffect(() => {
    if (typeof document !== "undefined") {
      const htmlLang = lang === "zh" ? "zh-CN" : lang === "zh-TW" ? "zh-TW" : "en";
      document.documentElement.lang = htmlLang;
    }
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, l);
  };

  // For zh-TW we don't ship a separate dictionary — we run the simplified-zh
  // strings through OpenCC's s2twp (simplified → traditional with Taiwan
  // idiom mapping, e.g. 软件→軟體, 信息→資訊). This keeps maintenance to
  // one Chinese surface while still serving Taiwan/HK readers a familiar
  // script. Memoise the converter so we don't rebuild it on every t() call.
  const s2twp = useMemo(() => Converter({ from: "cn", to: "twp" }), []);

  const t = (key: Key, vars?: Record<string, string | number>) => {
    const sourceLang: "zh" | "en" = lang === "en" ? "en" : "zh";
    const table = dict[sourceLang] as Record<string, string>;
    let s = table[key] ?? (dict.en as Record<string, string>)[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    if (lang === "zh-TW") s = s2twp(s);
    return s;
  };

  return <LangCtx.Provider value={{ lang, setLang, t }}>{children}</LangCtx.Provider>;
}
