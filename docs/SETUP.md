# HIKARI NEWS 设置指南

按顺序做下来大约需要 1 小时。界面可能是日文或中文，两种说法都写上了。

```
① Firebase 项目          ← 控制台操作
② 网站和规则的部署        ← 在电脑上执行几条命令
③ 把自己设为管理员
④ 机器人用的密钥（低权限）
⑤ Discord Webhook
⑥ Claude 的云端环境 + 定时任务
⑦ 测试
```

---

## ① Firebase 项目

### 1-1 创建项目
1. 打开 https://console.firebase.google.com ，用 Google 账号登录。
2. 点「Firebase プロジェクトを作成 / 创建 Firebase 项目」。
3. 项目名称填 `hikari-news`。名称下方会显示**项目 ID**（例如 `hikari-news-1a2b3`），请记下来。
4. Gemini / AI 助手之类的选项可以关闭。**Google Analytics 要关闭**。
5. 点「プロジェクトを作成」，完成后点「続行」。
6. 方案保持免费的 **Spark** 即可，不需要绑定信用卡。

### 1-2 开启 Google 登录
1. 左侧菜单「構築 / 构建」→「Authentication」→「始める / 开始使用」。
2. 「ログイン方法 / Sign-in method」→「Google」→ 打开「有効にする / 启用」。
3. 支持邮箱选你自己的地址，然后保存。

### 1-3 创建 Firestore 数据库
1. 左侧「構築」→「Firestore Database」→「データベースの作成 / 创建数据库」。
2. 版本选 Standard，数据库 ID 保持 `(default)`。
3. 位置选 **asia-northeast1 (Tokyo)**。⚠️ 之后无法修改。
4. 选「本番環境モード / 生产模式」→「作成」。

### 1-4 注册网页应用
1. 左上角 ⚙️ →「プロジェクトの設定 / 项目设置」→「全般 / 常规」→ 拉到最下方「マイアプリ / 你的应用」。
2. 点 `</>`（ウェブ），昵称填 `hikari-news-web`，勾选「Firebase Hosting も設定する」，然后点「アプリを登録」。
3. 把显示出来的 `firebaseConfig` 的内容填进 `public/firebase-config.js`。这是公开信息，可以提交到 GitHub。
4. 后面的「SDK の追加」「CLI のインストール」直接点「次へ」跳过，最后点「コンソールに進む」。

---

## ② 部署网站和数据库规则

只在第一次和修改网站代码时需要做。

1. 安装 **Node.js**：在 https://nodejs.org 下载 **LTS** 版，一路「下一步」装完即可。
2. 打开 PowerShell，执行：
   ```
   cd D:\PJ\HIKARI_NEWS
   npx firebase-tools login
   ```
   浏览器会打开，用 Google 账号登录并允许授权。
3. 部署（项目 ID 已经写在 `.firebaserc` 里，不用另外指定）：
   ```
   npx firebase-tools deploy --only hosting,firestore:rules
   ```
4. 成功后会显示 `Hosting URL: https://<项目ID>.web.app`，这就是网站地址。
   把它填进 `config.json` 的 `site_url`，之后 Discord 消息末尾就会附上网站链接。

---

## ③ 把自己设为管理员

1. 打开网站，用你的 Google 账号登录。会显示「閲覧申請」画面，**不用提交**。
2. 回到 Firebase 控制台 →「Authentication」→「ユーザー / 用户」标签，复制你那一行的「**ユーザー UID**」。
3. 打开「Firestore Database」→「データ」标签 →「**コレクションを開始 / 启动集合**」。
   - コレクション ID：`admins`
   - ドキュメント ID：**粘贴你的 UID**
   - 字段：名称 `role`，类型 string，值 `owner`
   - 点「保存」。
4. 刷新网站，就能看到所有内容，还会多出「⚙️ 管理」标签页。

**之后的日常操作**：有人申请时，Discord 会收到「🙋 新しい閲覧申請」通知（在早晚的定时运行时一起发送）。到网站的「⚙️ 管理」点「承認」或「拒否」即可。

---

## ④ 机器人用的密钥（只能读写数据库的低权限账号）

机器人需要一把钥匙才能往数据库写内容。这里新建一个**只有数据库权限**的账号，万一密钥泄露，影响也有限。

1. 打开 https://console.cloud.google.com/iam-admin/serviceaccounts ，在上方选择你的 Firebase 项目。
2. 点「**サービス アカウントを作成 / 创建服务账号**」。
   - 名称：`hikari-news-bot`，然后点「作成して続行」。
   - 「ロール / 角色」搜索并选择 **Cloud Datastore ユーザー（Cloud Datastore User）**，然后点「続行」→「完了」。
3. 在列表里点刚建好的 `hikari-news-bot` →「**鍵 / 密钥**」标签 →「鍵を追加」→「新しい鍵を作成」→ 选 **JSON** →「作成」。
   - 会下载一个 `.json` 文件，这就是密钥。⚠️ **不要发给任何人，不要放进 GitHub 仓库的文件夹。**
4. 在 PowerShell 里把它转成一行文字，并复制到剪贴板（路径换成实际下载的位置）：
   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\下载的文件名.json")) | Set-Clipboard
   ```
   复制好的这一长串文字，就是第 ⑥ 步要填的 `FIREBASE_SERVICE_ACCOUNT_B64`。
5. 设置完成后，下载的 JSON 文件可以删除。需要时可以重新生成新的密钥。

---

## ⑤ Discord Webhook

1. 在 Discord 里点要接收推送的频道旁边的 ⚙️ →「連携サービス / 整合」→「ウェブフック / Webhook」→「新しいウェブフック」。
2. 名字可以取「HIKARI NEWS」，确认频道没选错，然后点「**ウェブフック URL をコピー**」。
3. 这个 URL 就是 `DISCORD_WEBHOOK_URL`。⚠️ 有它就能往频道发消息，不要公开。

---

## ⑥ Claude 的云端环境 + 定时任务

需要 Claude 的 Pro 或 Max 订阅。这个功能目前是 research preview，界面可能会有变化。

### 6-1 连接 GitHub
1. 打开 https://claude.ai/code ，按提示连接 GitHub，并允许访问 `HIKARI_NEWS` 仓库（安装 Claude GitHub App）。
2. 确认 `HIKARI_NEWS` 仓库的默认分支（main）上已经有最新代码。定时任务每次都会复制默认分支。

### 6-2 创建云端环境
在新建定时任务的界面里：「Advanced settings」→「Cloud environment」→ 新建环境（名称 `hikari-news`），设置如下。

**Network（网络）**：选 `Limited`，勾选「Allow package managers」。「Allowed domains」里一行填一个：
```
discord.com
hn.algolia.com
www.reddit.com
qiita.com
zenn.dev
api.bsky.app
```

**Environment variables（环境变量）**：一行一个，等号前后不要有空格：
```
DISCORD_WEBHOOK_URL=第⑤步复制的URL
FIREBASE_SERVICE_ACCOUNT_B64=第④步复制的那一长串
```
> 这个环境只给自己用，不要分享给别人。

**Setup script（安装脚本）**：
```
python3 -m pip install -q --break-system-packages --ignore-installed requests firebase-admin
```

### 6-3 创建定时任务
1. 打开 https://claude.ai/code/routines（或者桌面版 Claude 的 Code 标签 →「Scheduled」）→ 新建。
2. **Repository**：`HIKARI_NEWS`。**Environment**：`hikari-news`。
3. **Model**：选 Sonnet 或 Opus。Pro 订阅建议选 Sonnet，比较省额度。
4. **Instructions（指示）**：
   ```
   请阅读仓库根目录的 RESEARCH.md，严格按照里面的步骤完成本次的研究和发布。
   不要 commit、push 或创建 PR。
   ```
5. **Schedule**：选 Custom，填：
   ```
   CRON_TZ=Asia/Tokyo 7 8,20 * * *
   ```
   意思是日本时间每天 8:07 和 20:07。如果不接受这种写法，就建两个定时任务，分别设为每天 8:07 和 20:07。

---

## ⑦ 测试

1. 在定时任务页面点「**Run now / 今すぐ実行**」。
2. 打开运行记录，看 Claude 是否按步骤执行，最后有没有显示「✅ 发布完成」。
3. 检查 Discord 频道和网站有没有出现内容。

**常见问题**
- `Discord 推送失败: HTTP 403`：网络设置的 Allowed domains 里没有 `discord.com`。
- Firestore 报 `PERMISSION_DENIED`：第 ④ 步的角色没有选「Cloud Datastore ユーザー」。
- 网站登录后显示「読み込みに失敗しました」：第 ② 步的规则没有部署，或第 ③ 步的 UID 填错了。
- WebFetch 打不开网页：可能是 Limited 网络的限制，把运行记录发给我，一起调整设置。

---

## 平时怎么改

| 想做的事 | 改哪里 |
|---|---|
| 改研究方向、质量标准 | `RESEARCH.md` |
| 改分类、排班、关注关键词、社区来源 | `config.json` |
| 改网站外观和功能 | `public/` 目录，改完后重新执行第 ② 步的部署命令 |
| 批准或拒绝浏览申请 | 网站上的「⚙️ 管理」 |

改完后 push 到 GitHub 的 main 分支，下一次定时运行就会使用新内容。
