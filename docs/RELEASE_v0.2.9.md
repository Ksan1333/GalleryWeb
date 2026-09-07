# PixVault for Windows 0.2.9 — ビュワー削除継続と操作バー中央配置

2026-09-07 / Windows x64 / DBスキーマ9

## 変更内容

- ビュワーで現在のメディアをゴミ箱へ移動しても、次のメディアを同じビュワーで表示。
- カタログ再読み込みと削除済みアイテムの除去が競合しても、置換対象を親へ引き継ぎ、ビュワーを閉じない。
- 下部操作アイコンを中央寄せにし、年齢区分・タグ概要を右列へ配置。

## 確認内容

- TypeScript型検査、Vite本番ビルド、パフォーマンス・テーマ・レイアウト・ビュワー操作のCLI/隔離ヘッドレス検査に成功。
- 実機のWindowsごみ箱、実ファイルを削除した直後の次項目表示、画面上のピクセル配置はPC画面操作禁止のため未確認。
- NSISインストーラーは10,767,293 bytes、SHA-256 `B17BA43F1CE58271F57DA4222D7A654D1BD4E68A8DB3FC25774261A75049E327`、Authenticode `NotSigned`。未署名の検証用Pre-releaseとして公開する。

## 配布・保全・清掃

保存先: `release/0.2.9/PixVault for Windows_0.2.9_x64-setup.exe`。版数入りEXE、manifest、実行用バイナリ、DLL/PDB、SHA-256を保全し、確認後に `cargo clean --manifest-path src-tauri/Cargo.toml` を実行した。`src-tauri/target` は3,071,170,386 bytes（4,824ファイル、Cargo表示2.9 GiB）を削除し、延期対象はない。node_modules、dist、利用者データ、過去版の配布物は保持する。
