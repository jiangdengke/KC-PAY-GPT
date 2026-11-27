# PRD: Orbitcard 自动开卡开关与同步卡按余额自动推算 Plus 次数

## 背景与目标
当前 Orbitcard 卡源在本地无可用复用卡时会自动调用 `createCardUntilReady` 开新卡；而管理员手动在第三方卡台开卡后，点击「同步卡台卡片」入库的卡片默认为「未绑定套餐」，需要逐张手动绑定。

本次变更新增「允许自动开卡」开关（默认关闭），并在关闭自动开卡时支持管理员手动在卡台开卡、系统自动/手动同步卡片，并根据卡片当前余额自动推算可充 Plus 次数并自动绑定。

## 已确认的需求决策
1. **自动开卡开关**：
   - 新增持久化配置 `orbitcard_auto_create_card`（默认 `0` 关闭），在后台「支付与资产 → Orbitcard 开卡策略」提供开关。
   - 关闭时禁止调用 `createCardUntilReady`；开启时保留原有按优先级/指定产品自动开卡能力。
2. **按余额自动推算可开 Plus 次数**：
   - 优先匹配 `getProductCode()` 实时产品目录中该卡对应产品的 Plus 套餐价 + `min_retained_balance` + 配置的 Plus 安全余量（`orbitcard_safety_margin_plus`）。
   - 未匹配到目录价格时，使用后台可配置的兜底 Plus 单价 `orbitcard_plus_unit_price`（默认 `20` USD，范围 1–500）。
   - 计算公式：`rawCount = Math.floor((balance - minRetainedBalance - safetyMargin) / unitPrice)`，结果受配置的 Plus 一卡几冲上限（`orbitcard_reuse_limit_plus`，1–20）封顶。
   - 仅对状态 `ACTIVE`、非 4002 禁用 BIN、且**尚未绑定套餐（`plan_type IS NULL`）**的新卡自动绑定为 `plus` 并写入推算次数；绝不覆盖已有绑定卡（含手动绑定的 Pro 卡）。
3. **关闭自动开卡时的下单兜底**：
   - 订单取卡时先尝试预留本地可用卡；若无可用卡，先自动同步一次卡台新卡并按余额推算绑定，然后重试预留。
   - 仍无可用卡时：不调用开卡接口、不写入人工审核 hold、回滚 CDK 为未使用，并触发 Telegram `card_pool_empty` 缺卡告警。
