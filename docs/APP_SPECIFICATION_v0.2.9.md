# PixVault for Windows アプリ仕様書 v0.2.9

- 更新日: 2026-09-07
- 対象: Windows 10/11 x64、React/TypeScript + Tauri/Rust
- アプリ版数0.2.9、NSISセットアップEXE、DBスキーマ9（変更なし）
- 本書以外の機能仕様は `APP_SPECIFICATION_v0.2.8.md` を継承し、過去版は変更しない。

## ビュワーからの削除

ビュワーのゴミ箱操作は確認ダイアログの後に現在のメディアをWindowsのごみ箱へ移動する。現在の一覧に別のメディアがある場合、削除前に同じ一覧の次の要素（末尾なら直前の要素）を決定し、ビュワーのローカル状態と親画面へ置換対象を同時に渡す。親のカタログ再読み込みで削除済みメディアが一覧から外れても、置換対象の表示を維持してビュワーを閉じない。

一覧に表示できるメディアが残っていない場合のみ、削除完了後にビュワーを閉じる。削除に失敗した場合は現在の表示と操作状態を維持し、エラーをビュワー内に表示する。

## ビュワー下部操作バー

下部フッターは3列グリッドで、操作アイコン列を中央列へ配置する。操作列は多数のボタンを横スクロールでき、中央寄せを維持する。年齢区分・タグ概要は右列に配置し、狭い画面では非表示として操作列の幅を確保する。

## 検証・配布

画面操作は禁止のため、TypeScript型検査、Vite本番ビルド、既存の隔離ヘッドレス検査をCLIで実行する。実機のWindowsごみ箱、実ファイルの削除後に表示される次項目、各画面幅でのピクセル位置は未確認とし、未署名インストーラーは検証用Pre-releaseとして扱う。

配布先は `release/0.2.9/PixVault for Windows_0.2.9_x64-setup.exe`（10,767,293 bytes、SHA-256 `B17BA43F1CE58271F57DA4222D7A654D1BD4E68A8DB3FC25774261A75049E327`、未署名）。EXE、実行用バイナリ、DLL/PDB、manifest、SHA-256を保全してから `cargo clean --manifest-path src-tauri/Cargo.toml` を実行した。`src-tauri/target` は3,071,170,386 bytes（4,824ファイル）を削除し、延期対象はない。node_modules、dist、利用者データ、過去版の配布物と仕様書は削除しない。

## 変更対象ファイル

- `src/components/MediaViewer.tsx`: 削除後の置換対象を親へ渡すコールバックと、残りがない場合だけ閉じる処理。
- `src/components/MediaCollection.tsx`: カタログ更新前に置換対象を選択状態へ反映。
- `src/App.tsx`, `src/components/AdjacentSimilarityGroups.tsx`: 独立ビュワーにも同じ置換通知を適用。
- `src/components/MediaViewer.css`: 下部操作アイコンの中央配置。
