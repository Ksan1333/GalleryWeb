# PixVault Native Preview — 0.9.0-alpha.1

Windows専用のC# / WPF版。HTML、React、WebView2、Tauriは使用しません。
現行版とは別の実行ファイルで、既存のライブラリDBや設定は読み書きしません。

## 最初の移行範囲

- PNG / JPEG / BMP / GIF（静止フレーム）、ZIP / CBZ内の画像。
- ファイルを開く、ドラッグ＆ドロップ、起動引数で開く。
- 同じフォルダー内の対応ファイルを自然順で移動。
- 通常ホイール：前後のファイル。Ctrl＋ホイール：25〜400%のズーム。
- ページボタン、スライダー、左右キー：本のページ移動。Ctrl＋左右キー：前後のファイル。
- 見開き/単ページ、右綴じ/左綴じ、NeeView風/標準。倍率ボタンで画面にフィット。
- 拡大時の移動はスクロールバー。設定先は `%LOCALAPPDATA%/PixVault.Native/reader-settings.json`。

## 未移行

動画・Media Foundation/VLC、PDF、RAR/7z、WebP/AVIF、GIFアニメーション、タグ・お気に入り・検索・AI解析、ライブラリ一覧とデータ移行、画像パン、完全なNeeView再現。

## CLIでの検証と配布

.NET 10 SDKを使用。以下のテストはウィンドウを表示しません。

```powershell
dotnet run --project native/PixVault.Core.Tests -c Release
dotnet run --project native/PixVault.Imaging.Tests -c Release
dotnet build native/PixVault.Native -c Release
dotnet publish native/PixVault.Native -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o release/native-0.9.0-alpha.1
```

生成したフォルダー全体を保存・配布します（ネイティブDLL等を含む）。アプリ本体は `PixVault.Native.exe`。
実行時に.NETの別途インストールは不要。署名なしのプレビュー版です。
GUIによる動作確認は未実施。現行版を置き換える安定版ではありません。
