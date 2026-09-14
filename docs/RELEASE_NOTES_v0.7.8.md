# PixVault for Windows 0.7.8

## 修正内容

- Windowsの埋め込みlibVLCでDirect3D9を優先し、Direct3D11経路で動画上端が欠ける問題を修正。
- Direct3D9が使用できない場合はlibVLCの自動選択へ切り替える。
- 再生制御とハードウェアデコードは維持し、動画ファイル自体の変換は行わない。

## 配布物

Windows 10/11 x64では`PixVault.for.Windows_0.7.8_x64-setup.exe`を使用してください。

PC画面を使った目視確認はプロジェクト規則により実施していません。コード署名証明書がないため、WindowsインストーラーはAuthenticode未署名です。
