# Hajimatta

Twitchの配信開始・配信情報・チャットモードの変更をSlackに通知するNode.js製CLIです。
EventSub WebSocket（WS）でイベントを受信し、APIの定期確認で受信漏れを補完します。
ターミナルでは、通常ログまたは固定画面のダッシュボードで監視できます。

## はじめに

必要なものは、Node.js 20以上、TwitchアプリのClient IDとUser Access Token、
SlackのIncoming Webhook URLです。監視対象は最大5チャンネルです。

既に設定済みの場合は、プロジェクトのフォルダーで次のコマンドを実行してください。

```bash
npm install
node src/index.js --dashboard
```

更新時は旧プロセスを終了してから `git pull` し、再起動してください。
設定や状態を引き継ぐには、同じ `.env` と `data/` を使います。

## 初期設定

### 1. 依存パッケージをインストール

```bash
npm install
```

### 2. Twitchの認証情報を用意

[Twitch Developer Console](https://dev.twitch.tv/console/apps)でアプリを登録し、Client IDを取得します。
このCLIには、同じClient IDで発行した **User Access Token** が必要です。
App Access TokenではEventSubのWS購読は作成できません。

付属のトークン取得スクリプトはDevice Codeフローを使います。PowerShellで実行してください。

```powershell
./get-twitch-user-token.ps1 -ClientId "YOUR_TWITCH_CLIENT_ID"
```

表示されたURLをブラウザで開いてコードを入力し、権限を承認します。
スクリプトに戻ってEnterを押すとAccess TokenとRefresh Tokenが表示されます。
このスクリプトは `.env` を自動更新しないため、次の手順で両方を設定してください。

標準で要求する `user:read:chat` は、チャットモード変更をWSで受信するための権限です。
この権限がなくても、30秒ごとのAPI確認でチャットモードの変更を補完します。

Client IDを変更した場合は、Access TokenとRefresh Tokenも取り直してください。
Client Secretが必要かどうかはTwitchアプリの認証方式によります。
更新時に `missing client secret` が出た場合は、そのアプリのClient Secretを設定してください。

### 3. `.env` を作成

`.env.example` をコピーするか、次の内容で `.env` を作成します。
監視対象には表示名ではなく、チャンネルURL末尾のlogin名を指定してください。

```env
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret_if_required
TWITCH_ACCESS_TOKEN=your_user_access_token
TWITCH_REFRESH_TOKEN=your_refresh_token
TWITCH_BROADCASTERS=nikopyonzoku
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
```

複数チャンネルの場合は `TWITCH_BROADCASTERS=channel_one,channel_two` のようにカンマで区切ります。
Client Secretが不要なアプリでは、`TWITCH_CLIENT_SECRET` の行を省略するか空欄にしてください。

`.env` はプロジェクトのフォルダーから読み込みます。同名の環境変数がある場合は、環境変数が優先されます。
`.env`、そのコピー、トークン、Webhook URLはGitやチャットに貼り付けないでください。

### 4. 起動

| 用途 | コマンド |
| --- | --- |
| 固定画面のダッシュボード | `node src/index.js --dashboard` |
| 通常ログで監視 | `npm start` |
| 購読状況の診断だけ実行 | `node src/index.js --diagnose` |

監視はプロセスが動いている間だけ行います。通常ログモードでは `Ctrl+C`、
ダッシュボードでは `q` または `Ctrl+C` で終了します。

## ダッシュボードの見方

### チャンネル一覧

| 列 | 意味 |
| --- | --- |
| `CHANNEL` | 監視対象のチャンネル名 |
| `STREAM` | 緑の `[LIVE]` は配信中、灰色の `[OFF]` はオフライン |
| `ELAPSED` | 配信中は開始からの経過時間。オフライン時は前回の終了確認からの概算時間 |
| `ONLINE` | 配信開始イベントのWS購読状態 |
| `UPDATE` | タイトル・カテゴリ更新イベントのWS購読状態 |
| `CHAT` | チャット設定変更イベントのWS購読状態 |
| `EMOTES` | 水色の `[EMOTE]` はスタンプ限定が有効、灰色の `[TEXT]` は無効。`[?]` は未確認 |
| `CATEGORY` / `TITLE` | 配信中のカテゴリとタイトル。オフライン時は空欄 |

**`CHAT [OK]` は購読成功を示す表示です。スタンプ限定の状態は `EMOTES` 列で確認してください。**
`[TEXT]` はスタンプ限定が無効という意味で、フォロワー限定など他の制限がないことを示す表示ではありません。

WS購読状態は、緑の `[OK]` が有効、赤の `[MISS]` が未購読、黄色の `[OTHER]` が別接続で有効です。
`[?]` は未確認、`-` はそのイベントを購読対象にしていないことを表します。

一覧は1行ずつ表示し、幅に収まらない部分は折り返さず切り詰めます。
ログは一覧の下に空行を挟んで表示し、ウィンドウの高さに合わせて表示件数を調整します。
長いログは折り返し、直近1000件をメモリに保持します。画面の履歴は再起動で消えますが、
ログファイルは残ります。ファイルの内容を画面へ再読み込みする機能はありません。

### キー操作とログレベル

| キー | 操作 |
| --- | --- |
| `1` | INFO以上を表示 |
| `2` | WARN以上を表示（初期値） |
| `3` | ERROR以上を表示。FATALも含む |
| `l` | INFO → WARN → ERRORの順に切り替え |
| `p` / Space | ログ表示の一時停止・再開。再開すると最新へ戻る |
| ↑ / ↓ | ログを1行ずつスクロール。過去ログを開くと自動で一時停止 |
| PageUp / PageDown | ログを1ページずつスクロール |
| Home / End | 保持履歴の先頭へ移動 / 最新へ戻って追従を再開 |
| `r` | 購読診断を手動更新 |
| `q` / `Ctrl+C` | 終了 |

表示していないレベルも履歴に保持するため、後からINFOに切り替えて確認できます。
表示レベルはSlack通知に影響しません。起動時のレベルは `DASHBOARD_LOG_LEVEL` で指定できます。
対話型ターミナル以外に出力する場合は、通常ログに切り替わります。

一時停止はログ欄だけに作用し、配信監視・通知・ファイル保存・一覧の更新は継続します。
`[PAUSED] new=N back=M` は停止中の追加件数と最新からのスクロール行数です。
停止中の表示は固定し、Endまたは再開操作で新着ログを表示します。

### データの鮮度

上部に最終確認からの経過時間を表示します。緑の `[FRESH]` は確認間隔内、
赤の `[STALE]` は更新の遅れ、黄色の `[WAIT]` は起動後まだ未確認の状態です。
最初のデータが届かないまま判定時間を超えた場合も `[STALE] never` と表示します。

| 表示 | 更新されるタイミング | 遅延と判定する基準 |
| --- | --- | --- |
| `WS` | 現在の接続でメッセージ・Keepaliveを受信した時 | Keepalive設定＋20秒、最低60秒 |
| `STREAM` | 配信状態APIの確認が成功した時 | 確認間隔の2倍＋10秒。標準では250秒 |
| `CHAT` | 全監視チャンネルのチャット設定API確認が成功した時 | 75秒 |
| `SUBS` | 購読診断が成功した時 | 130秒 |

Slack欄の `last sent` は最後に送信成功した時からの経過時間です。
通知が発生しない時間もあるため、Slackの送信間隔だけでは異常と判定しません。
鮮度はログの一時停止中も更新します。

### 経過時間と再起動

配信中はAPIまたはイベントで取得した開始時刻から計算します。
オフライン時は、APIで終了を確認した時刻から計算するため、`~2d 01:30:00` のように `~` が付きます。
終了確認は標準2分間隔なので、実際の終了時刻とはずれます。

終了確認時刻は `state.json` に保存し、再起動後も引き継ぎます。
保存上は配信中だったチャンネルが、再起動時にはオフラインだった場合、終了時刻は推測せず `unknown` にします。
停止中に開始・終了の両方があった配信は検知できず、以前保存した終了確認時刻が残る場合があります。

## 通知と更新タイミング

| 対象 | 検知・確認のタイミング | 動作 |
| --- | --- | --- |
| 配信開始 | WS受信時。受信漏れはAPIで標準2分ごとに補完 | 開始通知を作成 |
| タイトル・カテゴリ | WS受信時 | 変更を通知。オフライン中の変更も対象 |
| 配信開始直後の情報 | 開始後の最初の情報更新イベント受信時 | 初期タイトル・カテゴリとして別通知 |
| 配信終了 | APIで標準2分ごとに確認 | 終了確認通知を作成 |
| チャットモード | WS受信時。起動時と30秒ごとのAPI確認でも補完 | 前回確認した設定との差分を通知 |
| 購読状況・コスト | 起動時・購読登録後・1分ごと。`r` でも更新 | ダッシュボードと診断ログに反映 |

画面は毎秒再描画しますが、APIのデータを毎秒取得するわけではありません。
通知の作成後、Slack送信待ちに保存して順次送信します。
配信開始通知とタイトル・カテゴリの更新通知は、別々に届く場合があります。

### スタンプ限定モードの開始・解除

配信がオフラインでも監視します。フォロワー限定、サブスク限定、スローモード、
重複メッセージ制限も対象で、待機時間の変更にも対応しています。

通知には `EventSub` または `API補完` の検知経路を付けます。
受信と送信待ちへの登録は、INFOログの `Chat settings received` と `Chat mode notification queued` で確認できます。
これらはSlackへの送信完了を示すログではありません。完了は `Slack notification delivered` で確認します。

初回のAPI確認では、スタンプ限定が有効なら「現在有効」と通知し、無効なら比較基準の保存だけを行います。
保存済みの設定がある場合は、その設定との差分を通知します。
30秒以内に開始・解除の両方が起きると、API補完だけでは途中の変更を検知できません。

## 配信開始時にTwitchチャットへ自動投稿

スタンプ限定解除とは別に有効・無効、対象チャンネル、本文を設定できます。
対象のlogin名はカンマ区切りで複数指定でき、`TWITCH_BROADCASTERS` にも含めてください。
指定した全チャンネルに同じ本文を使用します。監視対象全体の上限は従来どおり5チャンネルです。

```env
TWITCH_BROADCASTERS=channel_one,channel_two
TWITCH_STREAM_START_COMMENT_ENABLED=true
TWITCH_STREAM_START_COMMENT_CHANNELS=channel_one,channel_two
TWITCH_STREAM_START_COMMENT_MESSAGE=配信開始おめでとうございます！
TWITCH_STREAM_START_COMMENT_COOLDOWN_MS=300000
```

WSによる配信開始、またはAPI補完によるオフライン→配信中の検知で投稿します。
起動時点で配信中のチャンネルには投稿しません。同じ配信への投稿試行を保存して二重投稿を防ぎます。
標準のクールダウンは5分（最低1分）で、解除時コメントとは独立しています。
既定では無効です。`user:write:chat` 権限、共有チャット中のスキップ、失敗時に自動再送しない扱いは
下記の解除時コメントと共通です。投稿前に配信APIで対象の配信が継続中か確認します。
本文はダブルクオートで囲まずに記載してください。

## スタンプ限定の解除時にTwitchチャットへ自動投稿

既定では無効です。`.env` で対象チャンネルとコメントを指定して有効にできます。
対象は `TWITCH_BROADCASTERS` にも含めてください。複数対象には同じコメントを投稿します。

```env
TWITCH_EMOTE_RELEASE_COMMENT_ENABLED=true
TWITCH_EMOTE_RELEASE_COMMENT_CHANNELS=nikopyonzoku
TWITCH_EMOTE_RELEASE_COMMENT_MESSAGE=こんにちは！
TWITCH_EMOTE_RELEASE_COMMENT_ALLOW_OFFLINE=false
TWITCH_EMOTE_RELEASE_COMMENT_COOLDOWN_MS=300000
```

- `ENABLED`：`true` で有効。`false` または省略で無効。
- `CHANNELS`：対象のlogin名をカンマ区切りで指定。
- `MESSAGE`：1〜500文字、改行なし。
- `ALLOW_OFFLINE`：`false` は配信中だけ、`true` はオフラインでも投稿。
- `COOLDOWN_MS`：同じチャンネルへの試行間隔。標準5分、最低1分。

投稿者は認証したTwitchアカウントです。送信用の `user:write:chat` 権限も承認してください。

```powershell
./get-twitch-user-token.ps1 -ClientId "YOUR_TWITCH_CLIENT_ID" -Scopes "user:read:chat user:write:chat"
```

発行されたAccess TokenとRefresh Tokenを `.env` に設定して再起動します。
送信権限がない場合は警告を出し、自動投稿を行わず監視を続けます。

保存済みの設定が「有効」から「無効」へ変わった場合だけ投稿します。
起動後最初のAPI確認では投稿せず、その後のWSまたはAPI補完による解除が対象です。
配信中だけに設定した場合は、投稿直前に配信状態をAPI確認します。
Twitchの共有チャットでは他チャンネルにも投稿されるため、共有チャット中の投稿はスキップします。
同時受信や再起動による連投を抑えるため、送信試行時刻を先に保存し、失敗やタイムアウトの自動再送はしません。
結果はINFOの `Auto-comment`、失敗はERRORの `Auto-comment failed` で確認できます。
この機能はSlack通知とは独立しています。コードのテストでは実際のコメント投稿は行いません。

参照：[Twitch Send Chat Message](https://dev.twitch.tv/docs/api/reference/#send-chat-message)

## Slack送信の再試行と異常アラート

通知は送信前に `slack-outbox.json` に保存し、正常に送信できたものだけを削除します。
失敗した通知は再試行し、再起動後も未送信通知を再送します。

| 送信結果 | 再試行の動作 |
| --- | --- |
| 通信エラー・5xx | 5秒から最大15分まで待ち時間を延ばす |
| 429 | `Retry-After` に従って送信全体を待機。待機状態も保存 |
| 400・403・404など（408と429を除く4xx） | 通知を残して1時間おきに再試行。他の通知は送信を継続 |

送信は1件ずつ最低1秒間隔、タイムアウトは10秒です。ダッシュボードの `pending` は送信待ち件数、
`retrying` は送信失敗歴のある待機通知の件数です。Slackが受信後に応答だけ失われた場合などは、再送で重複する可能性があります。

接続・購読・API確認・Slack送信の異常が約1分続くとアラートを作成し、復旧時も通知します。
認証更新失敗・購読失効・起動失敗は即時に通知を作成します。ただし、起動がごく初期で失敗した場合や
送信待ちファイル自体を開けない場合など、アラートを保存できないこともあります。
同じ異常は標準2時間おきに再通知し、未送信の同種アラートがある場合はまとめます。

Slack自体に送れない間はアラートも保存し、通信復旧後に送ります。
プロセス停止中の監視・再送は行いません。起動失敗で終了した場合、残った通知は次回起動時に再送します。

## 設定項目

相対パスは、起動時の作業フォルダーを基準に解決します。時間の設定値はミリ秒です。

| 設定名 | 用途・初期値 |
| --- | --- |
| `TWITCH_CLIENT_ID` | 必須。TwitchアプリのClient ID |
| `TWITCH_ACCESS_TOKEN` | 必須。同じClient IDで発行したUser Access Token |
| `TWITCH_REFRESH_TOKEN` | トークンの自動更新に使用 |
| `TWITCH_CLIENT_SECRET` | アプリの認証方式に応じて自動更新に必要 |
| `TWITCH_BROADCASTERS` | 必須。login名をカンマ区切りで指定。最大5人 |
| `SLACK_WEBHOOK_URL` | 監視時は必須。単独診断では不要 |
| `DASHBOARD_LOG_LEVEL` | ダッシュボードの初期表示。`info` / `warn` / `error`。初期値 `warn` |
| `LOG_DIR` | 日別ログの保存先。初期値は状態ファイルと同じフォルダーの `logs/` |
| `STATE_FILE` | 状態の保存先。初期値 `./data/state.json` |
| `SLACK_OUTBOX_FILE` | 送信待ちの保存先。初期値は状態ファイルと同じフォルダーの `slack-outbox.json` |
| `LIVE_RECONCILE_INTERVAL_MS` | 配信状態のAPI確認間隔。初期値 `120000`（2分） |
| `LIVE_RECONCILE_LOG_MODE` | 配信状態の補完ログ。`changes`（初期値）は変化時だけ、`verbose` は毎回、`silent` は補完の案内ログを抑止 |
| `SLACK_MESSAGE_MODE` | `aligned`（初期値）はプッシュ通知と本文の内容を揃える。`legacy` はプッシュ通知を短い見出しにする |
| `TWITCH_AUTH_ALERT_INTERVAL_MS` | 異常アラート全般の再通知間隔。初期値 `7200000`（2時間）、最低1分 |
| `TWITCH_INSTANCE_PORT` | 二重起動防止用のローカルポート。通常はClient IDから自動決定。競合時のみ1024〜65535の空きポートを指定 |

チャット設定のAPI確認は30秒、購読診断は1分で固定です。
起動時とTwitch APIの401応答時にトークンを確認・更新し、更新に成功すると `.env` の値も書き換えます。
`.env` がない場合は実行中の値だけを更新します。

## 診断とトラブル対応

監視中でも、別のターミナルから実行できます。

```bash
node src/index.js --diagnose
```

総コスト・上限、有効な接続数、購読ごとの配信者ID・状態・コスト・セッションIDを出力します。
`enabled` は有効、`other_session` は別接続で有効、`missing` は未購読です。
単独診断は自分の接続を持たないため、既存の有効な購読を `enabled` と表示します。
APIのコスト集計には数秒の遅延がある場合があります。

単独診断は購読変更・Slack送信・トークン更新を行いません。トークンが無効なら、
通常起動で更新するか再取得してから実行してください。

| 症状 | 確認すること |
| --- | --- |
| コスト上限・429 | 診断の購読一覧を確認。同じClient ID・ユーザーで別のプロセスが動いていないか確認 |
| `CHAT [OK]` だがスタンプ限定の表示が不明 | `EMOTES` 列とINFOログを確認。CHATはモードではなく購読状態 |
| Slack通知が来ない | `pending`・`retrying`、`Slack delivery deferred`、Webhook設定とネットワークを確認 |
| `STOPPED` が表示される | 送信待ちファイルの保存失敗。ディスク容量・権限を直し、再起動 |
| 送信待ちファイルが壊れている | 起動を停止し、ファイルを保全して修復。通知を捨てる前提で安易に削除しない |
| 画面の右側が見えない | ターミナルの幅を広げる。一覧は折り返さず表示 |
| ログが増えない | 初期表示はWARN以上。`1` でINFOも表示する |
| チャンネルを解決できない | 表示名ではなくlogin名を指定しているか確認 |

同じPC・Client IDの二重起動は、ローカルポートの占有で防止します。
別フォルダーからの起動も対象ですが、別PCやネットワークを分離したコンテナ間は対象外です。
ポートを手動指定する場合は、同じClient IDを使う全コピーで同じ値を指定してください。
別接続の有効な購読は自動削除しません。古いプロセスを終了してから再起動してください。

## 保存ファイルと検証

- `.env`：認証情報と設定。自動更新でトークンが書き換わります。
- `data/state.json`：配信状態、終了確認時刻、チャット設定など。`STATE_FILE` で変更可能です。
- `data/slack-outbox.json`：送信待ち本文とアラート状態。`SLACK_OUTBOX_FILE` で変更可能です。
- `data/logs/hajimatta-YYYY-MM-DD.log`：通常ログ・ダッシュボード共通の日別ログ。`LOG_DIR` で変更可能です。

ログはUTF-8のJSON Lines形式で、時刻・レベル・本文を1行ずつ保存します。
画面のフィルターとは独立してINFO以上を記録し、既知の認証情報やWebhook URLを伏せます。
日付と記録時刻はUTCです。標準では直近14日分を保持し、1ファイル5MiBを超える前に
`.1`〜`.4` へローテーションします。`.1` が直前のファイルで、各日最大5ファイルです。
古いログは起動後最初の記録とUTC日付の切り替わり時に整理します。
対象はこのアプリの命名規則に一致するログだけです。単独診断ではファイルへ記録しません。
保存失敗は画面に `[FILE ERROR]` とエラーログで表示し、監視は継続して次のログで保存を再試行します。
ログにはチャンネル情報などが含まれるため、共有前に内容を確認してください。

送信待ちにはWebhook URLやアクセストークンを保存しません。ただし、通知本文を含むため適切に管理してください。
状態と送信待ちの保存先は、プロセスから書き込める場所にします。
このREADMEはUTF-8です。編集時もUTF-8で保存してください。

```bash
npm run check
node --test test/*.test.js
```

## Twitch・Slackの公式資料

- [EventSubの購読管理とコスト](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/)
- [EventSubのイベント一覧](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [チャット設定取得API](https://dev.twitch.tv/docs/api/reference/#get-chat-settings)
- [Twitchのトークン取得](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Twitchのトークン更新](https://dev.twitch.tv/docs/authentication/refresh-tokens/)
- [Slack Incoming Webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
