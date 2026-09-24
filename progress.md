

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
### Testing
- `npm test`：3 个测试文件、38 项测试通过。
- `node --check public/admin.js` 和 `git diff --check`：通过。
- 检索确认任务管理页面不再包含“截图/录像”列及其前端入口引用。
### Notes
- `public/admin.html`：移除截图/录像弹窗和任务表格列，并更新 CSS 缓存版本。
- `public/admin.css`：将任务表格调整为 7 列并保留操作按钮横向布局。
- `public/admin.js`：移除截图/录像列渲染、事件入口和前端弹窗逻辑。
- `progress.md`：记录本轮变更与验证结果。
- 回滚：恢复以上三个文件本轮修改前的版本；若已部署，则使用部署前备份恢复 rn 对应文件。
