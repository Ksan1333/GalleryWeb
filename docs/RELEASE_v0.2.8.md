# PixVault for Windows 0.2.8 — 動画音量の自動正規化

2026-09-07 / Windows x64 / DBスキーマ9

## 変更内容

- 動画開始時の先頭最大8秒をWeb Audioで解析し、平均レベルとピークから大音量トラックを検出。
- 大音量動画はアプリ内再生ゲインを50%へ低減。解析中も最大50%に制限し、ミュート時は無音を維持。
- 大音量動画の音量スライダー・ホイール操作は、初期50%を起点に相対的に調整。解析失敗時は既存音量を保持。
- ファイル識別情報をキーに解析結果を最大512件キャッシュし、再表示時の解析を省略。

## 確認内容

- TypeScript型検査、Vite本番ビルドに成功。
- パフォーマンス予算、ランタイム契約、テーマコントラスト、レイアウト契約、動画ビュワー操作の既存ヘッドレス検査に成功。
- Web Audioの実音声、実コーデック、実機スピーカー、インストール後の画面操作は未確認。未署名の検証用Pre-releaseとして公開する。
- NSISインストーラー: 10,764,263 bytes、SHA-256 `D6B39DBD13A85194F1DE6E5105A8F17C563A54389BFDD19B85EFD4B549B77DDE`、Authenticode `NotSigned`。

## 配布・保全・清掃

保存先: `release/0.2.8/PixVault for Windows_0.2.8_x64-setup.exe`。版数入りEXE、manifest、実行用バイナリ、DLL/PDB、SHA-256を保全し、確認後に `cargo clean --manifest-path src-tauri/Cargo.toml` を実行した。`src-tauri/target` は 3,071,146,843 bytes（4,824ファイル、Cargo表示2.9 GiB）を削除し、延期対象はない。node_modules、dist、利用者データ、過去版の配布物は保持する。
