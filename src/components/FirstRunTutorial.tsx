import { useEffect, useRef, useState } from "react";
import { getJsonPreference, setJsonPreference } from "../services/native";
import { firstRunTutorialOpenEvent } from "../services/tutorial";
import { Icon, type IconName } from "./Icon";
import "./FirstRunTutorial.css";

type TutorialStatus = "inProgress" | "completed" | "skipped";

type TutorialPreference = {
  status: TutorialStatus;
  step: number;
};

type TutorialStep = {
  eyebrow: string;
  title: string;
  description: string;
  icon: IconName;
  accent: string;
  points: Array<{
    icon: IconName;
    title: string;
    description: string;
  }>;
};

type TutorialView = "loading" | "choice" | "tutorial" | "hidden";

const TUTORIAL_PREFERENCE_KEY = "onboarding.firstRun.v1";
const TUTORIAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const tutorialSteps: TutorialStep[] = [
  {
    eyebrow: "STEP 01 · LIBRARY",
    title: "最初にメディアフォルダーを登録",
    description:
      "画像、GIF、動画、PDF、ZIPが入ったフォルダーを登録すると、PixVaultが中身をカタログ化します。",
    icon: "folderPlus",
    accent: "violet",
    points: [
      {
        icon: "folder",
        title: "フォルダー構造はそのまま",
        description: "元ファイルを移動せず、サブフォルダーも含めて読み込みます。",
      },
      {
        icon: "refresh",
        title: "変更は再スキャンで反映",
        description: "追加・更新されたファイルだけを確認し、一覧とキャッシュを更新します。",
      },
      {
        icon: "trash",
        title: "登録解除は安全",
        description: "登録を解除しても、元のファイル自体は削除されません。",
      },
    ],
  },
  {
    eyebrow: "STEP 02 · GALLERY",
    title: "ギャラリーを自分好みに整理",
    description:
      "左のメニューから全体ギャラリー、画像、動画、ブックへ移動できます。フォルダー階層もそのまま辿れます。",
    icon: "gallery",
    accent: "blue",
    points: [
      {
        icon: "search",
        title: "詳細検索",
        description: "形式、フォルダー、年齢区分、タグを組み合わせて絞り込めます。",
      },
      {
        icon: "grid",
        title: "表示を右クリックで変更",
        description: "サムネイルの大きさと並び順をすぐ切り替えられます。",
      },
      {
        icon: "star",
        title: "お気に入りとタグ",
        description: "よく見るメディアをお気に入りにし、自分のタグで整理できます。",
      },
    ],
  },
  {
    eyebrow: "STEP 03 · VIEWER",
    title: "形式ごとの専用ビュワー",
    description:
      "画像、動画、ブックを開くと、閲覧に必要な操作と同じフォルダー内の一覧が表示されます。",
    icon: "play",
    accent: "pink",
    points: [
      {
        icon: "video",
        title: "動画操作",
        description: "シーク、10秒送り・戻し、コマ送り、音量、スクリーンショットに対応します。",
      },
      {
        icon: "book",
        title: "ブック閲覧",
        description: "見開き、ページ移動、しおり、綴じ方向を用途に合わせて変更できます。",
      },
      {
        icon: "sparkles",
        title: "情報とレコメンド",
        description: "タグやファイル情報、似ているメディアをサイドまたは下部で確認できます。",
      },
    ],
  },
  {
    eyebrow: "STEP 04 · ON-DEVICE AI",
    title: "AIタグ分析はPCの中で実行",
    description:
      "画像とGIFをDanbooru系のタグで分析し、タグと推定年齢区分をカタログへ保存します。",
    icon: "sparkles",
    accent: "green",
    points: [
      {
        icon: "download",
        title: "初回だけモデルを取得",
        description: "約326 MBの分析モデルとタグ定義を取得し、SHA-256で検証します。",
      },
      {
        icon: "hardDrive",
        title: "画像は外部へ送信しません",
        description: "取得したモデルを使い、対象画像の分析は端末内で行います。",
      },
      {
        icon: "stop",
        title: "範囲指定と停止",
        description: "フォルダーや期間を指定でき、実行中も進捗を確認して停止できます。",
      },
    ],
  },
  {
    eyebrow: "STEP 05 · TOOLS",
    title: "保存と資料集めもひとつの場所で",
    description:
      "お気に入りサイト、クリエイター、お絵描き資料、Xダウンローダーを便利機能から使えます。",
    icon: "download",
    accent: "orange",
    points: [
      {
        icon: "external",
        title: "アプリ内Web検索",
        description: "クリエイターのサイトを検索し、開いているURLをそのまま登録できます。",
      },
      {
        icon: "reference",
        title: "お絵描き資料",
        description: "URL、ファイル、ギャラリー、Web検索から資料をまとめられます。",
      },
      {
        icon: "download",
        title: "Xダウンローダー",
        description: "公開投稿の画像、GIF、動画を選び、履歴を確認しながら保存できます。",
      },
    ],
  },
  {
    eyebrow: "STEP 06 · SETTINGS",
    title: "準備完了です",
    description:
      "設定ではギャラリー表示、ビュワー、ブックの綴じ方向、動画再生、保存先などをいつでも変更できます。",
    icon: "check",
    accent: "violet",
    points: [
      {
        icon: "settings",
        title: "表示と操作を調整",
        description: "使い方に合わせて各画面の標準動作をまとめて設定できます。",
      },
      {
        icon: "folderPlus",
        title: "まずはフォルダーを登録",
        description: "ホームまたは設定の「追加」から、最初のライブラリーを作りましょう。",
      },
      {
        icon: "info",
        title: "困ったときは更新履歴へ",
        description: "新しく追加された機能や変更内容をアプリ内で確認できます。",
      },
    ],
  },
];

function normalizePreference(value: unknown): TutorialPreference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TutorialPreference>;
  if (
    candidate.status !== "inProgress"
    && candidate.status !== "completed"
    && candidate.status !== "skipped"
  ) {
    return undefined;
  }
  const step = Number.isFinite(candidate.step)
    ? Math.min(Math.max(Math.trunc(candidate.step ?? 0), 0), tutorialSteps.length - 1)
    : 0;
  return { status: candidate.status, step };
}

export function FirstRunTutorial({ reopenRequestId = 0 }: { reopenRequestId?: number }) {
  const [view, setView] = useState<TutorialView>("loading");
  const [stepIndex, setStepIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const reopenRequestIdRef = useRef(reopenRequestId);
  const handledReopenRequestIdRef = useRef(0);
  reopenRequestIdRef.current = reopenRequestId;

  const reopenTutorial = () => {
    setError(undefined);
    setStepIndex(0);
    setView("tutorial");
    void setJsonPreference<TutorialPreference>(
      TUTORIAL_PREFERENCE_KEY,
      { status: "inProgress", step: 0 },
    );
  };

  useEffect(() => {
    let active = true;
    void getJsonPreference<unknown>(TUTORIAL_PREFERENCE_KEY, null).then((result) => {
      if (!active) return;
      if (reopenRequestIdRef.current > 0) {
        if (handledReopenRequestIdRef.current < reopenRequestIdRef.current) {
          handledReopenRequestIdRef.current = reopenRequestIdRef.current;
          reopenTutorial();
        }
        return;
      }
      const preference = normalizePreference(result.data);
      if (preference?.status === "inProgress") {
        setStepIndex(preference.step);
        setView("tutorial");
      } else if (preference?.status === "completed" || preference?.status === "skipped") {
        setView("hidden");
      } else {
        setView("choice");
      }
      if (result.error) setError(result.error);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const reopen = () => reopenTutorial();
    window.addEventListener(firstRunTutorialOpenEvent, reopen);
    return () => window.removeEventListener(firstRunTutorialOpenEvent, reopen);
  }, []);

  useEffect(() => {
    if (reopenRequestId <= handledReopenRequestIdRef.current) return;
    handledReopenRequestIdRef.current = reopenRequestId;
    reopenTutorial();
  }, [reopenRequestId]);

  useEffect(() => {
    if (view !== "choice" && view !== "tutorial") return;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [stepIndex, view]);

  useEffect(() => {
    if (view !== "choice" && view !== "tutorial") return;

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (view === "tutorial" && !saving) {
          void saveAndHide("skipped");
        }
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(TUTORIAL_FOCUSABLE_SELECTOR),
      ).filter((element) => (
        !element.hasAttribute("disabled")
        && element.getAttribute("aria-hidden") !== "true"
        && element.getClientRects().length > 0
      ));

      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      const activeIsFocusable = activeElement instanceof HTMLElement
        && focusable.includes(activeElement);

      if (!activeIsFocusable) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleDialogKeyDown, true);
    return () => document.removeEventListener("keydown", handleDialogKeyDown, true);
  }, [saving, stepIndex, view]);

  async function saveAndHide(status: "completed" | "skipped") {
    setSaving(true);
    setError(undefined);
    const result = await setJsonPreference<TutorialPreference>(
      TUTORIAL_PREFERENCE_KEY,
      { status, step: stepIndex },
    );
    setSaving(false);
    if (!result.data) {
      setError(result.error ?? "チュートリアルの選択を保存できませんでした。");
      return;
    }
    setView("hidden");
  }

  function startTutorial() {
    setError(undefined);
    setStepIndex(0);
    setView("tutorial");
    void setJsonPreference<TutorialPreference>(
      TUTORIAL_PREFERENCE_KEY,
      { status: "inProgress", step: 0 },
    );
  }

  function moveTo(nextStep: number) {
    const normalizedStep = Math.min(Math.max(nextStep, 0), tutorialSteps.length - 1);
    setError(undefined);
    setStepIndex(normalizedStep);
    void setJsonPreference<TutorialPreference>(
      TUTORIAL_PREFERENCE_KEY,
      { status: "inProgress", step: normalizedStep },
    );
  }

  if (view === "loading" || view === "hidden") return null;

  if (view === "choice") {
    return (
      <div className="first-run-backdrop">
        <section
          className="first-run-dialog first-run-welcome"
          role="dialog"
          aria-modal="true"
          aria-labelledby="first-run-welcome-title"
          ref={dialogRef}
          tabIndex={-1}
        >
          <div className="first-run-glow" aria-hidden="true" />
          <div className="first-run-brand" aria-hidden="true">
            <span><Icon name="gallery" /></span>
            <i />
            <i />
          </div>
          <p className="first-run-kicker">WELCOME TO PIXVAULT</p>
          <h1 id="first-run-welcome-title">使い方を見てみますか？</h1>
          <p className="first-run-lead">
            フォルダー登録からビュワー、AI分析まで、約2分で基本操作をご案内します。
          </p>
          <div className="first-run-choice-features" aria-label="チュートリアルの内容">
            <span><Icon name="folderPlus" />ライブラリー登録</span>
            <span><Icon name="play" />専用ビュワー</span>
            <span><Icon name="sparkles" />端末内AI分析</span>
          </div>
          {error && <p className="first-run-error"><Icon name="warning" />{error}</p>}
          <div className="first-run-choice-actions">
            <button
              className="first-run-secondary"
              type="button"
              disabled={saving}
              onClick={() => void saveAndHide("skipped")}
            >
              チュートリアルを表示しない
            </button>
            <button
              className="first-run-primary"
              type="button"
              disabled={saving}
              onClick={startTutorial}
            >
              チュートリアルを開始
              <Icon name="arrowRight" />
            </button>
          </div>
        </section>
      </div>
    );
  }

  const step = tutorialSteps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === tutorialSteps.length - 1;
  const progress = ((stepIndex + 1) / tutorialSteps.length) * 100;

  return (
    <div className="first-run-backdrop">
      <section
        className={`first-run-dialog first-run-tutorial accent-${step.accent}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-step-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="first-run-header">
          <div className="first-run-wordmark">
            <span><Icon name="gallery" /></span>
            <strong>PixVault</strong>
            <small>QUICK TOUR</small>
          </div>
          <button
            className="first-run-close"
            type="button"
            aria-label="チュートリアルを終了"
            title="チュートリアルを終了"
            disabled={saving}
            onClick={() => void saveAndHide("skipped")}
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="first-run-progress" aria-label={`${stepIndex + 1} / ${tutorialSteps.length}`}>
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className="first-run-body">
          <aside className="first-run-visual" aria-hidden="true">
            <span className="first-run-step-number">
              {String(stepIndex + 1).padStart(2, "0")}
            </span>
            <div className="first-run-hero-icon">
              <Icon name={step.icon} />
            </div>
            <span className="first-run-orbit first-run-orbit-one" />
            <span className="first-run-orbit first-run-orbit-two" />
          </aside>

          <div className="first-run-copy">
            <p className="first-run-kicker">{step.eyebrow}</p>
            <h2 id="first-run-step-title">{step.title}</h2>
            <p className="first-run-description">{step.description}</p>
            <div className="first-run-points">
              {step.points.map((point) => (
                <article key={point.title}>
                  <span><Icon name={point.icon} /></span>
                  <div>
                    <strong>{point.title}</strong>
                    <p>{point.description}</p>
                  </div>
                </article>
              ))}
            </div>
            {error && <p className="first-run-error"><Icon name="warning" />{error}</p>}
          </div>
        </div>

        <footer className="first-run-footer">
          <div className="first-run-dots" aria-hidden="true">
            {tutorialSteps.map((item, index) => (
              <span
                className={index === stepIndex ? "is-active" : index < stepIndex ? "is-done" : ""}
                key={item.title}
              />
            ))}
          </div>
          <div className="first-run-navigation">
            {!isFirst && (
              <button
                className="first-run-secondary"
                type="button"
                disabled={saving}
                onClick={() => moveTo(stepIndex - 1)}
              >
                戻る
              </button>
            )}
            <button
              className="first-run-primary"
              type="button"
              disabled={saving}
              onClick={() => {
                if (isLast) void saveAndHide("completed");
                else moveTo(stepIndex + 1);
              }}
            >
              {isLast ? (
                <><Icon name="check" />チュートリアルを完了</>
              ) : (
                <>次へ<Icon name="arrowRight" /></>
              )}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export default FirstRunTutorial;
