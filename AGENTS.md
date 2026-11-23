# AGENTS.md

## コマンド

| コマンド                            | 内容                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm test`                         | `orca plugin test .` でテストを実行する（vitest。`orca/testing` は Orca が解決する） |
| `pnpm typecheck`                    | Orca の型定義を `.orca/types` に生成してから `tsc` で検査する                        |
| `pnpm lint` / `pnpm lint:fix`       | oxlint                                                                               |
| `pnpm format` / `pnpm format:check` | oxfmt                                                                                |
| `pnpm knip`                         | 未使用のコード・依存を検出する                                                       |
| `pnpm validate`                     | Orca と同じ規則でマニフェストを検証する                                              |
| `orca plugin dev watch .`           | Orca に開発フォルダーとして読み込み、ログを流す                                      |

`orca` CLI（Orca デスクトップに同梱）が PATH にあることを前提にしている。型情報を使う lint も `.orca/types` を読むので、clone 直後は `orca plugin types .` で生成しておく。

## CI とリリース

- CI は Orca の Linux 用 deb を展開して `orca` CLI を用意する（`.github/actions/setup-orca`）。版は `.github/workflows/ci.yml` の `ORCA_VERSION` で固定している。新しい Orca にしかない API を使うときは、`orca-plugin.json` の `engines.orca` とあわせて上げる。
- `uses:` を追加・変更したら `gh-actions-lock` で `.github/workflows/actions.lock` を更新し、`gh-actions-lock --no-fix` で検証する。
- リリースは Actions の release ワークフローを手動実行して patch / minor / major を選ぶ。作られた準備 PR をマージすると、`package.json` と `orca-plugin.json` の `version` を揃えたタグとリリースが公開される。`orca plugin install` は最新の `vX.Y.Z` タグを入れるので、成果物の添付はない。

## 構成

`src/main.ts` が worker のエントリーポイント（`orca-plugin.json` の `main`）で、Orca の API を `App` のポートに詰め替えて配線するだけにする。Orca が読み込み時に TypeScript を変換するので、ビルドはない。

| ファイル                 | 責務                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| `src/app.ts`             | 設定の読み込み、プロキシの起動と停止、ログインの流れ、状態の集約と表示  |
| `src/settings.ts`        | プラグイン設定の検証                                                    |
| `src/oauth.ts`           | ディスカバリー、動的クライアント登録、PKCE、トークンの交換と更新        |
| `src/callback-server.ts` | ログイン時のリダイレクトを受ける一時的な HTTP サーバー                  |
| `src/token-store.ts`     | アクセストークンのメモリ保持と更新の一本化、資格情報の secrets への保存 |
| `src/proxy.ts`           | `127.0.0.1` での待ち受けと WebSocket upgrade の中継                     |
| `src/status.ts`          | 状態の導出とステータスバー・説明文への変換                              |
| `src/browser.ts`         | OS の既定ブラウザーを開く                                               |

## 制約と判断基準

- 実行時の依存パッケージを入れない。プラグインの配布物に `node_modules` は含まれないため、Node.js の標準モジュールだけで書く。外部入力の検証も Valibot ではなく `src/json.ts` の小さな判定関数で行う。
- worker からは `shell.openExternal` を呼べない（panel と editor 専用）。ブラウザーは `src/browser.ts` で OS のコマンドを使って開く。
- プロキシは WebSocket のフレームを解釈しない。upgrade を中継したあとはソケット同士をつなぐだけにし、Orca の E2E 暗号化と圧縮のネゴシエーションをクライアントとサーバーのあいだで成立させる。
- ログにトークン、認可コード、リクエストのクエリ文字列を書かない。
- 設計の背景（構成の選定理由、脅威と対策、未検証事項）は設計書「Orca Remote ServerをCloudflare Access経由で使う構成 設計書」にある。
