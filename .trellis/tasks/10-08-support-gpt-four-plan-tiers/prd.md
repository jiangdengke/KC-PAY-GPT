# 支持 GPT 四档套餐与开卡金额

## Goal

将系统套餐模型从 `plus/pro_5x/pro_20x` 升级为官方本地凭据状态 `plus/pro100/pro200/pro500`，先完成界面、内部数据流与 Orbitcard 开卡金额策略，再按 Desolate Recharge API 文档接通第三方协议。

## What I already know

* 官方本地 Subscription Credential 状态现为 `plus`、`pro100`、`pro200`、`pro500`。
* 当前 `planType` 贯穿 CDK、订单、第三方 plan key、Checkout `plan_name`、Orbitcard 产品价格与开卡金额、后台筛选和通知展示。
* 当前未知套餐在若干路径会回退到 Plus；新实现必须严格校验，不能静默降级。
* Desolate 文档入口为 <https://recharge.desolate.run/app/api-docs>，页面依赖 JavaScript 渲染。
* 现有数据库 `plan_type` 列宽足够容纳四个新枚举，无需扩列。
* 用户明确要求界面先做好；后续重点是第三方协议对接和开卡金额。

## Assumptions

* 新写入统一使用 `plus/pro100/pro200/pro500`。
* 旧 `pro_5x/pro_20x` 数据保留兼容读取；在未取得明确业务映射前不擅自批量改写。
* Orbitcard 优先使用产品目录中对应套餐的实时 `gpt_plan_prices`；开卡金额由套餐价格、保留余额、复用上限和安全余量计算，固定金额仅作缺失价格时的显式配置或错误边界。
* Desolate 协议映射以其公开文档或套餐列表接口为准，不根据名称猜测隐藏代码。

## Requirements

* 建立单一套餐注册表，集中维护枚举、标签、兼容别名、第三方代码和开卡策略。
* 凭据查询保留 `pro100/pro200/pro500` 精确状态，不再统一压缩成 `pro`。
* 后台 CDK、Checkout 调试、Orbitcard 策略、用卡筛选、账单和通知展示四档套餐。
* 用户端 CDK 查询与兑换展示四档套餐。
* CDK 生成、导入、兑换、任务执行和数据库筛选接受四档新枚举。
* Orbitcard 产品目录、自动选择、手动选择和开卡金额支持四档套餐。
* Desolate Open 协议按文档映射四档套餐；协议不支持的套餐返回清晰错误。
* 未知套餐不得回退为 Plus。
* 旧数据仍可展示和查询，不破坏已有任务历史。

## Open Questions

* Desolate 文档中的四档真实 plan key 与接口能力，以研究结果为准。
* Orbitcard 上游 `gpt_plan_prices[].id` 是否已同步为四档新 ID，以实际目录兼容策略为准。

## Acceptance Criteria

* [ ] 套餐选择界面显示 Plus、Pro 100、Pro 200、Pro 500。
* [ ] Subscription Credential 解析分别返回 `plus/pro100/pro200/pro500`。
* [ ] 新 CDK 只写入四档新枚举，未知枚举被拒绝。
* [ ] Desolate 请求使用文档定义的四档 plan key；缺失映射时明确报错。
* [ ] Orbitcard 为四档分别解析产品价格并计算足额开卡金额。
* [ ] 管理端可配置和展示每档复用上限及开卡参数。
* [ ] 旧 `pro_5x/pro_20x` 记录仍可读取、筛选和显示。
* [ ] `npm test`、相关 `node --check` 与 `git diff --check` 通过。

## Definition of Done

* 代码和测试完成。
* Desolate 协议研究记录归档到 `research/`。
* 跨层套餐契约更新到 Trellis spec。
* 改动通过检查并提交。

## Out of Scope

* 未经明确映射批量改写历史 `pro_5x/pro_20x` 数据。
* 猜测或硬编码文档未公开的第三方套餐代码。
* 改变 Orbitcard 既有产品优先级、4002 禁用、卡片同步和失败回滚规则。

## Technical Notes

* 主要文件：`subscription-check.js`、`mysql-store.js`、`server.js`、`chatgpt.js`、`gpt-api-client.js`、`orbitcard-client.js`、`pricing-checkout.js`、`region-config.js`、`telegram-notify.js`、`public/admin.html`、`public/admin.js`、`public/index.html`。
* 当前旧枚举在 13 个生产文件中约有 135 处命中，必须通过共享注册表减少重复。
* 数据库字段为 `VARCHAR(16)` 或 `VARCHAR(32)`，新值最长 6 字符。

## Decision (ADR-lite)

**Context**: 当前同一个 `planType` 同时承担多层含义，直接全局替换会造成错误回退和金额错配。

**Decision**: 使用统一内部四档 SKU 注册表，并为 Subscription Credential、Checkout、Desolate 和 Orbitcard 建立显式映射；新值严格校验，旧值仅兼容读取。

**Consequences**: 本次改动涉及前后端多层，但后续第三方协议变化只需更新映射层，不再散落修改界面和业务代码。
