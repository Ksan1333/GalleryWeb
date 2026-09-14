# PixVault for Windows アプリ仕様書 v0.7.8

## 動画表示

- Windows版の動画は同梱libVLCの埋め込みネイティブ表示を使用する。
- ビデオ出力はDirect3D9を優先し、利用できない環境ではlibVLCの自動選択へフォールバックする。
- 動画の実寸取得後も自動スケールと元アスペクト比を再適用し、上端・下端を切り取らず表示する。
- 動画ファイルは再生時に変換・置換しない。

## 検証

- `pnpm run typecheck`
- `pnpm run test:video-playback`
- `cargo fmt --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `pnpm run build:installer`

PC画面を使った目視確認はプロジェクト規則により実施していないため、実機での表示位置・DPI差異は未確認。
