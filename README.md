# interval-injector

定期把一段文字注入對話歷史的通用注入器（DSH / Cordis agent plugin）。

## 為什麼需要它

system prompt 每輪都重送，但它永遠在整串對話的最前面；對話一長，指示就被後面的內容稀釋。

這支外掛每隔 N 個步驟、或每隔 N 分鐘（哪個先到算哪個），把 `config.text` 當成一則 user-role 訊息插進對話中間——最靠近模型回答的位置。內容不綁用途，換 `text` 就是換用途。

## 安裝

```sh
pnpm dsh plugin --profile web add github:rainfishs/dsh-interval-injector
```

`--profile` 後面換成你要掛的 profile 名。

它不宣告 `dsh.bundle`，裝進去只是普通依賴，不會自動變成 profile 的一層。

## 掛載

寫在 agent preset 的 composition 裡：

```yaml
- id: interval-injector
  name: 'interval-injector'
  config:
    everyNSteps: 20
    refreshIntervalMs: 1800000
    text: |
      （想定期重貼的內容）
```

只有掛這一行的那個 preset 的 session 會生效。

## 設定

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `text` | （必填） | 每次要注入的文字。空字串＝外掛不作用。 |
| `everyNSteps` | `12` | 每隔幾個「進入步驟」注入一次。`0` = 關掉這個條件。 |
| `refreshIntervalMs` | `600000` | 距上次注入超過幾毫秒就注入。`0` = 關掉這個條件。 |
| `summary` | `定期注入` | 收合在對話列上的單行說明。 |

`everyNSteps` 與 `refreshIntervalMs` 是「哪個先到就先注入一次」；兩個都設 `0` 等於關掉整支外掛。

## 實作注意

- 監聽 `agent/pre-step`（waterfall），`next()` 之後才把訊息接在尾端，並以 `{ prepend: true }` 註冊，排在最靠近模型回答的位置。
- 空回合與被拒絕的回合都不注入，免得無中生有一個請求。
- 每個 agent 各自用 `WeakMap` 計數，session 結束就回收；外掛停用時監聽隨 fiber 一起移除。
- **零依賴**：訊息結構自行建立（`randomUUID` + 遞迴凍結），純 JS 即可執行，不需要 build。
- 訊息 `source` 用官方已發佈的 `{ kind: 'plugin', plugin, form: 'notice', summary }` 形狀。

## License

MIT
