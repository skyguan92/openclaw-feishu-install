# Lark Integration Issues / 修复清单

这份清单只跟踪 `openclaw-feishu-install` 里和 Feishu / Lark 对接直接相关的问题。
目标不是复述 support case，而是把重复出现的故障模式沉淀成可排期、可验证的修复项。

## 证据来源

- `2026-03-12 / 6c7bff54-b24a-4785-9114-b7bc72993133`
- `2026-03-10 / yvonnezhang-macbook-openclaw-feishu`
- `2026-03-09 / wayne-mac-openclaw-feishu`
- `2026-03-09 / longchanggui-windows-openclaw-feishu`
- `2026-03-09 / dream-windows-openclaw-feishu`

## 当前优先级

| 状态 | 优先级 | 主题 | 结论 |
| --- | --- | --- | --- |
| Open | P0 | `post_publish_message` receive id 解析错误 | 直接影响首条私信送达，属于当前最该修的 Lark 回归点 |
| Open | P1 | 发布成功但机器人不可见 | 主要卡在可用范围未配置，客户侧感知强 |
| Open | P1 | `pairing` 链路提示不足 | 首条私信送达后仍可能无法对话，容易误判“已完成安装” |
| Open | P1 | 发布页 UI 文案漂移 | Playwright 依赖精确文案，发布阶段容易再次失效 |
| Monitor | P2 | Feishu / Lark 命名与域名混用 | 不一定阻塞功能，但会增加排障成本 |

## Issue 1: `post_publish_message` 把 `ou_...` 识别错成不可直发的 `user_id`

- 状态：Open
- 优先级：P0
- 相关文件：`src/automation/post-publish-message.js`

### 现象

- 发布阶段成功，但发送首条私信失败。
- 日志里常见：
  - `contact/v3/scopes 失败: HTTP 400`
  - `user_id 直发失败: HTTP 400`
  - Lark `/im/v1/messages?receive_id_type=user_id` 返回 `id not exist`

### 根因

- 当前 `extractScopeMembers()` 只会从对象字段里提取 `open_id` / `user_id`。
- 某些 Lark 租户上，`/contact/v3/scopes` 成功返回的是 `data.user_ids = ["ou_..."]`。
- 这里的 `ou_...` 实际应当按 `open_id` 使用，但当前逻辑没有兼容这种结构。
- 解析失败后，流程会回退到网页登录上下文里的数字型 `userId`，再按 `receive_id_type=user_id` 直发，最终 400。

### 手工绕过方式

1. 先调 `/open-apis/contact/v3/scopes`
2. 取返回中的 `ou_...`
3. 按 `receive_id_type=open_id` 调 `/open-apis/im/v1/messages`

### 修复清单

- [ ] `extractScopeMembers()` 支持从 `data.user_ids[]` 提取候选值
- [ ] 如果候选值前缀是 `ou_`，优先映射为 `openId`
- [ ] `resolveScopedMessageTarget()` 不再默认把网页登录上下文 `userId` 当成可直发的 IM `user_id`
- [ ] 失败时把 `/contact/v3/scopes` 的原始 payload 写入 debug 日志或 artifact
- [ ] 增加单测，覆盖以下 payload 变体：
  - [ ] `items[].open_id`
  - [ ] `items[].user_id`
  - [ ] `data.user_ids = ["ou_..."]`
  - [ ] 单元素列表自动兜底
- [ ] README 增加 troubleshooting，说明首条私信失败时先检查 `receive_id_type`

### 完成标准

- 发布后自动发送首条私信时，遇到 `data.user_ids=["ou_..."]` 能直接成功
- 日志中明确记录最终使用的 `receive_id_type`

## Issue 2: 发布成功不等于用户可见，`可用范围` 仍是人工断点

- 状态：Open
- 优先级：P1
- 相关文件：`src/automation/publish.js`, `README.md`

### 现象

- UI 已显示 published
- 但其他成员在 Lark / Feishu 内搜不到机器人

### 根因

- “版本管理与发布 -> 可用范围” 还没自动化
- 当前流程只会在日志里提醒，不会把它提升成阻塞性验收条件

### 修复清单

- [ ] 在 publish 成功后输出更强提示，区分：
  - [ ] 个人自用机器人
  - [ ] 企业内其他成员可见机器人
- [ ] 如果用户选择多人可见场景，把“可用范围已配置”列为显式待办
- [ ] 调研可用范围是否能通过 API 或稳定 DOM 自动化
- [ ] 若暂时不能自动化，在最终 phase 状态里把它标成 manual step，而不是普通提示
- [ ] README 单独增加“发布后搜不到机器人”的排障小节

### 完成标准

- 不再把 `published` 单独当作“客户侧已经可见”的充分条件
- 操作人能明确知道还差的是“可用范围”而不是 OpenClaw 本身异常

## Issue 3: `dmPolicy=pairing` 下，首条私信送达后仍可能不会回复

- 状态：Open
- 优先级：P1
- 相关文件：`src/config/pairing.js`, `README.md`

### 现象

- 机器人已经给用户发了第一条私信
- 但用户回复后仍然没有对话结果
- support 侧常误以为安装已完成

### 根因

- 默认仍是 `dmPolicy=pairing`
- 当前安装器虽然会发第一条私信，但没有把“下一步需要用户回复一次，再执行 pairing approve”提示得足够明确

### 修复清单

- [ ] 在 `post_publish_message` 成功后，明确提示下一步是“让用户回复任意一句”
- [ ] 如果未启用 `skip first DM pairing`，UI 应显示 pairing 是默认行为
- [ ] 为 support 模式补一段更直接的日志文案：
  - [ ] “首条私信已送达”
  - [ ] “仍需用户回一句话触发 pairing request”
  - [ ] “随后执行 `openclaw pairing approve feishu <code>`”
- [ ] README 单独解释“首条私信成功”和“机器人已可对话”不是同一检查点

### 完成标准

- 安装器输出里清楚区分：
  - [ ] bot 已被用户看到
  - [ ] bot 已完成 pairing，可开始对话

## Issue 4: 发布页选择器仍然过度依赖文案，Lark 后台改字就会炸

- 状态：Open
- 优先级：P1
- 相关文件：`src/automation/publish.js`, `src/automation/selectors.js`

### 现象

- publish 阶段 timeout
- 常见原因是 placeholder 或按钮文案变化

### 已知案例

- 更新日志 placeholder 从“此内容将于应用的更新日志中显示”变成“该内容将展示在应用的更新日志中”

### 修复清单

- [ ] 减少对单一中文文案的强依赖，优先用结构化定位
- [ ] 关键按钮保留多候选文案 fallback
- [ ] 失败时输出当前页面可见按钮/placeholder 列表，方便定位 UI 漂移
- [ ] 增加 publish 回归脚本，覆盖“已发布版本 + 强制新建版本”路径

### 完成标准

- UI 文案轻微变化时不再直接导致 publish 失败
- 失败时日志能给出足够的页面上下文，而不是只报 timeout

## Issue 5: Feishu / Lark 命名和域名混用，增加排障歧义

- 状态：Monitor
- 优先级：P2
- 相关文件：`src/config/feishu-domain.js`, `README.md`

### 现象

- 用户说的是 Lark 国际版，但代码、日志、配置项大多仍叫 `feishu`
- support 过程中容易把“品牌命名差异”误判成“接口差异”

### 修复清单

- [ ] 对用户可见文案统一写成 `Feishu / Lark`
- [ ] 所有 Open API / Console URL 统一经由 `feishu-domain` 配置构建
- [ ] README 增加一段说明：代码内部继续沿用 `feishu` 命名，但目标产品可能是 Lark 海外版

### 完成标准

- 排障日志里能明确区分“命名兼容”与“真实接口问题”

## 已修复但需要持续观察

### `events` 阶段确认按钮文案漂移

- 状态：Monitor
- 当前实现已经兼容 “添加” / “确认添加” 两种按钮文案
- 相关文件：`src/automation/events-subscription.js`
- 后续仍要继续避免把事件配置逻辑绑死在单一文本上

### `publish` 强制新建版本支持

- 状态：Monitor
- 当前支持 `forceNewVersion=true`，有助于断点续跑和重新验收发布链路
- 相关文件：`src/automation/publish.js`

## 建议修复顺序

1. 先修 Issue 1，恢复首条私信自动送达
2. 再补 Issue 3，避免“能看到 bot 但不能对话”的误判
3. 再处理 Issue 2，把“可用范围”从提示升级为正式验收项
4. 最后做 Issue 4 和 Issue 5，降低后续维护成本
