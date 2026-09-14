# PixVault for Windows 0.7.9

## 修正内容

- 固定ビュワー内のネイティブ動画領域が、背後のギャラリー親要素の`overflow:hidden`で上端・左端から切り取られる問題を修正。
- `position: fixed`のビュワー境界より外側にある祖先要素を、動画のクリップ判定から除外。
- 動画ファイルの変換や置換は行わない。

## 配布物

Windows 10/11 x64では`PixVault.for.Windows_0.7.9_x64-setup.exe`を使用してください。

PC画面を使った目視確認はプロジェクト規則により実施していません。コード署名証明書がないため、WindowsインストーラーはAuthenticode未署名です。
