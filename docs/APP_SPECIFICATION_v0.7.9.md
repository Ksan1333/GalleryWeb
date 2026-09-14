# PixVault for Windows アプリ仕様書 v0.7.9

## 動画表示

- Windows版の動画は同梱libVLCの埋め込みネイティブ表示を使用する。
- 動画表示領域は、固定ビュワー自身とその内部要素だけを可視範囲として計算する。
- ビュワーを配置しているギャラリー親ページの`overflow:hidden`やスクロール枠は、動画表示を切り取らない。
- 動画の実寸取得後も自動スケールと元アスペクト比を再適用し、上端・下端を切り取らず表示する。
- 動画ファイルは再生時に変換・置換しない。

## 検証

- `pnpm run typecheck`
- `pnpm run test:video-playback`
- `pnpm run test:viewer-interactions`
- `cargo fmt --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `pnpm run build:installer`

PC画面を使った目視確認はプロジェクト規則により実施していないため、実機での表示位置・DPI差異は未確認。
