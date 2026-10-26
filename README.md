# 稿费记录

把代写接单的每一笔稿费记清楚：**装到手机桌面、断网可用、多设备免费同步**。

- 前端是纯静态 PWA：不用打包、不用服务器，打开就能用
- 数据本地优先：先写本机，再后台同步，网络不好也不丢
- 云端用 **Supabase 免费版**（Postgres + 邮箱登录 + 行级权限），不绑卡
- 托管用 **GitHub Pages**（免费公开仓库），全套成本 ¥0
- 界面按苹果式极简重做：玻璃层、香槟金、弹性动效、深浅色跟随系统

---

## 目录

1. [先在电脑上看看](#1-先在电脑上看看)
2. [生成历史数据](#2-生成历史数据)
3. [配置云端同步（Supabase 免费版）](#3-配置云端同步supabase-免费版)
4. [部署到 GitHub Pages](#4-部署到-github-pages)
5. [装到手机](#5-装到手机)
6. [防止免费项目被暂停](#6-防止免费项目被暂停)
7. [数据与隐私](#7-数据与隐私)
8. [金额口径](#8-金额口径)
9. [开发与测试](#9-开发与测试)
10. [常见问题](#10-常见问题)
11. [目录结构](#11-目录结构)

---

## 1. 先在电脑上看看

```powershell
cd 稿费记录
python -m http.server 4173
```

浏览器打开 <http://127.0.0.1:4173/>。

| 页面 | 能做什么 |
| --- | --- |
| 概览 | 本月/本年/累计到手大数字、接单佣金、差额、单数、近 12 个月柱状图（点柱子看当月明细）、平台构成、客服排行、差额核对、待补到手、最近记录 |
| 明细 | 搜索、按年/平台/状态筛选、按月分组、左滑删除、长按多选后批量标记「已完成」（会自动补全额到手） |
| 我的 | 登录云端、立即同步、导入/导出备份、导出 CSV、平台管理、云端配置、同步诊断、外观切换、安装说明 |

演示数据：在网址后加 `?dev=1`（例如 `http://127.0.0.1:4173/?dev=1`），会读取本地的 `private/seed.json`，不会上传任何东西。

> 首次打开会走 3 步引导；「我的 → 导入备份」可以随时把 JSON 备份灌回来。

---

## 2. 生成历史数据

历史数据来自 `../代写/25、26` 下的 7 个 Excel（**只读，不会改动源文件**）。

```powershell
python scripts/import_xlsx.py
python scripts/verify_seed.py
```

输出（都在 `private/`，已被 `.gitignore` 忽略，不会进仓库）：

- `private/seed.json` —— App「导入备份」可直接读取
- `private/import-report.txt` —— 条数、金额、异常明细
- `private/import-report.txt` 里会列出**所有还没填到手的记录**，方便人工确认
- `private/expected.json` —— 固定口径（条数、金额、状态分布），`verify_seed.py` 和单测用它做核对；不放仓库

导入管线的规则：

- 平台由文件名识别，年份以「订单时间」为准（表名只作参考）
- 合并单元格自动向下填充（帆淼 5 月/6 月有 1 条订单拆多个订单号）
- 备注列误填成状态的（「完结」「已创建」）会挪回状态列
- 澜翎只有 8 列，没有作品和到手金额，用「账单金额」兜底佣金

电脑上打开 App →「我的 → 导入备份」→ 选择 `private/seed.json` 即可。

---

## 3. 配置云端同步（Supabase 免费版）

### 3.1 建项目

1. 打开 <https://supabase.com>，用 GitHub 账号登录（免费，不用绑卡）
2. **New project**，名字随意，数据库密码记好，区域选 **Singapore**（国内延迟相对低）
3. 等 1～2 分钟初始化

### 3.2 建表与权限

1. 左侧 **SQL Editor**
2. 打开本项目的 `supabase/schema.sql`，全选粘贴，点 **Run**
3. 会创建 `records`、`platforms`、`keepalive` 三张表，并开启行级权限（RLS）

### 3.3 关闭邮箱确认

**Authentication → Providers → Email**，把 **Confirm email** 关掉。

免费版自带发信服务不稳定，关闭后注册即可直接登录。

### 3.4 填配置

**Project Settings → API** 里复制：

- **Project URL**（`https://xxxx.supabase.co`）
- **anon public** key

两种填法，二选一：

- **写进 `config.js`**（推荐，一次搞定，手机端不用再填）
  ```js
  export const SUPABASE_URL = 'https://xxxx.supabase.co';
  export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
  ```
- **在 App 里填**：我的 → 云端配置 → 粘贴 URL 和 key → 保存（只存在这台设备）

> anon key 本来就是公开密钥，放在网页里没问题；数据安全靠数据库的行级权限，别人拿到 key 也只能看自己的记录。

### 3.5 首次上传

1. 电脑打开 App，先导入 `private/seed.json`
2. 「我的 → 登录云端」→ 注册一个邮箱账号
3. 首次同步会把本机记录和平台传到云端
4. 手机装好后登录同一账号，自动拉取

不想开浏览器也可以命令行直传：

```powershell
node scripts/seed_cloud.mjs --url https://xxxx.supabase.co --key <anon-key> `
  --email you@example.com --password 你的密码 --signup
```

---

## 4. 部署到 GitHub Pages

> 免费账号的 GitHub Pages 只支持**公开仓库**。本项目里没有任何稿费数据（数据在 Supabase 和你本机），公开代码是安全的。

1. 在 GitHub 新建一个**公开**仓库，例如 `gaofei`
2. 在本目录推送：

```powershell
git init
git add .
git commit -m "稿费记录 v1"
git branch -M main
git remote add origin https://github.com/<你的用户名>/gaofei.git
git push -u origin main
```

3. 仓库 **Settings → Pages**：
   - Source：**Deploy from a branch**
   - Branch：**main**，目录 **/ (root)**
   - Save
4. 等 1 分钟，地址是：`https://<你的用户名>.github.io/gaofei/`

以后更新：改完 `git push`，等 Pages 重新发布；已安装的 App 会提示「有新版本，点击刷新」。

> 如果 GitHub Pages 在国内访问偏慢，同一套文件可以原样传到 Vercel / Netlify，不需要改代码。

---

## 5. 装到手机

**Android（Chrome）**

1. 打开上面的网址
2. 右上角 **⋮ → 安装应用 / 添加到主屏幕**
3. 桌面出现「稿费」图标，点开是全屏 App

**iPhone（Safari）**

分享 → **添加到主屏幕**。

**电脑**

Chrome / Edge 地址栏右侧的安装图标。

装好以后断网也能打开、能记账，联网后自动同步。

---

## 6. 防止免费项目被暂停

Supabase 免费项目连续 **7 天没有任何请求**会被自动暂停（数据不会丢，去后台点 **Resume project** 就能恢复，暂停后 1 年内可恢复）。

本仓库带了一个保活工作流 `.github/workflows/keepalive.yml`：每 2 天查一次 `keepalive` 表。

启用方法：

1. 仓库 **Settings → Secrets and variables → Actions → New repository secret**
2. 添加两个 secret：
   - `SUPABASE_URL`：`https://xxxx.supabase.co`
   - `SUPABASE_ANON_KEY`：anon public key
3. 到 **Actions** 页面手动跑一次 `supabase-keepalive` 确认成功

> GitHub 会在仓库连续 60 天没有提交时停用定时工作流，届时在 Actions 页面点一次 **Enable workflow**。
>
> App 也能识别暂停：状态变成红色「同步失败」，点一下会提示去后台恢复；恢复后再点同步即可，改动一直留在本机。

---

## 7. 数据与隐私

- 记录默认只存在**当前浏览器**（localStorage）。
- 换手机、清理浏览器数据、卸载浏览器之前，请先 **我的 → 导出备份**。
- 云端只存你自己的账号数据，四类操作都受行级权限约束（`user_id = auth.uid()`）。
- 仓库里只有代码：`private/`（历史数据、报告、截图、测试脚本）全部被忽略。
- 退出登录不会删除本机数据，只清掉登录状态。
- 多设备同时改同一条：以更新时间更晚的一方为准（LWW），App 会提示「有 N 条记录被另一台设备的较新修改覆盖」。

---

## 8. 金额口径

- **已完成 + 没备注 + 没填到手 = 全额到手**（`received_inferred = true`，界面上标「按全额推定」）。
- 填了到手金额就以手填为准；清空后又按上面的规则自动算。
- 「差额」= 接单佣金 − 到手金额，只统计已经填了到手的记录。
- 还没填到手的记录会在概览的「待补到手」卡片里；补的时候可以在明细里长按多选，批量「标记已完成」，没填到手的会自动补全额。

---

## 9. 开发与测试

无构建、无依赖：`index.html + styles.css + app.js + lib.js + sync.js + config.js`。

```powershell
npm run check                # 全部 JS 语法检查
npm test                     # 纯逻辑单测（lib / sync / seed）
python scripts/import_xlsx.py
python scripts/verify_seed.py
```

本地私有脚本（不提交）：

- `private/cdp.mjs`、`private/interact.mjs`、`private/screens2.mjs`、`private/cloud-e2e.mjs`：用 Chrome 远程调试做截图与交互回归
- `private/mock-supabase.mjs`：假 Supabase，用于离线跑通「登录 → 上传 → 拉取 → 暂停 → 恢复」全链路

`private/` 里的东西只用于本地开发，别提交，也不要放到公开仓库。

---

## 10. 常见问题

| 现象 | 处理 |
| --- | --- |
| 同步失败，提示「云端项目已暂停」 | 打开 supabase.com/dashboard → Resume project，再点同步 |
| 提示「云端表不存在」 | 没执行 `supabase/schema.sql`，去 SQL Editor 跑一遍 |
| 登录提示「邮箱或密码不对」 | 检查密码；忘记密码用 Supabase Authentication → Users 重置 |
| 注册后要求确认邮箱 | Authentication → Providers → Email 关闭 Confirm email |
| 手机打开是旧版本 | 下拉刷新，或在提示「有新版本」时点刷新；也可以清站点数据重装 |
| 国内 GitHub Pages 打不开 | 换 Vercel / Netlify 部署同一套文件 |
| 换手机怎么搬数据 | 旧手机导出 JSON → 新手机导入；或者直接登录同一云端账号 |
| 免费额度够用吗 | 数据量只有几十 KB；Supabase 免费 500MB、GitHub Pages 免费 100GB/月 |

---

## 11. 目录结构

```
稿费记录/
├── index.html                 页面骨架（图标 sprite、底部导航）
├── styles.css                 设计系统：玻璃、香槟金、动效、深浅色
├── app.js                     路由、页面、弹层、表单、交互
├── lib.js                     纯逻辑：归一化、统计、筛选、备份、CSV
├── sync.js                    Supabase 客户端：登录、增量拉取、LWW 合并
├── config.js                  Supabase URL / anon key（默认留空）
├── sw.js                      Service Worker：离线缓存、版本更新
├── manifest.webmanifest       PWA 清单
├── assets/                    图标（svg / 192 / 512 / maskable）
├── supabase/schema.sql        建表 + RLS + 保活表
├── .github/workflows/keepalive.yml
├── scripts/
│   ├── import_xlsx.py         Excel → private/seed.json（只读源表）
│   ├── verify_seed.py         口径校验
│   └── seed_cloud.mjs         命令行直传云端（可选）
├── tests/                     node:test 单测
├── private/                   ← 本地数据，永不提交（seed、报告、截图、测试脚本）
└── README.md
```

---

所有金额、作品、客服信息都只属于你。数据丢了不可怕，**记得偶尔导出一次备份**。
