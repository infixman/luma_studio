# 後台的設計系統

後台原本是原生 HTML 元素加上散在各頁的樣式：每個列表自己排版、每個對話框是 `confirm()`、
每個下拉是 `<select>`。改成一組共用元件，參考的是 Strapi 的排版與 Payload 的編輯體驗——
抄的是 UI/UX，不是功能。

## 顏色與間距

[styles/tokens.css](../frontend/src/admin/styles/tokens.css) 是唯一的來源。名字說的是**用途**不是長相
（`--surface` 換了配色還活著，`--grey-100` 換配色那天要全站改名）。

間距、圓角、排版比例抄 Strapi，**顏色不抄**。原本連配色一起抄了（靛藍 `#4945ff`、頁面
`#181826`），結果就是長得跟每一個自動產生的後台一樣，而且跟它服務的那間工作室毫無關係。

現在是暖灰，取自前台自己的墨色，主色是**近黑的暖墨色不是彩色**——填色按鈕、目前頁面、選取
狀態都是「紙上的墨」。這樣畫面上唯一有飽和度的東西就剩下 danger / warning / success / info
四種狀態色，紅色徽章才會真的有意義，因為旁邊沒有藍色側欄和紫色按鈕在跟它搶。

深淺兩套共用同一組名字：

```text
:root                        淺色，也是預設
prefers-color-scheme: dark   系統偏好，僅在沒有 data-theme 時生效
[data-theme="dark"|"light"]  店主自己選的，蓋過系統
```

系統那條被 `:not([data-theme])` 擋著。少了這個保護，系統設深色時會贏過店主剛選的淺色，
切換鈕就只有單向有效。三態不是兩態：「跟隨系統」是真的選項，也是沒碰過切換鈕的人的現況。
存取在 [lib/theme.ts](../frontend/src/admin/lib/theme.ts)，在 render 之前就套用，否則會先閃一下淺色。

顏色對比全部量過，AA 以上。`--on-danger` / `--on-success` / `--on-warning` 這幾個存在的原因是
深色主題的紅綠橘都比較亮，白字踩在上面只有 2.6～3.3:1。

深色主題的主色是**反過來的**：淺色是紙上的墨，深色就是墨上的紙（`--primary: #e9e3da`）。但
`--primary-text` 不能跟著——近白的「連結」跟內文分不出來——所以那是唯一一處讓工作室自己的
赭色透出來的地方。

## 一條寫在 admin.css 裡的規則

「還沒搬到元件庫的裸控制項」那一段全部包在 `:where()` 裡，這是承重的。寫成
`body.admin button` 是 (0,1,2)，而任何用單一 class 描述自己的元件是 (0,1,0)——所以那條規則
會贏過 `.ui-icon-button`、`.picker-tile`、`.nav-group`。後台每一個 ghost 圖示按鈕都變成實心
方塊：拖曳把手、`⋯` 選單、網址鎖、複製、開啟，全部。

一個一個把元件的權重拉高這招已經做過兩次，下次再冒出一條 blanket rule 就要做第三次。降到
(0,0,0) 之後順序永久反轉：說得出自己長什麼樣的元件一定贏，什麼都沒寫的裸 `<button>` 還是有
一個合理的預設。

## 元件

`import { ... } from '../components/ui'` 一次拿到全部，樣式也是在那支 barrel 裡引入的。

| 元件 | 用途 |
| --- | --- |
| `Button` / `IconButton` / `ButtonRow` | 四種 tone：primary、neutral、ghost、danger |
| `Field` / `TextField` / `TextArea` | 標籤、說明、錯誤訊息的固定排法 |
| `Select` | 自繪下拉。方向鍵、Home/End、輸入字首跳選、Enter 選定、Escape 還原 |
| `Choice`：`Checkbox` / `RadioGroup` / `Toggle` | |
| `TagInput` | 媒體庫的標籤，含既有標籤的自動完成 |
| `Modal` / `useConfirm` | 對話框與 `await ask({...})`；焦點進得去、出不來、關掉會還回去 |
| `Bits`：`Panel` / `Badge` / `EmptyState` / `Spinner` / `TableWrap` / `Truncated` | |
| `DataTable` / `Toolbar` / `BulkBar` | 列表、工具列與「已選 N 筆」的批次列 |
| `ColumnChooser` | 顯示哪些欄，選擇記在 localStorage |
| `FilterBar` | 疊加式篩選規則，AND 相接 |
| `Menu` / `MenuItem` / `MenuGroup` | 區塊列尾端的 `⋯` |

不碰 DOM 的部分（[columns.ts](../frontend/src/admin/components/ui/columns.ts)、
[filters.ts](../frontend/src/admin/components/ui/filters.ts)）獨立成模組，所以測得到。

## 排版

一欄 248px 的選單，加上會跟著捲動的標題列。[AdminShell](../frontend/src/admin/components/AdminShell.tsx)
把兩者包起來，每一頁只交出內容與標題列上的按鈕。

選單是風琴摺疊的：

```text
官網    頁面 / 頁首頁尾 / 媒體庫
商城    訂單 / 商品 / 運費
會員    （沒有子項，本身就是連結）
工具    ibon / 名片
```

原本是兩欄——一排圖示，加上目前那一組的頁面清單。兩欄花 288px 顯示四個字，而且不在目前那一組
的頁面不只是收起來，是根本看不到：你沒辦法在不先猜「運費在購物車後面」的情況下知道它存在。

摺疊狀態記在 localStorage，但目前所在的那一組一定會展開——側欄上什麼都沒標記的話，它就沒在
告訴你人在哪裡，而那是側欄大部分的用途。

每一列都有 icon，子項也有。只有群組標題有而子項沒有，讀起來像兩種清單疊在一起。icon 是字符
不是「框裡裝東西」：一整排同樣大小的圓角矩形讀起來是同一個形狀重複，真正用來分辨的東西被留在
18px 裡做苦工。

## 幾條規則

- **CSS 選擇器要指明是誰。** `.cart`、`.custom-page`、`body.admin li` 這三次都出過事：
  為某一頁寫的樣式，套到了每一個穿著那個 class 的東西上。容器一律寫成 `main.x` 這種形式。
- **localStorage 的 key 只有一種取法**，[lib/storage.ts](../frontend/src/admin/lib/storage.ts) 的
  `key()`。同一天長出三種命名法就是第四種出現的原因。
- **長清單一律分頁**，後端 [paging.py](../backend/src/shared/paging.py)、前端
  [ui/Pagination.tsx](../frontend/src/admin/components/ui/Pagination.tsx)。訂單、會員與媒體庫
  以前是「只給最新的 200 筆，還有更多喔」——那不是清單，是一個「其餘的存在於你到不了的地方」
  的承諾。總數來自真正的 `COUNT(*)`，不是「這次回了幾筆」。
- **會被覆蓋的請求要記票號**，[lib/latest.ts](../frontend/src/admin/lib/latest.ts) 的 `useLatest()`。
  搜尋框輸入很快時，先發的慢答案會蓋在後發的快答案上面。
