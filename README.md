# Left to Spend

Personal finance tracker for iPhone. It answers two questions: how much more can I spend, and how much should I save.

This repo holds the app only. Financial data lives in a separate private repo.

## Set up

1. In this repo, open Settings, then Pages. Deploy from the `main` branch, root folder.
2. Create a private repo, for example `lts-data`.
3. Create a fine-grained GitHub token limited to that private repo, with Contents set to read and write.
4. Open the Pages link in Safari on your iPhone. Tap Share, then Add to Home Screen.
5. In the app, open Plan and enter your salary and payday. Then add your accounts and commitments.
6. Under Sync with GitHub, enter the private repo and token.

The token stays on the device. Enter it once on each device.

## Test

```sh
node --test
```
