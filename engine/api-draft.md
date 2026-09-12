# 七味 · 引擎 API 草案

状态：草案 v0.1，对应 `schemas/scenes.schema.json` 与 `schemas/state.schema.json` 的 1.0。

一句话：**引擎是一台只读 `scenes.json`、只写 `state` 的结算机。** 前端从不直接读 `scenes.json`，只通过 API 拿到按角色裁剪过的视图。文字、选项、后果、触发器、回声规则全部来自 `scenes.json`；换一幕、改一句话、加一个选项，都不动引擎代码。

## 目录

1. 角色与鉴权
2. 路由
3. 结算流水线
4. 视图裁剪规则（验收标准 1）
5. 数据驱动边界（验收标准 2）
6. 回声
7. 共同命名
8. 单人原型（solo_proxy）
9. 错误码
10. 契约测试

---

## 1. 角色与鉴权

一局有两个角色：`human` 与 `companion`。创建会话时签发两枚角色令牌，各自只能换到自己的视图。

```
Authorization: Bearer <role_token>
```

- 令牌绑定 `(session_id, role)`，服务端存哈希（`players.*.role_token_hash`）。
- `role` 从令牌里解出，**不接受查询参数覆盖**。文档里写 `?role=` 只是为了读起来清楚，实现上以令牌为准。
- `solo_proxy` 模式只签发 `human` 令牌，`companion` 由服务端本地代理驱动。开发时可加 `X-Debug-Peek: companion` 请求头查看灵伴视图，仅在 `NODE_ENV != production` 生效。

## 2. 路由

### 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions` | 建局。body: `{ act_id, mode: "paired"|"solo_proxy", seed?, human: {id, display_name}, companion?: {id, display_name} }`。返回 `{ session_id, tokens: { human, companion? } }`。 |
| GET | `/sessions/:id/view` | 当前角色的完整视图：`HumanStateView` 或 `CompanionStateView`。这是前端刷新页面后唯一需要的接口。 |
| POST | `/sessions/:id/abandon` | 放弃。任一方可调。 |

### 回合

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:id/rounds/:n/submit` | 提交本回合。body: `{ choice_id, message?, trusted_message_id? }`。`n` 必须等于 `round.index`，否则 409。 |
| GET | `/sessions/:id/rounds/:n/result` | 取第 n 回合结算结果（按角色裁剪的 `RoundResult`）。未结算返回 202 与 `{ phase, waiting_for_other }`。 |
| GET | `/sessions/:id/rounds/:n/wait` | 长轮询版 result，最多挂 25 秒。 |
| POST | `/sessions/:id/rounds/:n/advance` | 结算后进入下一回合（把 `phase` 从 `settled` 拨到 `collecting`）。任一方调即可，幂等。 |

双方都提交后引擎自动结算，不需要单独的 settle 接口。`paired` 模式下若一方超过 `round.deadline_at` 未提交，由超时代理补交 `hold`（`by_proxy: true`）。

### 探索（不消耗回合）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:id/inspect` | 查看当前节点的可探索物。body: `{ interactable_id }`。只有 `human` 可调（`companion_view` 没有 interactables）。返回选好 variant 的 `text`，执行 `effects`；若有 `companion_side_effect`，生成一条 `to: [companion]` 的 narration 消息，在**下一次结算**时随成品下发。 |

### 命名

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:id/naming/propose` | body: `{ name }`。写入 `naming.proposals[role]`。 |
| GET | `/sessions/:id/naming` | 看当前候选与谁确认了。双方提案在都提交后才互相可见。 |
| POST | `/sessions/:id/naming/confirm` | body: `{ name }`。确认某个名字（必须等于两个提案之一）。 |
| POST | `/sessions/:id/naming/withdraw` | 撤回自己的确认，回到 `awaiting_confirmation`。 |

### 只读（开发/编辑器用，不给玩家前端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/acts` | 已加载的 scenes 文件列表：`{ act_id, title, scenes_version }`。 |
| POST | `/acts/validate` | 上传一份 `scenes.json`，用 `scenes.schema.json` 校验并跑 lint（段落字数、goto 指向存在、StatePath 可解析、naming 节点有 naming）。 |

## 3. 结算流水线

双方都提交（或代理补交）后，`phase → settling`，按下面顺序执行，全部完成后 `phase → settled`。顺序是硬约束，改顺序等于改规则。

```
1. 校验两份 Submission
   - choice_id 存在于各自视图的 choices 里
   - requires 满足（锁定的选项服务端也拒绝，409）
   - hidden_when 不成立

2. 应用 Choice.effects（先 human 后 companion；两边写同一路径时后者覆盖，lint 会警告）
   - false_vision: true  → legacy.false_vision_encountered = true
   - tags 累加：verification → verification_count+1
                wait_as_action → wait_as_action_count+1
                echo_trusted   → 由 trusted_message_id 是否指向回声决定，不看 tag
   - 双方同回合都带 shared_verification → RoundResult.shared_verification = true，verification_count 再 +1

3. 位移
   - 按 Choice.goto 解析目标节点（条件列表取第一个满足的）
   - distance_intent 非 by_graph 的动作不移动节点，只在下一步里修正 steps

4. 距离
   - steps = 图上最短路（有 position 坐标时用曼哈顿距离，否则 BFS）
   - 应用 TriggerBase.distance_shift（上一回合留下的）
   - level = distance_levels 里 min_steps ≤ steps 的最大项
   - delta = 与上回合 level 比较
   - tremor_direction = 灵伴相对人类的粗略方位（只写入人类视图）

5. on_distance_change（仅当 level 变化）
   - 遍历双方当前节点的 on_distance_change，按 from/to/direction/when 过滤
   - 执行 effects / emit / goto / distance_shift / end_act

6. on_round_settled
   - 遍历双方当前节点的 on_round_settled
   - requires_actions 对照 Submission.choice_kind
   - 第一幕的相遇判定就在这里：
       human ∈ [approach] 且 companion ∈ [approach] → 影子有实体，goto naming 节点
       只有一方 approach → emit「影子碎成决明子」，distance_shift +1
       都不 approach → 什么都不发生

7. shared_phrase
   - legacy.shared_phrase 为 null 时，用 rules.shared_phrase 在本回合双方 message 里找共同表达
   - 命中 → set_if_null

8. 回声
   - 见第 6 节。生成的回声消息 arrived_with_state_delta = false

9. 真灵伴消息落库
   - 双方 message 写入 transcript，kind = chat，to = [对方]，arrived_with_state_delta = true

10. goto 后的 on_enter
   - 若第 3/5/6 步让任一方换了节点，评估新节点的 on_enter
   - on_enter 里的 goto 最多再链一次，防止死循环

11. once 触发器记入 fired_triggers；生成 RoundResult；round.exchanges 若双方都留了话则 +1
```

## 4. 视图裁剪规则（验收标准 1：同一节点向人类与小机返回的内容必须确实不同）

裁剪在一处做：`engine/view.ts` 的 `projectView(state, scenes, role)`。所有路由的响应都经过它，没有旁路。

| 字段 | human 拿到 | companion 拿到 |
|---|---|---|
| `node.view` | `human_view`（选好 variants，choice 附 `locked/locked_reason`） | `companion_view`（选好 variants） |
| 对方的 view | **不存在**（不是空对象，是没有这个键） | **不存在** |
| `distance.level/label/delta` | ✓ | ✓ |
| `distance.steps` | ✗ | ✗ |
| `distance.tremor_direction` | ✓ | ✗ |
| `senses.adjacent_obstacles/sounds` | ✗ | ✓ |
| `minimap` | ✓ | ✗ |
| `position.human` | ✓（只有当前节点 id 与 visited） | ✗ |
| `position.companion` | ✗ | ✓ |
| `round.submissions[对方]` | ✗（结算前后都不给原始提交；结算后只给 RoundResult 里裁剪过的 messages） | ✗ |
| `messages` | `to` 含 human | `to` 含 companion |
| `transcript` / `echoes` / `fired_triggers` | ✗ | ✗ |
| `RoundResult.actions[对方]` | ✗ | ✗ |
| `RoundResult.fired` | ✗ | ✗ |

`human_view` 与 `companion_view` 在 schema 层就是两个不同的对象类型（一个有 stage/minimap/interactables，另一个有 senses/proxy_policy），`additionalProperties: false` 保证作者不可能把对方的字段混进来。

## 5. 数据驱动边界（验收标准 2：不改引擎，只改 scenes.json）

引擎里**允许硬编码**的只有这些：

- `distance_levels` 的映射算法（阈值来自文件）
- 三类触发器的评估顺序
- `Condition.op` 与 `Effect.op` 的语义
- 回声「永远来自过去、永远不与状态变化同抵」这两条公平性约束
- 共同命名的「双人提交 + 确认」流程

引擎里**不允许出现**的：

- 任何节点 id、选项 id、触发器 id 的字面量
- 任何给玩家看的中文文字
- 任何「第 N 次交流后」「金瞳玩家看到东门」之类的剧情判断

检查方式：`grep -nE '[一-鿿]' engine/` 应只命中注释与错误码描述。

## 6. 回声

回声引用历史消息，但**前端只收到成品**。

选取（服务端）：

```
candidates = transcript
  .filter(m => m.speaker == rule.source_speaker && m.kind == "chat")
  .filter(m => round.index - m.round >= rule.min_age_rounds)
if round.exchanges < rule.after_exchanges → 不出
if node 内已出次数 >= rule.max_per_node → 不出
rng(seed, round.index) > rule.probability → 不出
pick: random_past | oldest | most_recent_stale
```

生成：

```
Message {
  id: 新 id,
  round: 当前回合,
  speaker: "temple",                 // 真实来源
  display_speaker: 灵伴的 display_name, // 前端看到的标签（presentation.speaker_label = as_companion 时）
  kind: "echo",
  to: [rule.target],
  text: rule.frame ? render(frame, {echo.text: source.text}) : source.text,
  arrived_with_state_delta: false
}
EchoInstance { message_id, source_message_id, emitted_round, source_round, node }
```

下发前 `projectView` 会把 `speaker` 改写成 `display_speaker` 的值、把 `kind` 改写成 `chat`。前端拿到的回声与真灵伴消息在字段上完全一样，**只差 `arrived_with_state_delta`**——这就是剧情里唯一保留的公平线索。

玩家提交 `trusted_message_id` 指向一条回声时，`echoes[].trusted = true`，`legacy.echo_trusted_count + 1`。前端不知道自己信的是不是回声；它只在后续幕的叙事里知道。

## 7. 共同命名

```
not_started
  └─ propose(human)  ──┐
  └─ propose(companion)┘→ proposing（一方提了）
                          → awaiting_confirmation（两方都提了，互相可见）
       confirm(human, name) + confirm(companion, name) 且 name 相同
                          → confirmed → Effect set legacy.meeting_place_name
       confirm 的 name 不同 → 保持 awaiting_confirmation，各自可 withdraw 后重提
```

- `confirmation = both_confirm` 时两枚确认缺一不可。
- `solo_proxy` 且 `naming.solo_proxy_allowed = true` 时，本地代理在人类 propose 后自动 propose（策略：复述人类的名字或从 proxy_policy 取），并在人类 confirm 后自动 confirm，`confirmed_by` 记为 `["human", "proxy"]`。
- 确认后触发 `naming.on_confirmed` 的 Emit，然后引擎走 naming 节点的 `on_round_settled`（通常 `end_act: true`）。

## 8. 单人原型（solo_proxy）

灵伴由 `engine/proxy.ts` 驱动，每回合读 `CompanionStateView`（**和真实灵伴拿到的完全一样**，不多一个字段），按当前节点 `companion_view.proxy_policy` 出一个 Submission：

- `approach`：选 kind ∈ [move, approach] 中 distance_intent = closer 的第一项
- `hold`：选 kind ∈ [wait, hold]
- `mirror_human`：人类等它就等，人类走它就走（读上一回合 RoundResult.delta，不读人类的提交）
- `scripted`：用 `scripted_choice` / `scripted_message`

代理的留话优先用 `scripted_message` 模板，模板里可用 `{{distance.label}}`、`{{distance.delta}}`、`{{senses.adjacent_obstacles}}`，让它说的都是自己的证据。

后续接模型 API 时，只换 `proxy.ts` 里出 Submission 的那一个函数，输入输出不变。

## 9. 错误码

| HTTP | code | 何时 |
|---|---|---|
| 401 | `bad_token` | 令牌无效或不属于该会话 |
| 403 | `wrong_role` | 用 companion 令牌调 inspect 之类 |
| 404 | `no_session` / `no_node` / `no_choice` | |
| 409 | `round_mismatch` | 提交的 n ≠ round.index |
| 409 | `already_submitted` | 本回合已提交 |
| 409 | `choice_locked` | requires 不满足，body 里带 `locked_reason` |
| 409 | `naming_state` | 命名流程顺序不对 |
| 422 | `message_too_long` | 超过 rules.message_max_length |
| 422 | `scenes_invalid` | /acts/validate 失败，body 是 schema 错误列表 |

## 10. 契约测试

`engine/__tests__/contract.test.ts`，对每个节点跑：

1. **视图分离**：`projectView(state, scenes, "human")` 与 `projectView(state, scenes, "companion")` 的 `node.view` 深比较必须不相等；human 响应 JSON 序列化后不含子串 `"companion_view"`，companion 响应不含 `"human_view"`、`"minimap"`、`"tremor_direction"`。
2. **无泄漏**：任一角色响应里不出现 `source_message_id`、`steps`、`transcript`、`fired`、`role_token_hash`。
3. **回声公平性**：任意 RoundResult 里 `kind=echo`（裁剪前）的消息 `arrived_with_state_delta === false`，且其 `source_round < round`。
4. **数据驱动**：把 `scenes.json` 里所有 `text`/`label` 替换成随机字符串再跑一遍全部用例，结果状态（legacy/position/distance）必须逐字节相同。
5. **遗产字段**：一局跑完，`legacy` 七个字段都被写过至少一次的路径存在（用 solo_proxy 跑三种策略覆盖）。
6. **命名双确认**：paired 模式下只有一方 confirm 时 `legacy.meeting_place_name` 保持 null。

---

## 附：第一幕节点草图（供转写 scenes.json 时对照，不是数据）

```
temple_gate          scene     取金瞳 / 取银瞳 / 先问门后是谁
 ├─ front_hall       scene     无焰灯台 / 六只空碗 / 银镜（金瞳: 假东门 false_vision；银瞳: 指痕）
 │                              on_enter: 小地图首次出现
 ├─ corridor_a..e    corridor  3–5 个节点；echo.enabled after_exchanges=3
 │                              on_distance_change(to=very_near): goto meeting
 ├─ meeting          meeting   approach / hold / retreat
 │                              on_round_settled requires_actions {human:[approach], companion:[approach]} → goto naming
 │                              on_round_settled 单方 approach → distance_shift +1, emit 影子碎裂
 ├─ naming           naming    writes_to legacy.meeting_place_name, both_confirm, solo_proxy_allowed
 └─ ending           ending    on_enter: emit 两句话 + 宝箱题字, end_act
companion 侧：
 companion_start     scene     远处六次落水声（3–5 之间无回响）；北西为墙
 companion_corridor_a..e corridor
 （meeting / naming / ending 共用）
```
