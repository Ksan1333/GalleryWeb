# PixVault for Windows アプリ仕様書 v0.7.7

更新日: 2026-09-14。対象: Windows 10/11 x64。以下以外はv0.7.6の仕様を継承する。過去版の成果物・仕様書は保持する。

## 動画の表示比率

- libVLCのネイティブ出力へメディアを設定した直後だけでなく、再生開始後にビデオ出力の寸法が確定した時点でも、自動スケール（0）とアスペクト比上書き解除を適用する。
- ビデオ出力モジュールが再生開始時に既定値を再適用しても、元動画の比率を使ったネイティブ表示領域を維持する。
- 動画ファイルは変換・置換せず、カタログで解決した実ファイルをそのまま再生する。

## 確認方法と未確認事項

- `pnpm run typecheck`、`pnpm run test:video-playback`、`pnpm run test:viewer-interactions`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo check --manifest-path src-tauri/Cargo.toml` を実行する。
- Rust側でメディア設定後とビデオ寸法確定後に表示比率設定を呼ぶことを静的テストで確認する。
- PC画面操作禁止の規則に従い、指定動画を実アプリで表示した目視確認とインストーラーGUIは未確認。コード署名証明書がないため、WindowsインストーラーはAuthenticode未署名。

## 配布物

ビルド後に`release/0.7.7`へ版数入りインストーラー、対応libVLCソース、通知文、チェックサムを保存する。過去版の配布物は保持する。
