# 历史事件检索

一个单文件网页：输入关键词就能搜历史重大事件，可以收藏、写笔记。纯静态，放到 GitHub Pages 就能用，不需要服务器和数据库。

## 数据从哪来（三种方案，可叠加）

| 方案 | 工作量 | 国内可用性 | 说明 |
| --- | --- | --- | --- |
| ① 内置精选库 | 零 | 最好 | `index.html` 里已内置 119 条中外重大事件，开箱即用 |
| ② 脚本预抓（推荐） | 一条命令 | 最好 | `tools/bake.mjs` 从维基数据抓约 600 条事件生成 `data/events.json`，页面自动加载，之后完全离线 |
| ③ 网页内实时检索 | 零 | 取决于中转 | 搜索时同时查中文维基百科首段，国内直连通常不通，需要自建中转（见下） |

②+③ 配合使用体验最好：常用事件秒出（本地），冷门事件由维基补充。

### 生成数据

```bash
node tools/bake.mjs                # 默认 1200 条，实际约 600 条符合筛选条件
node tools/bake.mjs --limit 300    # 想少一点
```

筛选规则：类型限定为战争 / 战役 / 革命 / 起义 / 政变 / 条约 / 屠杀 / 恐怖袭击 / 地震 / 疾病爆发 / 灾害，要求有中文维基条目，跨语言条目数 ≥ 25（战役 ≥ 45），按跨语言条目数排序。摘要取中文维基首段（自动转简体）。

抓取结果缓存在 `.cache/extracts.json`，中断后重跑会跳过已抓部分。

仓库里带了 GitHub Actions（`.github/workflows/bake-events.yml`），每周一自动跑一次并提交新的 `data/events.json`，也可以手动触发（Actions → bake-events → Run workflow）。提交之后 GitHub Pages 会自动重新发布。

## 部署到 GitHub Pages

1. 新建仓库，把本目录的文件传上去（保持 `index.html` 在仓库根目录）。
2. Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`。
3. 等一两分钟，访问 `https://<用户名>.github.io/<仓库名>/`。

国内访问 `github.io` 有时不稳定，可以让朋友用镜像加速域名，或者换成 Cloudflare Pages / Vercel + 自己的域名。

## 中转地址（网页内实时检索用）

国内网络直连维基百科一般会失败。做法：在 [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → 新建 Worker，粘贴下面代码，部署后得到一个 `https://xxx.workers.dev` 地址，把它填进网页「设置 → 中转地址」（格式 `https://xxx.workers.dev/?url={url}`）。

```js
export default {
  async fetch(req) {
    const u = new URL(req.url);
    const target = u.searchParams.get("url");
    if (!target) return new Response("missing url", { status: 400 });
    if (!/^https:\/\/[a-z.]*wikipedia\.org\//.test(target))
      return new Response("not allowed", { status: 403 });
    const r = await fetch(target, { headers: { "User-Agent": "history-search/1.0" } });
    const h = new Headers(r.headers);
    h.set("Access-Control-Allow-Origin", "*");
    h.set("Cache-Control", "public, max-age=86400");
    return new Response(r.body, { status: r.status, headers: h });
  }
}
```

这段代码在网页设置里点「复制 Worker 代码」也能拿到。注意 `workers.dev` 域名在国内也不一定通，这种情况就只靠方案 ①②（预抓数据），体验反而更快。

## 界面

- 搜索框支持事件名、人物、年份；空格分词，多个词要与同一内容匹配。
- 分类筛选、收藏、每条事件的笔记，均保存在浏览器 `localStorage`。
- 设置里可改：背景颜色（含 8 个预设）、上传背景图片（本地压缩后保存，不上传服务器）、背景遮罩浓度、主题色、站外检索开关与语言。
- 设置 → 导出 JSON 可备份收藏与笔记，换设备后导入。
- 快捷键：`/` 聚焦搜索，`Esc` 关闭面板。

## 文件

```
index.html                     页面本体（无依赖，可单独使用）
data/events.json               预抓事件数据（可选，没有也能用）
tools/bake.mjs                 数据抓取脚本
.github/workflows/bake-events.yml  每周自动更新数据
```
