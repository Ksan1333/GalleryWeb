# PixVault for Windows アプリ仕様書 v0.2.10

- 更新日: 2026-09-07
- 対象: Windows 10/11 x64、React/TypeScript + Tauri/Rust
- アプリ版数: 0.2.10、NSISセットアップEXE、DBスキーマ9（変更なし）
- 本書以外の機能仕様は `APP_SPECIFICATION_v0.2.9.md` を継承し、過去版は変更しない。

## 動画ビューアーの読み込み表示

動画を開くときは、`loadedmetadata` を待つだけでなく、`canplay`、`loadeddata`、`play`、`playing` のいずれかで再生可能または再生開始と判断する。再生が始まっている動画には、画面全体を覆うローディングオーバーレイを表示しない。

動画要素の読み込みが15秒間進まず、メタデータも取得できない場合は、ローディング状態を解除して、ファイルの場所・アクセス許可・MP4メタデータの確認を促すエラーをビュワー内に表示する。メタデータだけ取得できている場合や手動再生が可能な場合はエラーにせず、ローディング表示だけを解除する。

メディアを切り替える際は、前のファイルの状態を引き継がない新しい`video`要素を生成し、外部ファイルの読み込みイベントをそのメディアに紐付ける。

## 検証・配布

画面操作は禁止のため、TypeScript型検査、Vite本番ビルド、ビュワー操作の隔離ヘッドレス検査をCLIで実行する。実機のWebView2での外部MP4再生、各画面幅でのピクセル位置、実際のインストーラー起動は未確認とし、未署名インストーラーは検証用Pre-releaseとして扱う。

配布先は `release/0.2.10/PixVault for Windows_0.2.10_x64-setup.exe`（10,766,653 bytes、SHA-256 `AC812D682434501290CD04D29F44963FAE52E280475C0ADBAA256B16BF37AF7E`、未署名）。EXE、実行用バイナリ、PDB、DLL、manifest、SHA-256を保全してから `cargo clean --manifest-path src-tauri/Cargo.toml` を実行する。

## 変更対象ファイル

- `src/components/MediaViewer.tsx`: 動画の再生可能イベント、読み込みタイムアウト、新しい`video`要素による状態分離。
- `scripts/test-viewer-interactions.mjs`: 再生中に全画面ローディングが残らないことのヘッドレス検査。
- `src/releaseNotes.ts`, `CHANGELOG.md`: 0.2.10の変更履歴。
