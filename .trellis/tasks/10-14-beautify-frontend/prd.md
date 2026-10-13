# 美化前台页面（精修蓝色风 + 暗色模式）

## Goal

提升前台三页（卡密兑换首页、发票助手、后台登录）的视觉质感与一致性，让用户侧页面更专业可信；不改动业务逻辑、接口或交互流程。

## Decisions (confirmed with user, 2026-10-14)

* **范围**：前台三页 —— `public/index.html`、`public/subscription.html`、`public/admin-login.html`，以及它们共用的 `public/style.css`、`public/favicon.svg`。后台控制台（`admin.html` / `admin.css` / `admin.js`）不在本次范围。
* **方向**：精修现有蓝色企业风。保留蓝色品牌和整体布局，统一字体、加强层级与留白、精修卡片/按钮/步骤条/状态，修掉布局瑕疵，并跟随系统暗色模式。

## What I already know

* 前端是 Express 静态托管的原生 HTML/CSS/JS，无构建步骤；`style.css` 只被 `index.html`、`subscription.html` 引用。
* 截图巡检发现的问题：
  * 字体不一致：`index.html`/`subscription.html` 加载 Inter，但 `style.css` 首选未加载的 `Outfit`；登录页加载 Outfit。
  * `lucide@latest` 未锁版本，且作为同步脚本放在 `<head>`；图标要等脚本执行后才出现。
  * `favicon.svg` 是紫色渐变，与蓝色品牌不一致。
  * 首页移动端状态徽章被挤到标题下单独一行；两步 stepper 连线很短、右侧留白大。
  * `style.css` 约 1/3 是已无引用的旧样式（`.glass-container`、`.logo`、`.plan-card`、`[style*=...]` 暗色兼容覆盖等）和大量硬编码色值，无法支持暗色。
  * `/subscription/`（带尾斜杠）或自定义登录路径带尾斜杠时，相对路径 `style.css` 会解析错误。

## Requirements

* 只改展示层：HTML 结构微调、CSS、图标与字体资源。不改 API 调用、业务流程、JS 依赖的 DOM id 与 class（`.step-item`、`.flow-badge.*`、`.status-success/error`、`.query-row`、`.batch-query-*`、`.method-tab` 等）。
* `style.css` 重写为设计令牌驱动：浅色 + `prefers-color-scheme: dark` 两套令牌；删除无引用的旧样式。
* 图标：用页面内联 SVG sprite 替换 `lucide` CDN 脚本（同一套 Lucide 图标），并移除对应的 `lucide.createIcons()` 调用。
* 字体：三页统一 Inter + 系统中文字体回退，加 `preconnect`。
* 样式表引用改为绝对路径 `/style.css`；登录页改为复用 `/style.css`（新增作用域在 `body.login-page` 下的样式），去掉内联 `<style>`。
* `favicon.svg` 改为品牌蓝渐变（同样的闪电图形）。
* 添加 `color-scheme` 与 `theme-color` meta。
* 桌面与移动端（≤640px）不溢出、无横向滚动；保留并扩展 `prefers-reduced-motion` 降级；可聚焦元素有清晰的 `:focus-visible` 样式。
* 保留上一任务对"发票助手"可点击 CTA 的区分处理。

## Acceptance Criteria

* [ ] 三页在桌面（1280）与移动（390）宽度、浅色与暗色下截图对比无布局回归，所有文本对比度清晰。
* [ ] 首页关键状态都有正确样式：步骤 1/2、运行中进度条、成功/失败提示、单个与批量查询结果、人机验证面板。
* [ ] 登录页两步（账号密码 / 二次验证含多方式切换）样式正确。
* [ ] 页面不再请求 unpkg；控制台无 JS 报错。
* [ ] `npm test`、`git diff --check` 通过；内联脚本语法检查通过。

## Out of Scope

* 后台控制台视觉（后续可单独立项）。
* 后端接口、数据库、业务流程、文案与页面标题的品牌名统一。
* 前端框架迁移 / 引入构建工具。

## Technical Notes

* 截图脚本（Playwright + 本地静态服务 + mock `/api/*`）放在会话 scratchpad，用于前后对比。
* Lucide 当前 latest 解析为 1.56.0；图标 SVG 路径取自同版本，视觉保持一致。
* 登录页可能挂在自定义路径（含尾斜杠），因此样式表必须用绝对路径。
* 相关规范：`.trellis/spec/frontend/quality-guidelines.md`。
