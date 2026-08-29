import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  closeInAppBrowser,
  controlInAppBrowser,
  getInAppBrowserUrl,
  openInAppBrowser,
  setInAppBrowserBounds,
  type InAppBrowserAction,
  type InAppBrowserBounds,
} from "../services/native";
import {
  searchWeb,
  type WebSearchMode,
  type WebSearchResult,
} from "../services/webSearch";
import {
  startOperation,
  type OperationHandle,
} from "../services/operations";
import { useAppBack } from "../hooks/useAppBack";
import { Icon } from "./Icon";
import "./WebSearchModal.css";

export type { WebSearchMode, WebSearchResult } from "../services/webSearch";

export type WebSearchModalProps = {
  open: boolean;
  query?: string;
  mode?: WebSearchMode;
  provider?: "internal" | "google";
  title?: string;
  onClose: () => void;
  onSelect: (result: WebSearchResult) => void;
};

function resultFromUrl(value: string): WebSearchResult | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
    ) {
      return undefined;
    }
    parsed.hash = "";
    return {
      url: parsed.toString(),
      title: parsed.hostname,
      displayUrl: `${parsed.hostname}${parsed.pathname}`,
    };
  } catch {
    return undefined;
  }
}

function getEmbeddedBrowserBounds(
  element: HTMLElement | null,
): InAppBrowserBounds | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, rect.left);
  const y = Math.max(0, rect.top);
  const width = Math.min(rect.width, window.innerWidth - x);
  const height = Math.min(rect.height, window.innerHeight - y);
  if (width < 240 || height < 160) return undefined;
  return { x, y, width, height };
}

function afterBrowserViewportPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export function WebSearchModal({
  open,
  query = "",
  mode = "web",
  provider = "internal",
  title,
  onClose,
  onSelect,
}: WebSearchModalProps) {
  const closeModal = useCallback(() => {
    void closeInAppBrowser();
    onClose();
  }, [onClose]);
  useAppBack(open, closeModal);
  const [searchText, setSearchText] = useState(query);
  const [results, setResults] = useState<WebSearchResult[]>([]);
  const [selected, setSelected] = useState<WebSearchResult>();
  const [loading, setLoading] = useState(false);
  const [capturingUrl, setCapturingUrl] = useState(false);
  const [searched, setSearched] = useState(false);
  const [browserUrl, setBrowserUrl] = useState<string>();
  const [browserReady, setBrowserReady] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const browserViewportRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const activeOperationRef = useRef<OperationHandle | null>(null);
  const onCloseRef = useRef(closeModal);

  useEffect(() => {
    onCloseRef.current = closeModal;
  }, [closeModal]);

  const openEmbeddedBrowser = useCallback(async (url: string) => {
    setBrowserUrl(url);
    setBrowserReady(false);
    await afterBrowserViewportPaint();
    const bounds = getEmbeddedBrowserBounds(browserViewportRef.current);
    if (!bounds) {
      throw new Error("アプリ内ブラウザーの表示領域を準備できませんでした。");
    }
    const openResult = await openInAppBrowser(url, bounds);
    if (!openResult.available) {
      throw new Error("アプリ内ブラウザーはPixVaultのインストール版で利用できます。");
    }
    if (openResult.error || !openResult.data) {
      throw new Error(openResult.error ?? "アプリ内ブラウザーを開けませんでした。");
    }
    setBrowserReady(true);
  }, []);

  const runSearch = useCallback(async (input: string) => {
    const normalized = input.trim();
    if (!normalized) {
      setError("検索語またはURLを入力してください。");
      inputRef.current?.focus();
      return;
    }

    activeOperationRef.current?.cancel("新しい検索を開始しました", 800);
    if (provider !== "google") {
      void closeInAppBrowser();
      setBrowserUrl(undefined);
      setBrowserReady(false);
      await afterBrowserViewportPaint();
    }
    const requestId = ++requestIdRef.current;
    const detail = normalized.length > 72
      ? `${normalized.slice(0, 71)}…`
      : normalized;
    const operation = startOperation({
      label: "Webを検索",
      detail,
      progress: null,
    });
    activeOperationRef.current = operation;
    setLoading(true);
    setSearched(true);
    setError(undefined);

    try {
      if (provider === "google") {
        const googleUrl = new URL("https://www.google.com/search");
        googleUrl.searchParams.set("q", normalized);
        await openEmbeddedBrowser(googleUrl.toString());
        if (requestId !== requestIdRef.current) {
          void closeInAppBrowser();
          operation.dismiss();
          return;
        }
        setResults([]);
        setSelected(undefined);
        setLoading(false);
        operation.succeed("Google検索をPixVault内に表示しました");
        return;
      }

      const result = await searchWeb(normalized, mode);
      if (requestId !== requestIdRef.current) {
        operation.dismiss();
        return;
      }

      setResults(result.data);
      setSelected(result.data[0]);
      setError(result.error);
      setLoading(false);
      if (result.error) {
        operation.fail(result.error);
      } else {
        operation.succeed(`${result.data.length}件の候補を取得しました`);
      }
    } catch (searchError) {
      if (requestId !== requestIdRef.current) {
        operation.dismiss();
        return;
      }
      const message = searchError instanceof Error
        ? searchError.message
        : String(searchError);
      setResults([]);
      setSelected(undefined);
      setError(message);
      setLoading(false);
      operation.fail(searchError);
    } finally {
      if (activeOperationRef.current?.id === operation.id) {
        activeOperationRef.current = null;
      }
    }
  }, [mode, openEmbeddedBrowser, provider]);

  useEffect(() => {
    if (!open || !browserUrl || !browserReady) return;
    const viewport = browserViewportRef.current;
    if (!viewport) return;
    let frame = 0;
    let lastBounds = "";

    const syncBounds = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const bounds = getEmbeddedBrowserBounds(viewport);
        if (!bounds) return;
        const serialized = [
          bounds.x.toFixed(2),
          bounds.y.toFixed(2),
          bounds.width.toFixed(2),
          bounds.height.toFixed(2),
        ].join(":");
        if (serialized === lastBounds) return;
        lastBounds = serialized;
        void setInAppBrowserBounds(bounds);
      });
    };

    const observer = new ResizeObserver(syncBounds);
    observer.observe(viewport);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);
    syncBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      window.cancelAnimationFrame(frame);
    };
  }, [browserReady, browserUrl, open]);

  useEffect(() => {
    if (!open || !browserReady) return;
    let stopped = false;
    let timer = 0;

    const refreshCurrentUrl = async () => {
      const current = await getInAppBrowserUrl();
      if (
        !stopped
        && current.available
        && !current.error
        && current.data
      ) {
        setBrowserUrl(current.data);
      }
      if (!stopped) {
        timer = window.setTimeout(() => void refreshCurrentUrl(), 900);
      }
    };

    timer = window.setTimeout(() => void refreshCurrentUrl(), 500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [browserReady, open]);

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1;
      return;
    }

    setSearchText(query);
    setResults([]);
    setSelected(undefined);
    setSearched(false);
    setBrowserUrl(undefined);
    setBrowserReady(false);
    setError(undefined);
    setLoading(false);
    setCapturingUrl(false);

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 40);
    const searchTimer = query.trim()
      ? window.setTimeout(() => void runSearch(query), 90)
      : undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = [...(modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.getClientRects().length > 0);
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !modalRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      requestIdRef.current += 1;
      activeOperationRef.current?.cancel("検索を中断しました", 800);
      activeOperationRef.current = null;
      window.clearTimeout(focusTimer);
      if (searchTimer !== undefined) window.clearTimeout(searchTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      void closeInAppBrowser();
      previousFocus?.focus();
    };
  }, [open, query, runSearch]);

  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(searchText);
  }

  function choose(result: WebSearchResult) {
    onSelect(result);
    closeModal();
  }

  async function openSelected(result: WebSearchResult) {
    setError(undefined);
    try {
      await openEmbeddedBrowser(result.url);
    } catch (browserError) {
      setError(browserError instanceof Error ? browserError.message : String(browserError));
    }
  }

  async function captureCurrentPage() {
    setCapturingUrl(true);
    setError(undefined);
    const current = await getInAppBrowserUrl();
    setCapturingUrl(false);
    if (!current.available) {
      setError("現在ページの取得はPixVaultのインストール版で利用できます。");
      return;
    }
    if (current.error || !current.data) {
      setError(current.error ?? "アプリ内ブラウザーの現在ページを取得できませんでした。");
      return;
    }
    const result = resultFromUrl(current.data);
    if (!result) {
      setError("現在ページから有効な http:// または https:// URLを取得できませんでした。");
      return;
    }
    choose(result);
  }

  async function controlBrowser(action: InAppBrowserAction) {
    setError(undefined);
    const result = await controlInAppBrowser(action);
    if (!result.available) {
      setError("ブラウザー操作はPixVaultのインストール版で利用できます。");
    } else if (result.error || !result.data) {
      setError(result.error ?? "ブラウザーを操作できませんでした。");
    }
  }

  function returnToResults() {
    void closeInAppBrowser();
    setBrowserReady(false);
    setBrowserUrl(undefined);
  }

  const heading = title ?? (mode === "image" ? "Webから画像を探す" : "Webサイトを検索");
  const showingEmbeddedBrowser = provider === "google" || Boolean(browserUrl);

  return (
    <div
      className="web-search-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeModal();
      }}
    >
      <section
        ref={modalRef}
        className="web-search-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="web-search-header">
          <div>
            <span className="web-search-header-icon">
              <Icon name={mode === "image" ? "image" : "search"} />
            </span>
            <div>
              <p>
                {mode === "image"
                  ? "IMAGE SEARCH"
                  : provider === "google"
                    ? "GOOGLE SEARCH"
                    : "WEB SEARCH"}
              </p>
              <h2 id="web-search-title">{heading}</h2>
            </div>
          </div>
          <div className="web-search-header-actions">
            {browserUrl && (
              <button
                className="web-search-use-current"
                type="button"
                disabled={!browserReady || capturingUrl}
                onClick={() => void captureCurrentPage()}
              >
                {capturingUrl
                  ? <span className="spinner" aria-hidden="true" />
                  : <Icon name="check" />}
                このURLにする
              </button>
            )}
            <button type="button" aria-label="Web検索を閉じる" onClick={closeModal}>
              <Icon name="close" />
            </button>
          </div>
        </header>

        <form className="web-search-form" onSubmit={submit}>
          <label>
            <Icon name={mode === "image" ? "image" : "search"} />
            <span className="sr-only">検索語またはURL</span>
            <input
              ref={inputRef}
              type="search"
              maxLength={256}
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              readOnly={provider === "google"}
              placeholder={mode === "image"
                ? "画像のキーワード、または https://..."
                : "クリエイター名、サイト名、または https://..."}
            />
            {searchText && provider !== "google" && (
              <button
                className="web-search-input-clear"
                type="button"
                aria-label="入力を消去"
                onClick={() => {
                  setSearchText("");
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" />
              </button>
            )}
          </label>
          <button className="web-search-submit" type="submit" disabled={loading}>
            {loading
              ? <><span className="spinner" aria-hidden="true" />検索中</>
              : <><Icon name="search" />{provider === "google" ? "Googleで検索" : "検索"}</>}
          </button>
        </form>

        {error && (
          <div className="web-search-error" role="alert">
            <Icon name="warning" />
            <span>{error}</span>
            <button type="button" onClick={() => void runSearch(searchText)}>再試行</button>
          </div>
        )}

        {showingEmbeddedBrowser ? (
          <div className="web-search-embedded">
            <nav className="web-search-browser-toolbar" aria-label="アプリ内ブラウザー操作">
              <div className="web-search-browser-navigation">
                <button
                  type="button"
                  title="前のページへ戻る"
                  aria-label="前のページへ戻る"
                  disabled={!browserReady}
                  onClick={() => void controlBrowser("back")}
                >
                  <Icon name="stepBack" />
                </button>
                <button
                  type="button"
                  title="次のページへ進む"
                  aria-label="次のページへ進む"
                  disabled={!browserReady}
                  onClick={() => void controlBrowser("forward")}
                >
                  <Icon name="stepForward" />
                </button>
                <button
                  type="button"
                  title="再読み込み"
                  aria-label="再読み込み"
                  disabled={!browserReady}
                  onClick={() => void controlBrowser("reload")}
                >
                  <Icon name="refresh" />
                </button>
              </div>
              <div className="web-search-browser-address" title={browserUrl}>
                <span aria-hidden="true" />
                <Icon name="external" />
                <strong>{browserUrl ?? "Google検索を準備しています"}</strong>
              </div>
              {provider !== "google" && (
                <button
                  className="web-search-browser-return"
                  type="button"
                  onClick={returnToResults}
                >
                  検索結果へ戻る
                </button>
              )}
            </nav>
            <div className="web-search-browser-frame">
              <div
                ref={browserViewportRef}
                className="web-search-browser-viewport"
                aria-label="Webページ表示領域"
              />
              {!browserReady && (
                <div className="web-search-browser-loading" role="status">
                  {loading
                    ? <span className="spinner" aria-hidden="true" />
                    : <Icon name="search" />}
                  <strong>{loading ? "ページを読み込んでいます…" : "検索を開始してください"}</strong>
                  <p>Webページはこの枠の内側に表示されます。</p>
                </div>
              )}
            </div>
          </div>
        ) : (
        <div className="web-search-content">
          <section className="web-search-results" aria-label="Web検索結果">
            <div className="web-search-results-heading">
              <span>検索結果</span>
              {searched && !loading && <b>{results.length}件</b>}
            </div>

            {!searched && (
              <div className="web-search-state">
                <span><Icon name="search" /></span>
                <strong>検索語を入力してください</strong>
                <p>URLを直接入力した場合も、安全な形式を確認して選択できます。</p>
              </div>
            )}
            {loading && (
              <div className="web-search-state" role="status">
                <span className="spinner" aria-hidden="true" />
                <strong>Webを検索しています…</strong>
                <p>最大9秒でタイムアウトします。</p>
              </div>
            )}
            {searched && !loading && results.length === 0 && !error && (
              <div className="web-search-state">
                <span><Icon name="info" /></span>
                <strong>結果が見つかりませんでした</strong>
                <p>検索語を短くするか、別の表記を試してください。</p>
              </div>
            )}

            {!loading && results.length > 0 && (
              <div className="web-search-result-list">
                {results.map((result) => {
                  const active = selected?.url === result.url;
                  return (
                    <article
                      className={active ? "web-search-result active" : "web-search-result"}
                      key={result.url}
                    >
                      <button
                        className="web-search-result-main"
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelected(result)}
                      >
                        {result.thumbnailUrl ? (
                          <img
                            src={result.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="web-search-result-icon">
                            <Icon name={mode === "image" ? "image" : "external"} />
                          </span>
                        )}
                        <span className="web-search-result-copy">
                          <strong>{result.title}</strong>
                          <small>{result.displayUrl}</small>
                          {result.snippet && <p>{result.snippet}</p>}
                        </span>
                      </button>
                      <button
                        className="web-search-result-check"
                        type="button"
                        aria-label={`${result.title}を選択`}
                        title="このURLを選択"
                        onClick={() => choose(result)}
                      >
                        <Icon name="check" />
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <aside className="web-search-preview" aria-label="選択中の検索結果">
            {selected ? (
              <>
                <div className="web-search-preview-label">
                  <span>選択中</span>
                  <Icon name="check" />
                </div>
                <div className="web-search-preview-visual">
                  {selected.thumbnailUrl ? (
                    <img
                      src={selected.thumbnailUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span><Icon name={mode === "image" ? "image" : "external"} /></span>
                  )}
                </div>
                <strong>{selected.title}</strong>
                <a
                  href={selected.url}
                  onClick={(event) => {
                    event.preventDefault();
                    void openSelected(selected);
                  }}
                >
                  {selected.displayUrl}<Icon name="external" />
                </a>
                {selected.snippet && <p>{selected.snippet}</p>}
                <div className="web-search-preview-actions">
                  <button type="button" onClick={() => void openSelected(selected)}>
                    <Icon name="external" />アプリ内で確認
                  </button>
                  <button type="button" onClick={() => choose(selected)}>
                    <Icon name="check" />このURLを使う
                  </button>
                </div>
              </>
            ) : (
              <div className="web-search-preview-empty">
                <span><Icon name={mode === "image" ? "image" : "external"} /></span>
                <strong>結果を選択すると、ここに表示します</strong>
                <p>ページは自動で開かれません。確認するときだけアプリ内ブラウザーを開きます。</p>
              </div>
            )}
          </aside>
        </div>
        )}

        <footer className="web-search-footer">
          <span>
            <Icon name="info" />
            {mode === "image"
              ? "画像結果: Wikimedia Commons"
              : provider === "google"
                ? "検索: Google（PixVault内のブラウザーで開きます）"
                : "Web結果: Bing RSS"}
          </span>
          <button type="button" onClick={closeModal}>キャンセル</button>
        </footer>
      </section>
    </div>
  );
}
