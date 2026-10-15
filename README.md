# Hajimatta

Twitch 配信の開始とタイトル・カテゴリー更新を Slack に通知する最小 CLI です。

## 構成

- Twitch EventSub WebSocket に接続
- 起動時に `Get Users` で Twitch login から user ID を解決
- 起動時に `Get Streams` と `Get Channel Information` で初期状態を取得
- 起動時に token を validate し、失効していれば refresh
- Twitch API が `401` を返したら refresh して 1 回だけ自動リトライ
- `stream.online` を受信したら即時通知
- オフライン中の `channel.update` は配信予兆として通知
- 開始直後の最初の `channel.update` は初期タイトル・カテゴリーとして別通知
- 以後の `channel.update` は差分通知
- 定期的に `Get Streams` で live 状態を補正
- API 補正で終了を確認した場合は終了確認通知を送信
- ローカルの `state.json` に最新状態を保持
- `.env` の `TWITCH_ACCESS_TOKEN` と `TWITCH_REFRESH_TOKEN` を自動更新
- Slack Incoming Webhook に投稿

## 前提

Node.js 20 以上を想定しています。

Twitch EventSub WebSocket で購読を作るには、`User Access Token` が必要です。今回の構成では `stream.online` と `channel.update` だけを購読します。現在の EventSub WebSocket コスト制限に合わせて、監視対象は最大 5 人までです。

多くの Twitch アプリでは token refresh に `Client Secret` が必要です。この README でも `TWITCH_CLIENT_SECRET` を使う前提で説明しています。

参照:

- https://dev.twitch.tv/docs/eventsub/manage-subscriptions/
- https://dev.twitch.tv/docs/eventsub/eventsub-reference/
- https://dev.twitch.tv/docs/api/reference#get-users
- https://dev.twitch.tv/docs/api/reference#get-streams
- https://dev.twitch.tv/docs/api/reference#get-channel-information
- https://dev.twitch.tv/docs/authentication/register-app
- https://dev.twitch.tv/docs/authentication/validate-tokens/
- https://dev.twitch.tv/docs/authentication/refresh-tokens/
- https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/

## 設定

### 購読状況・コストの診断と二重起動防止

固定画面のCUIで監視する場合は、対話型ターミナルで次を実行してください。

```bash
node src/index.js --dashboard
```

WS接続状態、購読数、コスト、配信者の配信状態とイベント別購読状態を表示し、
残りのウィンドウ高さを警告・エラーのログ領域に使います。サイズ変更にも追従し、長いログは
幅に合わせて折り返します。直近1000件を保持し、大きくした際には過去のログも再表示します。
配信中は緑の `[LIVE]`、オフラインは灰色の `[OFF]`、購読正常は緑の `[OK]`、
未購読は赤の `[MISS]`、別接続で購読中は黄色の `[OTHER]` で区別します。
`r` で購読診断を更新、`q` または `Ctrl+C` で終了します。
コスト・購読状態は最後の診断結果で、確認時刻も表示します。
パイプ・ファイル出力など対話型でない環境では通常ログに戻ります。
通常の `npm start` は従来のログ形式です。

稼働中でも、別のターミナルから次のコマンドで診断できます。

```bash
node src/index.js --diagnose
```

総コストと上限、有効な WebSocket 接続数、各購読の種類・配信者ID・状態・コスト・
セッションIDを出力します。監視対象ごとの `EventSub coverage` は `enabled`（有効）、
`other_session`（別接続で有効）、`missing`（未購読）です。単独診断には自分の接続がないため、
既存の有効な接続を `enabled` と表示します。トークンやWebhookの秘密情報は出力しません。
APIのコスト集計は反映に数秒かかる場合があります。

通常起動時と購読登録後（429による再試行時を含む）にも自動で診断します。
別接続で有効な購読を起動時に削除せず、409の競合も自分の接続での購読成功と区別します。
`--diagnose` は購読変更・Slack送信・トークン更新を行いません。トークンが無効な場合は、
通常起動で更新してから再実行してください。Slackの設定は単独診断には不要です。

通常起動では、Client IDから決まるローカル専用ポートを占有して、同じPCの同じClient IDでの
二重起動を防ぎます。別フォルダーからの起動も対象です。終了・クラッシュ時はOSが解放するため、
ロックファイルの削除は不要です。既に動作中の旧版にはこの防止機能がないため、更新時は旧プロセスを停止してください。
別PC・コンテナなどネットワーク環境を分けたプロセス間は防止できません。

無関係なアプリとポートが競合する場合だけ、`.env` に `TWITCH_INSTANCE_PORT=任意の空きポート`
（1024〜65535）を設定できます。同じClient IDを使う全コピーに同じ値を設定してください。

### チャットのモード変更通知

`user:read:chat` 権限付きの User Access Token がある場合、監視対象の
`channel.chat_settings.update` を追加購読します。スタンプ限定モードの開始・解除、
フォロワー限定・サブスク限定・スローモード・重複メッセージ制限の変更を Slack に通知します。
スローモードとフォロワー限定の待機時間変更も通知します。
権限がない既存トークンでは警告を出し、従来の配信通知だけを継続します。

追加権限を承認するには、次のコマンドでトークンを再取得してください。

```powershell
./get-twitch-user-token.ps1 -ClientId YOUR_CLIENT_ID
```

ブラウザで Twitch の権限を承認し、表示された Access Token / Refresh Token を
稼働環境の `.env` に反映してプロセスを再起動してください。スクリプトは標準で
`user:read:chat` を要求します。トークンをチャットや Git に貼り付けないでください。

前回の設定を `state.json` に保存して差分を通知します。初回イベントは変更前の状態が
不明なので「現在有効／無効（初回受信）」と表示します。起動直後の設定取得や、
接続が切れていた期間の変更の再取得は行いません。

参照: https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchat_settingsupdate

`.env.example` を元に `.env` を作ります。

```env
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
TWITCH_ACCESS_TOKEN=your_user_access_token
TWITCH_REFRESH_TOKEN=your_refresh_token
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
SLACK_MESSAGE_MODE=aligned
TWITCH_BROADCASTERS=erumdoor,kingofsimoyaka,foo,bar,baz
STATE_FILE=./data/state.json
LIVE_RECONCILE_INTERVAL_MS=120000
LIVE_RECONCILE_LOG_MODE=changes
TWITCH_AUTH_ALERT_INTERVAL_MS=7200000
```

`LIVE_RECONCILE_INTERVAL_MS` ????????????? `120000` ? 2 ???? API ????????? 
`LIVE_RECONCILE_LOG_MODE` は定期 API 補正ログの出し方です。`changes` がデフォルトで、状態変化があった周期だけ要約ログを出します。`verbose` は毎周期、`silent` は開始時ログも含めて抑止します。
`SLACK_MESSAGE_MODE` は Slack の `text` と `blocks` の揃え方です。デフォルトの `aligned` はスマホ通知と本文をできるだけ一致させます。`legacy` にすると従来どおり `text` は短い見出し、本文は `blocks` になります。

`TWITCH_BROADCASTERS` は Twitch の login 名のカンマ区切りです。起動時に `Get Users` API で user ID を自動解決します。

## Twitch アプリ登録

1. [Twitch Developer Console](https://dev.twitch.tv/console/apps) でアプリを作成します。
2. `Client Type` は通常 `Confidential` を選びます。
3. `OAuth Redirect URLs` は登録上必要ですが、この CLI 自体は redirect を使いません。未使用の HTTPS URL を 1 つ入れれば十分です。
4. 作成後に `Client ID` を控えます。
5. `Manage` から `New Secret` を作成して `Client Secret` を控えます。

`.env` には `TWITCH_CLIENT_ID` と `TWITCH_CLIENT_SECRET` を設定してください。

## User Access Token の取得

新しい `Client ID` に切り替えた場合は、`Access Token` と `Refresh Token` も取り直してください。token は発行時の `Client ID` に紐づきます。

`get-twitch-user-token.ps1` を使う場合の例:

```powershell
powershell -ExecutionPolicy Bypass -File .\get-twitch-user-token.ps1 -ClientId "YOUR_TWITCH_CLIENT_ID"
```

取得後は `.env` を更新します。

```env
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
TWITCH_ACCESS_TOKEN=...
TWITCH_REFRESH_TOKEN=...
```

## 実行

```bash
npm start
```

起動時には次のようなログが出ます。

- `Hydrated initial state: broadcasters=5 live=2`
- `Initial live broadcasters: login=... title=... category=... url=...`
- `Starting live reconcile loop: intervalMs=120000 intervalSec=120`
- `Running live reconcile check for 5 broadcasters`
- `Live reconcile completed: currentLive=1 reconciledOnline=0 reconciledOffline=1 changed=true`

## 自動 refresh

- 起動時に `TWITCH_ACCESS_TOKEN` を validate
- 無効なら `TWITCH_REFRESH_TOKEN` で refresh
- refresh 成功後は `.env` の token 値を更新
- 実行中に Twitch API が `401` を返した場合も 1 回だけ自動 refresh
- あなたのアプリで `missing client secret` が出る場合は `TWITCH_CLIENT_SECRET` を `.env` に入れてください

## 通知仕様

- 配信開始: 即時に Slack 通知
- 配信予兆: オフライン中のタイトル変更やカテゴリー変更を Slack 通知
- 初期配信情報: 開始直後の最初の `channel.update` を Slack 通知
- 配信情報更新: 配信中のタイトル変更やカテゴリー変更を Slack 通知
- 配信終了確認: API 補正で配信終了を確認した場合に Slack 通知
- Slack 本文には Twitch プロフィール画像を添付
- タイトルとカテゴリーが同時に変わった場合は 1 件にまとめて通知

## 制限

- 監視対象は最大 5 人までです。
- 開始通知は即時送信されるため、タイトルとカテゴリーは後続の初期更新通知で届くことがあります。
- 終了通知は `stream.offline` ではなく API 補正ベースです。通知タイミングは `LIVE_RECONCILE_INTERVAL_MS` に依存します。
- login 名を解決できない Twitch ユーザーが含まれていると起動時にエラーになります。
- Slack は Incoming Webhook 前提です。
- `.env` が存在しない場合は token を自動保存しません。
