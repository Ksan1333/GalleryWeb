# GalleryWeb

GalleryWeb is the Windows 10/11 edition of the Android Gallery application
(`PixVault`). It uses a React and TypeScript interface hosted by Tauri, with a
Rust backend for local file access, SQLite, Windows Recycle Bin integration,
and media processing.

The Android project remains an independent project. Interoperability is
provided through a versioned migration archive rather than shared source code
or direct access to Android's Room database.

版ごとの追加機能と修正内容は[更新履歴](CHANGELOG.md)で確認できます。
現在版の全体仕様は[アプリ仕様書 v0.2.1](docs/APP_SPECIFICATION_v0.2.1.md)を参照してください。

## インストールと起動（利用者向け）

配布するのはソースコードではなく、Windows用セットアップEXEです。利用者は
Node.js、Rust、Gitをインストールする必要はありません。

### 動作環境

- Windows 10 22H2 x64 または Windows 11 x64
- インターネット接続
  - WebView2 Runtimeが未導入のPCでの初回インストール
  - AI分析モデルの初回取得
  - ascii2d検索、Web検索、Xメディア保存を使う場合
  - 将来の自動更新を使う場合
- メディアを読み込むローカルまたは接続済みのドライブ
- 通常利用では4 GB以上、AI分析を使う場合は8 GB以上のメモリを推奨
- サムネイル・表示互換キャッシュ用に最大3 GB、AI分析を使う場合はモデル用に追加で1 GB以上の空き容量を推奨

### インストール

1. 配布された `PixVault for Windows_..._x64-setup.exe` をダウンロードします。
2. セットアップEXEをダブルクリックし、画面の案内に従います。
3. インストール完了後、Windowsのスタートメニューにある **PixVault for Windows** を選びます。

アプリ本体はユーザーごとの領域にインストールされるため、通常は管理者権限を必要としません。WebView2がないPCでは、セットアップが必要なランタイムを自動で取得します。

このワークスペースで生成済みの配布物は、プロジェクト直下の
`PixVault for Windows_0.1.32_x64-setup.exe` です。SHA-256は
`39F7A448FA909E6B9F56F925490EB8279C182A35CF9840F6EDC19C603675437A` です。

> 現在の配布物はコード署名されていません。Windows SmartScreen が警告する場合があります。一般配布の前に、信頼された認証局のコード署名証明書でセットアップEXEへ署名してください。

### 起動

インストール後はコマンドを入力する必要はありません。スタートメニューの **PixVault for Windows** をクリックして起動します。アンインストールもWindowsの「インストールされているアプリ」から行えます。

初回起動後は「フォルダーを登録」からメディアのあるフォルダーを選びます。スキャンが終わると画像、GIF、動画、PDF、ZIP/CBZがライブラリに表示されます。元ファイルは移動・複製されません。

0.1.32では、ギャラリーとフォルダー内メディアを、文字情報まで含めた正方形の小型タイルへ統一しました。ナビゲーションのギャラリーとお気に入りの間には、全形式を同じフォルダー階層で移動できる「メディアフォルダー」を追加しています。

0.1.31では、ビュワーからメディアをごみ箱へ移した後も次のメディアを開いて閲覧を継続します。動画ビュワーは変更した音量とミュート状態を保存し、次の動画や次回起動時に復元します。

0.1.30では、ブックの見開き表示を右綴じへ変更し、2ページを左、1ページを右へ配置します。左から右へ読むブックは、ビュワーの表示設定から左綴じへ切り替えられます。

0.1.29では、起動処理の遅延読込、イベント駆動のフォルダー監視、スクロール位置を保つ差分更新、表示中だけ動くGIF、上限付きPDFキャッシュ、索引付きZIP/CBZキャッシュへ刷新しました。ブックは現在ページを優先し、操作停止後に周辺17ページだけを先読みするため、没入感を保ちながらメモリとCPUの増加を抑えます。変更前の0.1.28ソース一式はハッシュ検証済みZIPに保存してあります。手順は[レイアウト復元](docs/LAYOUT_ROLLBACK.md)、版ごとの詳しい内容は[更新履歴](CHANGELOG.md)を参照してください。

### 自動更新

現時点の配布版は自動更新をまだ有効にしていません。自動更新を安全に有効化するには、次の配布基盤を先に用意する必要があります。

1. 更新情報（`latest.json`）と署名済みセットアップEXEを公開するHTTPSの配信先
2. Tauri更新署名用の秘密鍵（公開鍵だけをアプリへ埋め込む）
3. Windows SmartScreen対策のためのコード署名証明書

0.1.24は、これら3項目の構成状況を設定の「アプリ情報」に表示し、未構成の更新を受け入れない状態にしています。更新配信先を決めた後、署名検証付き更新処理を有効化します。秘密鍵はリポジトリやアプリ本体へ保存しません。具体的な配布・ロールバック手順は[署名付き更新の運用](docs/RELEASE_UPDATES.md)を参照してください。

リリース前の自動ゲート、Windows 10/11実機マトリクス、診断・復旧手順は[Windowsリリースチェックリスト](docs/RELEASE_CHECKLIST.md)にまとめています。

## 配布ビルド（開発者向け）

開発PCで次を実行すると、配布用のWindowsセットアップEXEを生成できます。

```powershell
npm.cmd run build:installer
```

生成先は `src-tauri\target\release\bundle\nsis\` です。このフォルダ内の `*-setup.exe` を利用者へ配布してください。公開前には、クリーンなWindows 10/11環境でインストール、起動、アンインストールを確認してください。

### Linux版（試験対応）

Linux用のTauri設定と、ファイルマネージャー・ごみ箱のLinux処理を用意しています。ただし、このリポジトリで生成済みのLinux配布物はなく、実機での最終確認も未実施です。Windows専用の壁紙設定とAIモニターのPC負荷グラフはLinuxでは利用できません。

Ubuntu 24.04系では、Node.js 24、Rust stableに加えて、Tauriが必要とするWebKitGTK 4.1などを導入したLinux環境で次を実行します。

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
npm install
npm run build:linux
```

生成先は `src-tauri/target/release/bundle/deb/` と `src-tauri/target/release/bundle/appimage/` です。Linux版はLinux PCまたはLinux CI上でビルドしてください。WindowsからのLinuxクロスビルドには対応していません。

## Status

The project is in its foundation milestone:

- [x] Independent Tauri + React project
- [x] Windows-first application shell
- [x] Architecture and migration contract
- [x] SQLite catalog, registered folders, manual scan, gallery listing and safe Recycle Bin deletion
- [x] Image, video, PDF, and ZIP/CBZ viewers
- [x] Tags, age ratings, favorites, bookmarks, and Gallery advanced search
- [x] Persistent and background thumbnail cache
- [x] Local image/GIF AI analysis with verified first-run model download
- [ ] Watched-folder scanner
- [x] Checksummed Android migration exporter and Windows preview/import flow
- [x] Public X post image/video download engine
- [ ] Signed automatic-update distribution

### 現在利用できる機能

- フォルダー登録、手動スキャン、画像/GIF/動画/PDF/ZIP・CBZの一覧
- 全ギャラリー共通の年月日・年月・年・なしグループ、大・中・小グリッド、年齢制限フィルター、全件分の領域確保、表示範囲だけを取得する仮想スクロール。背景右クリックで表示設定、メディア右クリックで個別年齢区分を変更
- 画像/GIF専用の「画像」画面、動画・ブック画面で、登録ルートから1階層ずつたどるフォルダー表示
- ギャラリー詳細検索（形式、登録ルートからの相対フォルダー階層、健全/R-15/R-18、複数タグ）
- 詳細検索条件の履歴保存・復元・削除と、保存件数1〜10件の設定
- 物理ファイルを移動せずに複数フォルダーをまとめる、作成・追加・改名・解除・並び替え対応の仮想フォルダーグループ
- 日時順で隣接する画像・GIFを設定した一致率でまとめ、グループ単位で閲覧できるAI類似画像表示
- すべてのビューア下部に、形式ラベル付きで開閉可能な1段横スクロールサムネイル一覧（縦ホイールでも大きく横移動）
- 動画ビュワー（シングルクリックで再生/停止、左右半分のダブルクリックで設定秒数を戻る/進む、1/30秒コマ送り、スクリーンショット、H.264 MP4からGIFへのローカル変換、ドラッグ中プレビュー付きシークバー、音量バー、ホイール音量/シーク、全画面）
- PDF/ZIP・CBZブックビュワー（2ページ見開き、左綴じ初期設定、左/右綴じ・単ページ切替、前後ページ、前後ブック、しおり一覧、ページのスクリーンショット、ドラッグプレビュー付きページバー、直近のシーク開始位置を最大5件表示するアンカー、ホイール送り、前後ページ先読み、全画面）
- 画像/GIFビュワー（元ファイルを変更しない90度単位の一時回転、ダブルクリック拡大、スクリーンショット、ホイールで前後移動できる可変サイズのPNGコマポップアップと小コマ一覧、ascii2d、壁紙、スライドショー、全画面）
- 画像・動画・ブックごとに下部の主要操作ボタン5個と並び順を設定できるビューア操作設定。画像のダブルクリック拡大と動画のキーボードシーク秒数も個別設定に対応
- 設定で切り替えられ、最小化したまま自由移動・右端で閉じたサイドバー・下部で閉じたボトムシートへスナップできる画像・動画・ブックの情報レコメンド（翻訳済みタグ、フル/相対パス、形式、MIME、容量、更新・登録日時、寸法、動画時間、ブックページ情報）
- ギャラリーで動画とブックを表示するか個別に選べる設定（画像とGIFは常時表示）
- レコメンドには同一フォルダーのランダム候補、MobileNetV3意味特徴ベクトルによる全ライブラリ類似候補（40%超・最大25件）、動画・ブックの共通タグ候補を横スクロールで表示。画像の類似度は数値と背景色で表示
- 画像・動画・ブックの現在ファイルをエクスプローラーで表示する操作と、目アイコンによるビューアメニューの一括表示/非表示
- 画像・動画・ブックのフォルダー画面では、日付グループを作らず、フォルダーと正方形サムネイルのメディアをエクスプローラーに近い小型表示で一覧化。詳細検索、現在階層をエクスプローラーで開く操作、各階層をクリックして移動できるパンくずに対応
- ビューアの画像・動画・ブックを操作領域と情報サイドバーの内側へ収め、狭い画面でもメディアがUIの下へ隠れないレイアウト
- マウスの戻るボタンによる、サブ画面、ビューア、フォルダー階層、アプリ画面の順序を保った戻る操作
- 画像・動画・ブックごとに独立したフォルダー位置の記憶（別画面へ移って戻ったときだけ、その画面の以前の位置を復元）
- 全メディア共通のお気に入り、Windowsごみ箱、タグ、健全/R-15/R-18区分
- Android版の移行ZIPをSHA-256・件数・形式まで検証し、登録済みファイルとの一致／曖昧／未検出を確認してから、メタデータ・タグ・しおり・資料・X履歴を原子的に取り込む移行機能
- 移行時の曖昧・未検出メディアをカタログから検索し、任意の割り当てだけを確定できる手動解決UI
- Windows版の表示設定、お気に入りサイト／クリエイター、資料プロジェクトなどをJSONへ書き出し／復元する設定バックアップ
- お気に入りの形式フィルターと、画像/GIF/動画/本ラベル
- 画像/GIF/ZIP・CBZ表紙・対応動画の安定キー付きJPEGキャッシュ（可視範囲を最優先、明示的な先行生成は最大2 GBまたは4万件）
- 一覧ページ、件数、フォルダー集計の短期キャッシュと、表示範囲の前後だけを保持する上限制御
- 可視範囲だけを読み込む動画/PDFサムネイル、H.264動画の実フレーム先行生成、表示中動画のフレーム取得補完、PDF先頭ページの永続キャッシュ
- WD v1.4 MOAT Tagger V2による画像/GIFのローカルAIタグ・年齢区分分析
  - 標準: 高信頼度タグを最大40件
  - 詳細: Danbooru風の一般・キャラクター・作品・作者・メタ分類と信頼度を最大120件
  - Android版Galleryから移植した9,255件の日本語タグ辞書を表示へ適用
  - 全期間/直近7・30・90日/今年/任意期間、登録フォルダー、階層式サブフォルダー選択、下位フォルダー有無で対象を指定
  - 開始後は分析を右下の進捗トレイへ移し、ほかの画面を操作しながらバックグラウンドで継続
  - 分析中の画像サムネイル、ファイル名、現在件数、進捗率をモーダルと右下進捗トレイへ表示
  - モデル取得・検証・画像前処理・タグ保存を実際に中断し、キャンセル後のAIタグ書き込みを防止
- お気に入りクリエイターへの複数リンク一括登録、登録枠のアイコン最小化、Tauri子WebViewによるアプリ内Google検索・現在ページURLの取り込み
- お絵描き資料のURL入力、ローカルファイル、ギャラリー複数選択、Web画像検索。ローカル資料は元ファイル参照またはアプリ管理の一時コピーを選べ、一時コピーは項目・プロジェクト削除や完成時に自動削除
- 公開X投稿URLの入力・ドラッグ＆ドロップ・`pixvault-x`プロトコル、画像・GIF・動画の混在複数選択、メディアごとの画質選択、保存先単位の重複検出、`userID_postID`形式での保存、X配信MP4から実アニメーションGIFへのローカル変換、画像/動画/GIFプレビューと個別削除付き履歴、保存先設定（未設定時はWindowsのDownloadsフォルダー）
- OSのファイル変更イベントを使う登録フォルダー監視と、追加された画像・GIFを再起動後も継続できる待ち行列へ保存する自動AI解析
- 読み込み・更新・サムネイル作成・Web検索・AI取得/解析などを示す、最小化可能な右下の共通進捗バー
- アプリ全体と埋め込みWebページのダークスクロールバー、ダークタイトルバー、黒基調グラデーションのトップバー
- ギャラリー内GIFのループ再生と、メディア一覧でも消えないクリック可能なフォルダーパンくず

### 未導入の実処理

- **自動更新:** アプリ側へ埋め込む公開鍵と、署名済み更新を置くHTTPS配信先が未設定のため、現配布版では無効です。

### 形式上の注意

- HEIC/HEIFは現在、一覧への登録はできますがWindows WebView2と内蔵画像処理だけでは表示変換できません。JPEG/PNG/WebPへの変換が必要です。
- WMV、MKV、AVI、MPG、MOVおよびH.265動画は、PCのWebView2/コーデック構成によって再生できない場合があります。配布互換性を優先する場合はH.264/AACのMP4を推奨します。
- 暗号化ZIP、Deflate64/Zstandard等で圧縮されたZIP、1ページ40 MBを超えるZIP内画像はブックとして開けません。
- 非常に大きいPDFは初回表示に時間とメモリを要します。
- X保存はログイン不要で取得できる公開投稿が対象です。Xの埋め込みAPIで取得できない公開・センシティブ投稿は、投稿の数値IDだけを `api.fxtwitter.com` へ送るフォールバック解析を行います。取得したメディアURLは `twimg.com` に固定して再検証します。非公開、削除済み、ログイン必須の投稿や、X側・フォールバック側の仕様変更時は取得できない場合があります。保存・再利用する権利があるメディアだけを扱ってください。
- XのアニメーションGIF変換は長辺720 px、最大360フレーム、出力256 MBまでです。変換に失敗した場合は履歴を失敗として記録し、再変換や確認に使える一時MP4を保存先へ残します。

See [Architecture](docs/ARCHITECTURE.md), [Migration contract](docs/MIGRATION.md),
[feature parity](docs/FEATURE_PARITY.md), [AI analysis](docs/AI_ANALYSIS.md), and
[Roadmap](docs/ROADMAP.md).

## 開発環境

開発には次が必要です。これらは利用者側には不要です。

- Node.js 24 or later
- Rust stable
- Microsoft C++ Build Tools and Windows SDK
- WebView2 Runtime

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run tauri dev
```

ローカル検証一式:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

サムネイル生成のReleaseベンチマーク:

```powershell
npm.cmd run perf:thumbnails
```

12論理CPUでの0.1.29実測では、画像・GIF・H.264動画・ZIPを混ぜた32件のcold生成が1ワーカー1,240 msから4ワーカー443 msへ短縮し、スループットは2.80倍になりました。既存キャッシュ確認のp95は全形式0.34 ms以下、SQLite検索は0.015 msでした。測定条件と全結果は[サムネイルベンチマークJSON](artifacts/thumbnail-benchmark-0.1.29.json)を参照してください。

If Rust was installed after the terminal was opened, start a new terminal or
prepend `%USERPROFILE%\.cargo\bin` to `PATH`.

## Data policy

Media and metadata stay local by default. AI analysis needs network access only
for its first verified model download; inference runs locally after that.
When the user explicitly chooses ascii2d, PixVault converts the selected image
to a bounded JPEG and uploads that copy to ascii2d for reverse-image search.
General Web search sends the entered terms to Bing RSS, image search sends them
to Wikimedia Commons, and favorite-creator search opens Google in a PixVault
child WebView. A selected URL is saved locally as metadata; the Web search
feature itself does not copy the remote image. X media
download is a separate, explicit operation.
The current keyless Bing RSS integration is intended for personal/noncommercial
evaluation. Before commercial distribution, replace it with a licensed search
API or obtain the required provider permission. Wikimedia results can have
different licenses; confirm the source page before redistributing an image.
X download sends the public post ID to X's public syndication endpoint and
downloads only selected media URLs returned from X's `twimg.com` CDN. X animated
GIFs are distributed by X as MP4; PixVault decodes that temporary file locally,
encodes an animated GIF, atomically saves the `.gif`, and removes the temporary
MP4 only after successful conversion. No X credential is stored. Automatic
update checks will require network access when enabled.
Deleting media sends it to the Windows Recycle Bin; GalleryWeb does not
implement a private trash folder.
