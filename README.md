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

`.env.example` を元に `.env` を作ります。

```env
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
TWITCH_ACCESS_TOKEN=your_user_access_token
TWITCH_REFRESH_TOKEN=your_refresh_token
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
TWITCH_BROADCASTERS=erumdoor,kingofsimoyaka,foo,bar,baz
STATE_FILE=./data/state.json
LIVE_RECONCILE_INTERVAL_MS=120000
TWITCH_AUTH_ALERT_INTERVAL_MS=7200000
```

`LIVE_RECONCILE_INTERVAL_MS` ????????????? `120000` ? 2 ???? API ?????????

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
- タイトルとカテゴリーが同時に変わった場合は 1 件にまとめて通知

## 制限

- 監視対象は最大 5 人までです。
- 開始通知は即時送信されるため、タイトルとカテゴリーは後続の初期更新通知で届くことがあります。
- 終了通知は `stream.offline` ではなく API 補正ベースです。通知タイミングは `LIVE_RECONCILE_INTERVAL_MS` に依存します。
- login 名を解決できない Twitch ユーザーが含まれていると起動時にエラーになります。
- Slack は Incoming Webhook 前提です。
- `.env` が存在しない場合は token を自動保存しません。
