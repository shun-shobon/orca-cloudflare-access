# orca-cloudflare-access

[English](README.md) | 日本語

Cloudflare Access の内側に公開した Orca Remote Server（`orca serve`）へ、Orca デスクトップから接続するための Orca プラグイン。

プラグインは `127.0.0.1` で WebSocket を待ち受けるローカルプロキシとして動き、Cloudflare Access の Managed OAuth で取得したアクセストークンを付けて上流へ中継する。Orca 本体の改造、Cloudflare Workers、クライアント側への cloudflared の導入は要らない。

## 注意

- ログイン中は、同じマシンでローカルプロキシに接続したプロセスは Access を通過できる。Orca サーバーにはペアリング時に発行されるデバイストークンがないと入れないが、Access の手前の防御はこのマシン上では効かない。
- Orca サーバーは `Cf-Access-Jwt-Assertion` を検証しない。サーバーを `127.0.0.1` 以外に bind すると Access を経ない経路ができるので、下の手順どおり loopback にだけ bind すること。

## 必要なもの

- Orca 1.4.248 以降（クライアントとサーバーのバージョンは揃える）
- Cloudflare Zero Trust と、Tunnel で公開できるドメイン
- macOS・Linux・Windows のいずれか（ログイン時に OS の既定ブラウザーを開く）

## サーバー側の設定

Orca サーバーと cloudflared を同じホストで動かす。

```bash
orca serve \
  --bind 127.0.0.1 \
  --port 6768 \
  --pairing-address ws://127.0.0.1:16768
```

`--pairing-address` はペアリングリンクに入る接続先で、クライアント側のプロキシのアドレスを指定する。ポートはプラグインの Local proxy port と揃える。

cloudflared の ingress は HTTP で上流に向ける（`tcp://` では Access が HTTP レベルで認証できない）。

```yaml
ingress:
  - hostname: orca.example.com
    service: http://127.0.0.1:6768
  - service: http_status:404
```

Access には `orca.example.com` を Self-hosted アプリとして登録し、次のように設定する。

| 設定                        | 値                                                                 |
| --------------------------- | ------------------------------------------------------------------ |
| ポリシー                    | 接続を許すユーザーだけを Allow                                     |
| Managed OAuth               | オン                                                               |
| Dynamic client registration | オン                                                               |
| Allow loopback clients      | オン（リダイレクト先が `http://127.0.0.1:<port>/callback` のため） |
| アクセストークンの寿命      | 既定の 15 分                                                       |
| Grant session duration      | 1〜2 週間（再ログインの間隔になる）                                |

## クライアント側の設定

1. `orca plugin install shun-shobon/orca-cloudflare-access` を実行し、付与される権限を確かめてから、表示された `--approve` 付きのコマンドで承認してインストールする。
2. プラグインの設定で Upstream URL に `https://orca.example.com` を入れる。
3. ステータスバーの「Access: signed out」を押し、開いたブラウザーで IdP にログインする。表示が「Access: ready」になれば完了。
4. Orca の設定でリモートサーバーの追加を開き、サーバーのペアリングリンクを貼る。「このリンクはこのデバイス自身を指しています」という警告が出るので、その下の「このアドレスには SSH トンネル経由で接続する」をオンにして登録する。SSH という文言だが、`127.0.0.1` 宛ての手動トンネル全般を受け付ける入口である。

### 設定項目

| 項目                | 既定値       | 内容                                                              |
| ------------------- | ------------ | ----------------------------------------------------------------- |
| Upstream URL        | なし（必須） | Access で保護した Orca サーバーの origin                          |
| Local proxy port    | `16768`      | プロキシの待ち受けポート。サーバーの `--pairing-address` と揃える |
| OAuth callback port | `16769`      | ログイン時のリダイレクトを受けるポート                            |

### ステータスバー

| 表示                  | 状態                           | 押したとき                               |
| --------------------- | ------------------------------ | ---------------------------------------- |
| Access: signed out    | 未ログイン                     | ログイン                                 |
| Access: ready         | ログイン済み、接続待ち         | 状態を表示                               |
| Access: n relaying    | n 本の接続を中継中             | 状態を表示                               |
| Access: sign in again | リフレッシュトークンが失効した | ログイン                                 |
| Access: error         | 設定の誤り、ポートの使用中など | 状態を表示（理由はツールチップにも出る） |

アクセストークンは接続のたびに残り時間を確かめて自動で更新する。ブラウザーでのログインが要るのは、初回と Grant session duration が切れたときだけである。中継中の接続はトークンが切れても切断しない。

コマンドパレットからは Sign in・Sign out・Show status を実行できる。Sign out は保存した資格情報を消し、次のログインで OAuth クライアントを登録し直す。

## うまくつながらないとき

`orca plugin logs shun-shobon.cloudflare-access` に接続の開始と終了、上流のステータス、トークン更新の成否が出る（トークンは記録しない）。

Access が Bearer トークン付きの WebSocket upgrade を通すかは、トークンを手で取得して次のコマンドで確かめられる。`101 Switching Protocols` が返れば通っている。

```bash
curl -i --http1.1 https://orca.example.com/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)"
```

## ライセンス

MIT
