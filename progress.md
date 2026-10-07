

## 2026-08-14 - Task: 修復 GPT 代充 API 協議代理傳參
### What was done
- Session inspect 保留為不使用代理的本機格式／到期檢查。
- 執行代充時從本地代理池取得啟用代理並傳入 `/pay.proxy`；本地池為空時省略欄位，由平台啟用代理池兜底。
- 完整 Session payload 繼續傳入，固定 CDK 冪等鍵不變。
- 重寫 `協議api.md`，對齊 inspect 無代理、Worker 協議有代理的新規格。
- 修正 Vitest CommonJS 測試載入方式。
### Testing
- `node --check gpt-api-client.js`、`node --check server.js` 通過。
- `npm test -- test/gpt-api-client.test.js`：3 passed。
- 線上使用正式 API 設定呼叫 inspect 成功，回 `reason=local_check`。
- 契約驗證確認 `/pay` payload 同時包含完整 Session 與 proxy。
- `docker compose up -d --build app` 成功，app 容器 healthy。
### Notes
- `gpt-api-client.js`：`submitPay` 支援並傳送 proxy。
- `server.js`：取得協議代理並傳入平台，保留平台代理回退。
- `test/gpt-api-client.test.js`：改驗證 proxy 會傳送並修復 Vitest 載入。
- `協議api.md`：更新完整協議與 403 風險說明。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並執行 `docker compose up -d --build app`；回滾會恢復不傳代理的舊行為。


## 2026-08-14 - Task: 補齊 GPT API 套餐與卡片相容性
### What was done
- 新增 `pro_5x → pro5x`、`pro_20x → pro20x` 映射，inspect 與 pay 共用同一平台套餐鍵。
- `GET /plans` 客戶端支援平台 `{gpt, credit}` 回應。
- 卡片有效期嚴格支援 `MMYY`、`MM/YY`、`MM/YYYY`；無效格式明確失敗，不再回退 2030。
### Testing
- Node 語法檢查通過。
- `npm test -- test/gpt-api-client.test.js`：4 passed。
### Notes
- `server.js`：新增套餐鍵映射與有效期解析。
- `gpt-api-client.js`：支援 `raw.gpt` 套餐陣列。
- `test/gpt-api-client.test.js`：增加 plans 回應契約測試。
- `協議api.md`：補充套餐映射及有效期格式。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並重建 app；回滾會使 Pro 套餐重新可能回 `plan_disabled`。


## 2026-08-14 - Task: 修復平台任務 done 誤判激活成功
### What was done
- 查詢 task 時優先讀取 `result.status`，不再把 queue 外層 `done` 當業務成功。
- 移除 `done` 成功終態；`result.ok=false` 強制按失敗處理並顯示內層錯誤。
### Testing
- `npm test -- test/gpt-api-client.test.js`：5 passed。
- 線上容器契約驗證：`done + result.failed → failed`，`done + result.success → success`。
- app 重建部署成功，容器 healthy。
### Notes
- `gpt-api-client.js`：優先解析內層業務狀態。
- `server.js`：移除 done 成功映射並使用 result.ok／error。
- `test/gpt-api-client.test.js`：新增 queue done 與業務終態回歸測試。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並重建 app；回滾會再次把失敗任務誤報成功。


## 2026-09-23 - Task: 修復並部署 Session 管理表格布局
### What was done
- 修正 Session 管理表格列宽不足造成的逐字换行，较长内容改为横向滚动查看。
- 仅将 Session 布局补丁应用到 rn 当前页面资源，保留原文件备份，未重启应用。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `ReadLints` 检查 `public/admin.html`、`public/admin.css`：无诊断。
- rn 运行中的管理页面与新版 CSS 均返回 HTTP 200，页面引用新版样式且包含布局修复；应用容器保持 healthy。
### Notes
- `public/admin.html`：指定 Session 列宽并更新样式缓存版本。
- `public/admin.css`：扩大 Session 表格最小宽度，避免 ID 逐字换行并限制预览文本。
- `progress.md`：记录本轮部署与验证结果。
- 回滚：分别执行 `ssh rn 'cp /root/KC-GPT-PAY/public/admin.html.bak-session-layout-20260923 /root/KC-GPT-PAY/public/admin.html'` 与 `ssh rn 'cp /root/KC-GPT-PAY/public/admin.css.bak-session-layout-20260923 /root/KC-GPT-PAY/public/admin.css'` 恢复部署前文件。


## 2026-09-23 - Task: 完善代充订单提示与卡片复用管控
### What was done
- 保留上游订单进度说明，并为 Orbitcard 新卡按套餐配置复用次数与首充预算。
- 将待人工复核限制绑定到卡密，补充管理端任务详情与 Session 分页查询。
- 补充 Orbitcard 复用规则和配置文档。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `git diff --check`：通过。
### Notes
- `gpt-api-client.js`：提取并保留上游订单进度消息。
- `orbitcard-client.js`：支持读取配置的套餐复用上限并计算首充金额。
- `mysql-store.js`：持久化复用次数、支持任务详情、Session 分页及 CDK 复核查询。
- `mysql-schema.sql`：为按卡密查询待复核记录添加索引。
- `server.js`：接入套餐复用设置、订单进度消息、任务详情和卡密复核流程。
- `test/gpt-api-client.test.js`：覆盖上游进度提示解析。
- `test/orbitcard-client.test.js`：覆盖自定义复用次数和首充金额。
- `README.md`、`docs/orbitcard-card-reuse.md`：说明套餐复用配置与卡片筛选规则。
- `progress.md`：追加本轮变更与验证记录。
- 回滚：变更提交后运行 `git revert HEAD` 撤销本轮后端及文档提交。


## 2026-09-23 - Task: 修复并部署任务管理表格操作布局
### What was done
- 保留任务管理中的截图/录像列，修复列宽不足导致的内容竖排和操作按钮换行。
- 提交并推送界面改动后，将对应 HTML/CSS 窄范围部署到 rn；应用无需重启。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check public/admin.js` 和 `git diff --check`：通过。
- rn 运行时检查：任务管理页面与新版 CSS 均 HTTP 200，截图/录像列存在且操作列修复规则已加载；容器保持 healthy。
### Notes
- `public/admin.css`：为任务管理表格设置最小宽度和固定列宽，保持操作按钮横向排列。
- `public/admin.html`：更新 CSS 缓存版本。
- `rn:/root/KC-GPT-PAY/public/admin.css`：部署任务表格列宽和操作样式。
- `rn:/root/KC-GPT-PAY/public/admin.html`：部署新版 CSS 缓存版本。
- `progress.md`：记录部署及验证结果。
- 回滚：在 rn 分别执行 `cp /root/KC-GPT-PAY/public/admin.html.bak-task-table-actions-20260923 /root/KC-GPT-PAY/public/admin.html` 和 `cp /root/KC-GPT-PAY/public/admin.css.bak-task-table-actions-20260923 /root/KC-GPT-PAY/public/admin.css`，再按需清理浏览器缓存。


## 2026-09-24 - Task: 移除任务管理截图录像列
### What was done
- 从任务管理表格移除“截图/录像”列，保留日志和删除操作列。
- 清理该列专用的前端入口、弹窗和渲染代码；服务端截图/录像接口及文件未删除。
- 已备份并部署 rn 的三个后台资源文件，未重启应用；同步更新 JS 缓存版本以避免浏览器继续渲染旧列。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check public/admin.js` 和 `git diff --check`：通过。
- 检索确认任务管理页面不再包含“截图/录像”列及其前端入口引用。
- rn 管理页面、CSS 和 JS 均返回 HTTP 200，列和入口移除检查通过，容器保持 healthy。
### Notes
- `public/admin.html`：移除截图/录像弹窗和任务表格列，并更新 CSS、JS 缓存版本。
- `public/admin.css`：将任务表格调整为 7 列并保留操作按钮横向布局。
- `public/admin.js`：移除截图/录像列渲染、事件入口和前端弹窗逻辑。
- `progress.md`：记录本轮变更与验证结果。
- rn 部署前备份为 `/root/KC-GPT-PAY/public/admin.{html,css,js}.bak-task-table-no-media-20260924`；回滚时分别恢复到对应文件并强制刷新页面。


## 2026-09-23 - Task: 紧凑 Session 管理布局
### What was done
- 收紧 Session 列表的列宽、字号和操作按钮间距，桌面端可直接看到右侧操作。
- 在容器宽度不足时将记录切换为分组信息卡片，把操作按钮放到可见区域，避免横向滑动。
- 为 CSS 和 JS 更新缓存版本，避免浏览器继续使用旧布局资源。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check public/admin.js`：通过。
- `git diff --check`：通过。
- `ReadLints`：当前环境未提供该工具，已使用 JavaScript 语法检查和项目测试替代。
### Notes
- `public/admin.html`：为 Session 表格补充响应式列标识并更新资源缓存版本。
- `public/admin.css`：新增紧凑列宽和窄容器卡片式布局，避免 Session 操作列被横向滚动隐藏。
- `public/admin.js`：为 Session 行和操作区域补充响应式结构，保留复制、导出、续费和删除功能。
- `docs/admin-session-layout.md`：记录 Session 管理界面的自适应使用方式。
- `progress.md`：记录本轮改动与验证结果。
- 回滚：恢复 `ba14735` 版本中的上述三个前端文件，并移除本轮新增文档；本轮未执行提交或线上部署。


## 2026-09-24 - Task: 统一后台列表操作列布局
### What was done
- 收紧 Session 列表的列宽、字号和操作按钮间距，桌面端可直接看到右侧操作。
- 在容器宽度不足时将 Session 记录切换为分组信息卡片，把操作按钮放到可见区域，避免横向滑动。
- 为代理池、地址池、银行卡、Orbitcard、任务、待人工确认和账单列表增加固定操作列，数据横向滚动时操作仍保持可见。
- 为 CSS 和 JS 更新缓存版本，避免浏览器继续使用旧布局资源。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check public/admin.js`：通过。
- `git diff --check`：通过。
- `ReadLints`：当前环境未提供该工具，已使用 JavaScript 语法检查和项目测试替代。
### Notes
- `public/admin.html`：为数据列表补充操作表格标识，并更新 CSS、JS 缓存版本。
- `public/admin.css`：新增紧凑列宽、窄容器卡片式布局和统一固定操作列样式。
- `public/admin.js`：为 Session 行和操作区域补充响应式结构，保留复制、导出、续费和删除功能。
- `docs/admin-session-layout.md`：记录 Session 与其他后台列表的自适应使用方式。
- `progress.md`：记录本轮改动与验证结果。
- 回滚：恢复 `ba14735` 版本中的三个前端文件，并移除本轮新增文档；本轮未执行提交或线上部署。


## 2026-09-23 - Task: 增加 Orbitcard 卡台卡片同步
### What was done
- 在 Orbitcard 用卡记录中增加“同步卡台卡片”操作，读取卡台列表和逐卡详情后登记本地记录。
- 本地记录保存完整卡号、有效期、CVC、持卡人、产品代码、状态和余额；不写入本地 Stripe 银行卡池。
- 已有用卡次数、套餐、充值历史和退役状态在同步时保留；没有敏感卡资料权限的卡片仍会登记并提示详情失败。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check public/admin.js` 和 `node --check server.js`：通过。
- `git diff --check`：通过。
### Notes
- `mysql-store.js`：为 Orbitcard 用卡记录增加卡资料字段，并实现卡台卡片 upsert 同步。
- `server.js`：增加受后台二次认证保护的 `/api/admin/orbitcard/sync` 接口。
- `public/admin.html`：增加同步按钮和卡片资料列。
- `public/admin.js`：调用同步接口并展示完整卡片资料、产品代码和详情失败提示。
- `public/admin.css`：增加 Orbitcard 卡片资料展示样式。
- `docs/orbitcard-card-reuse.md`：说明同步行为和敏感卡资料存储范围。
- `progress.md`：记录本轮变更与验证结果。
- 回滚：恢复本轮修改文件并重启 app；数据库新增字段可保留，不影响旧用卡记录读取。


## 2026-09-28 - Task: 支持同步 Orbitcard 卡手动绑定套餐
### What was done
- 在 Orbitcard 用卡记录的操作列增加套餐选择和绑定功能，支持 Plus、Pro 5x、Pro 20x。
- 绑定时使用当前套餐配置的复用上限；未绑定套餐的同步卡不会参与自动选卡。
- 自动代充选卡改为检查所有已绑定套餐的 ACTIVE 卡，包括复用上限为 1 但尚未使用的卡。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check server.js`、`node --check mysql-store.js` 和 `node --check public/admin.js`：通过。
- `git diff --check`：通过。
- ReadLints：修改文件无诊断。
### Notes
- `mysql-store.js`：新增 Orbitcard 卡套餐绑定更新函数并导出。
- `server.js`：新增受后台二次认证保护的 Orbitcard 卡套餐绑定接口，并让已绑定卡参与所有套餐的首次选卡。
- `public/admin.js`：增加套餐选择、绑定操作和绑定后刷新。
- `public/admin.css`：增加套餐绑定控件样式。
- `public/admin.html`：更新操作说明和前端资源缓存版本。
- `docs/orbitcard-card-reuse.md`：补充同步卡套餐绑定和自动选卡规则。
- `progress.md`：记录本轮变更与验证结果。
- 回滚：恢复上述文件并重启 app；数据库字段和已有卡片套餐值可保留，不影响旧记录读取。


## 2026-09-28 - Task: 部署 Orbitcard 卡套餐绑定到 rn
### What was done
- 将后端同步与套餐绑定接口、Orbitcard 数据库迁移和后台套餐绑定界面部署到 rn。
- 重启 `kc-gpt-pay2-app` 使后端代码和数据库字段迁移生效；MySQL 未重启、未删除数据。
- 重新上传前端静态资源并确认运行容器读取到套餐绑定功能。
### Testing
- rn `kc-gpt-pay2-app`：`healthy / running`。
- rn `kc-gpt-pay2-mysql`：`healthy / running`。
- `orbitcard_card_usage` 已包含 `card_number`、`card_expiry`、`card_cvc`、`card_holder`、`product_code`、`card_last4` 字段。
- rn 前端 CSS/JS HTTP 200，`setOrbitcardCardPlan` marker 存在。
- 未认证访问套餐绑定接口返回 HTTP 401，确认接口已加载且仍受后台认证保护。
- 本地与 rn 后端、前端文件 SHA256 校验一致。
### Notes
- rn 部署文件：`/root/KC-GPT-PAY/server.js`、`/root/KC-GPT-PAY/mysql-store.js`、`/root/KC-GPT-PAY/public/admin.html`、`/root/KC-GPT-PAY/public/admin.css`、`/root/KC-GPT-PAY/public/admin.js`。
- rn 备份：上述文件对应 `/root/KC-GPT-PAY*.bak-orbitcard-plan-binding-20260928-053249`，public 文件位于 `/root/KC-GPT-PAY/public/` 下同名备份。
- 回滚：恢复该时间戳备份后执行 `cd /root/KC-GPT-PAY && docker compose restart app`；数据库新增字段可保留，不影响旧记录读取。


## 2026-09-28 - Task: 支持 Orbitcard 单卡使用上限
### What was done
- 在 Orbitcard 卡片操作中增加单卡使用上限输入，范围为 1-20 次；留空时沿用所选套餐默认上限。
- 单卡上限只更新当前卡，不修改套餐全局配置；已用次数、充值历史和退役状态保持不变。
- 自动选卡继续按卡片自身的 `max_usage_count` 判断，调整为超过已用次数后仍需手动恢复退役卡。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check server.js`、`node --check mysql-store.js` 和 `node --check public/admin.js`：通过。
- `git diff --check`：通过。
- ReadLints：修改文件无诊断。
### Notes
- `server.js`：套餐绑定接口支持可选 `max_usage_count`，并校验 1-20 整数。
- `public/admin.js`：增加单卡上限输入和保存请求。
- `public/admin.css`：增加单卡上限输入框样式。
- `public/admin.html`：更新 Orbitcard 操作说明和资源缓存版本。
- `docs/orbitcard-card-reuse.md`：补充单卡上限规则。
- `progress.md`：记录本轮变更与验证结果。
- 回滚：恢复上述文件并重启 app；数据库中的既有 `max_usage_count` 值可保留，不影响旧记录读取。


## 2026-09-29 - Task: 部署 Orbitcard 单卡使用上限到 rn
### What was done
- 将单卡使用上限输入、保存逻辑和缓存版本部署到 rn 后台。
- 保留已部署的套餐绑定后端接口；未修改任何现有卡片上限，也未触发同步或充值。
- 清理了一次误上传到项目根目录的前端同名文件，最终仅保留 `public/` 下的运行资源。
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check server.js`、`node --check mysql-store.js` 和 `node --check public/admin.js`：通过。
- `git diff --check`：通过；ReadLints：无诊断。
- rn `/admin` 返回 HTTP 200，引用 `20260929-orbitcard-card-limit` 资源版本。
- rn CSS/JS 返回 HTTP 200，单卡上限输入和请求 marker 存在。
- 未认证访问套餐绑定接口返回 HTTP 401。
- rn `kc-gpt-pay2-app` 和 `kc-gpt-pay2-mysql` 均为 `healthy / running`。
- 本地与 rn 部署文件 SHA256 校验一致。
### Notes
- rn 部署文件：`/root/KC-GPT-PAY/server.js`、`/root/KC-GPT-PAY/mysql-store.js`、`/root/KC-GPT-PAY/public/admin.html`、`/root/KC-GPT-PAY/public/admin.css`、`/root/KC-GPT-PAY/public/admin.js`。
- rn 备份：`/root/KC-GPT-PAY*.bak-orbitcard-card-limit-20260928-201539`，public 文件位于 `/root/KC-GPT-PAY/public/` 下同名备份。
- 回滚：恢复上述备份后执行 `cd /root/KC-GPT-PAY && docker compose restart app`；数据库中的 `max_usage_count` 字段可保留，不影响旧记录读取。
