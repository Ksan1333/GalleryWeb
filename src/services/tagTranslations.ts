import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

import { isTauriRuntime } from "./native";

type TagTranslationDictionary = Record<string, string>;

let dictionary: TagTranslationDictionary = {};
let loadingPromise: Promise<TagTranslationDictionary> | undefined;

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function translateTagName(name: string): string {
  const normalized = normalizeKey(name);
  return dictionary[normalized]
    ?? dictionary[normalized.replace(/ /g, "_")]
    ?? name.replace(/_/g, " ");
}

export function loadTagTranslations(): Promise<TagTranslationDictionary> {
  if (loadingPromise) return loadingPromise;
  if (!isTauriRuntime()) {
    loadingPromise = Promise.resolve(dictionary);
    return loadingPromise;
  }
  loadingPromise = invoke<TagTranslationDictionary>("list_tag_translations")
    .then((value) => {
      dictionary = Object.fromEntries(
        Object.entries(value).map(([key, translated]) => [
          normalizeKey(key),
          translated,
        ]),
      );
      return dictionary;
    })
    .catch(() => dictionary);
  return loadingPromise;
}

export function useTagTranslations(): (name: string) => string {
  const [, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void loadTagTranslations().then(() => {
      if (active) setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);
  return useCallback((name: string) => translateTagName(name), []);
}
