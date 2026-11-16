# dsh-efficiency

给 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) 装一套"少说废话、少跑冤枉路"的默认行为。不需要改 dsh 源码，全部通过它公开的钩子实现。

装上之后，同一个模型做同一件事，输出 token 大约少两成，墙钟时间也少两成左右。下面把每个开关的原理、我实测的数字、以及测不准的地方都写清楚。

## 目录

- [它做了什么](#它做了什么)
- [原理与实测](#原理与实测)
- [安装](#安装)
- [配置](#配置)
- [兼容性](#兼容性)
- [局限](#局限)
- [许可](#许可)

## 它做了什么

四个独立的开关，可以只开其中几个：

| 开关 | 作用 | 默认 |
|---|---|---|
| `ladder` | 一个回合里第一个请求用深档思考，之后每一步降到浅档 | 开（medium → low） |
| `scanTools` | 拒绝没有深度限制的递归 shell 扫描，并告诉模型该用哪个工具 | 开（bash、pwsh） |
| `thresholds` | 回合步数到了阈值就在上下文里报一句，催它收口 | 开（12、24 步） |
| `applyEdits` | 额外注册一个 `apply_edits` 工具：多处文字替换 + 一次验证，合成一步 | 关 |

## 原理与实测

### 一、按步降档

**原理。** dsh 的 agent 循环把"一步"当成一次独立请求：模型想、调工具、拿结果，然后再来一次。同一个回合里第 1 步要规划，第 2 步起基本是照做。模型并不知道自己处在第几步，所以它每一步都按同样的思考深度去写。

eco 这类模型的表现和思考档关系很大。同一路由上按调用统计输出 token（1204 次真实调用，`deepseek-v4.1-flash-eco`）：

| 思考档 | 每次调用输出 token | 备注 |
|---|---|---|
| high | 2,496 | 默认档，最贵 |
| minimal | 1,209 | 比 medium 贵 1.75 倍 |
| low | 1,152 | |
| off | 799 | 路由没有真的关掉思考 |
| medium | 689 | 该路由下最便宜的被兑现档位 |

所以在 dsh 里"降档"不是把每步都压到最低，而是**把贵的档只留给第一步**。

**实现要点。** 0.2.2 把 `agent/request` 上的模型/思考覆盖标成了 deprecated，运行时会直接报错：

```
agent/request proposed reasoning effort "high" after step preparation fixed "adapter default";
use agent.model.select() before step preparation
```

因此必须在**步准备之前**用 `agent.model.select()` 写入。插件挂了两个钩子：

- `agent/inbox/claimed`：接单时写第 1 步的档位（这个时机早于循环读取 selection）
- `agent/pre-step`：`await next()` 之后写下一步的档位

另外要做所有权判断，否则会跟用户手动选的档位打架：如果当前档既不是本插件上次写的，也不是第一眼看到的那档，就认为有人接管了，这一步让出去，下一步再按梯子走。

**实测。** 任务：`tmp-bench` 里 4 个失败测试，要求定位根因、只改 `src/`、跑到全绿。路由 `open-design/deepseek-v4.1-flash-eco`，`dsh --profile headless`，跑前重置仓库。

| 配置 | 墙钟 | 输出 token | 步数 | 结果 |
|---|---|---|---|---|
| 不降档（每步都是默认档） | 152 s / 141 s | 8,543 / 8,820 | 27 / 22 | 6/6、6/6 |
| 降档（medium → low） | 110 s / 126 s | 6,265 / 7,372 | 21 / 22 | 6/6、6/6 |

合计：墙钟 −19%，输出 token −21%，两步都通过。样本各 2 次，方差不小（同一臂内部就有 152 s 和 141 s 的差别），所以把它当作"约两成"的量级，不要当成精确值。

### 二、拒绝无界递归扫描

**原理。** 模型想找文件时最爱写 `Get-ChildItem -Path . -Recurse`。在 dsh 仓库里这一条会顺着 `node_modules/@deepseek-ai/.../node_modules/...` 一路往下，我抓到的一次真实调用从 12.6 秒一直卡到 132.6 秒——**单条命令 120 秒**，后面还跟着几次换写法的重试。

提示词层面治不住它：模型即使被告知"用 glob"，也还是会写 `-Recurse` 再用 `Where-Object` 过滤，而下拉过滤是先遍历再过滤，代价已经付了。所以改成机械拦截。

**实现。** 在 `tools/execute` 上判断命令文本，命中"有递归、没深度限制"就返回一条错误结果，而不是抛异常：

| 命令族 | 递归特征 | 放行条件 |
|---|---|---|
| PowerShell | `Get-ChildItem` / `gci` / `dir` / `ls` 带 `-Recurse` 或 `-r` | 带 `-Depth` |
| POSIX | `find` | 带 `-maxdepth` 或 `-depth` |

拒绝结果按 dsh 的 `ToolFailure` 形状返回（`isError: true` + `code: SHELL_SCAN_REFUSED`），所以模型看到的是普通工具失败，会自己换招。提示里还会先问"这个 agent 到底有哪些工具"，只建议它真有的那个（有 `glob` 就说用 glob，有 `grep` 就说用 grep，都没有才说加深度限制）。

**实测。** 修仓库题里有扫描需求的那类任务，拦截生效后模型改用 `git ls-files` / `git grep` / `-Depth 2`：

| 现象 | 加插件前 | 加插件后 |
|---|---|---|
| 最长单次工具调用 | 120 s（`pwsh -Recurse` 卡死） | 无递归调用 |
| 是否被拦 | — | 一次运行里 2 次拒绝，之后全部走有界扫描 |

这一项我没法给出可信的百分比：它只在"模型恰好想递归扫"的任务上才有差别，而这类任务的墙钟方差本来就有两三倍。

### 三、长回合步数提示

**原理。** 模型判断"够了"的依据只有上下文里有没有答案。它没有"我已经查了 15 步"这个信号，于是会反复用不同写法确认同一件事。

插件在 `agent/pre-step` 里按步数注入一条标记为 notice 的用户消息（`source: { kind: 'efficiency', form: 'notice' }`，UI 上不会被误认为你说的话）：

| 步数 | 文本 |
|---|---|
| 12 | 这个回合已经走了 12 步。用手上的证据回答，或者说明还缺什么、为什么它挡住答案；再查一遍同样的东西不会改变结论。 |
| 24 | 这个回合走了 24 步还没有给出答案。现在给出证据支持的答案，并在同一条回复里说明剩下的未知。 |

**实测。** 阈值设为 12/24 后跑 4 次同类任务：

| 指标 | 结果 |
|---|---|
| 步数 | 12 / 9 / 9 / 2 |
| 提示触发 | 1 次（那次正好 12 步） |
| 墙钟 | 112 / 123 / 76 / 31 s |

诚实结论：**它主要是给长回合封顶，不是在常见长度上加速。** 因为这 4 次大多落在 9–11 步，没到阈值。把阈值调到 6 或 8 会更频繁地触发，但我没验证过那样会不会让模型在证据不足时提前收口——所以我默认放在 12/24。

### 四、`apply_edits`（可选，默认关）

模型改多个文件时，一步一个 `edit` 要花好几轮往返：每轮都要重读整个上下文。这个工具让一次调用完成"多处替换 + 跑一次验证"：

```json
{
  "edits": [
    { "file_path": "src/money.js", "old_string": "…", "new_string": "…" },
    { "file_path": "src/pricing.js", "old_string": "…", "new_string": "…" }
  ],
  "verify": "node --test tests/"
}
```

这一项我**没有单独测过**提升幅度（改多个文件的题目本身就少），所以默认关闭，想用再开。

## 安装

前提：dsh 版本见下面的兼容表。

1. 把 `dsh-plugin-efficiency` 放到一个目录，例如 `~/dsh-plugins/dsh-efficiency`。
2. 在 profile 的 `package.json` 里加依赖：

```json
{ "dependencies": { "dsh-plugin-efficiency": "link:~/dsh-plugins/dsh-efficiency" } }
```

3. 在 profile 的 `cordis.patch.yml` 里加一行（**`- insert:` 这层不能省**，裸写 entry 会报 `patch: entry "…" not found`）：

```yaml
- insert:
    - id: efficiency
      name: 'dsh-plugin-efficiency'
      config:
        ladder:
          - fromStep: 1
            effort: medium
          - fromStep: 2
            effort: low
        thresholds: [12, 24]
```

4. 装依赖并启动：

```sh
cd ~/.dsh/profiles/web && pnpm install
dsh --profile web
```

验证是否挂上：回合里 `request/header` 的 `reasoningEffort` 应该是先 `medium`、之后 `low`；或者跑一次 `Get-ChildItem -Recurse` 看是否被拒。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ladder` | `{ fromStep, effort }[]` | `[{1, medium}, {2, low}]` | 第 N 步起用哪个档。必须严格递增，档位必须是路由支持的 |
| `thresholds` | `number[]` | `[12, 24]` | 步数提示的触发点；`[]` 关闭 |
| `scanTools` | `string[]` | `['bash', 'pwsh']` | 参与扫描拦截的工具名 |
| `skipSubagents` | `boolean` | `true` | 子代理不降档（它们通常本来就是短任务） |
| `applyEdits` | `boolean` | `false` | 是否注册 `apply_edits` 工具 |
| `leanPrompt` | `string` | 空 | 非空时整段替换系统提示（实验性，行为变化最大） |
| `personaAppend` | `string` | 见源码 | 在 persona 后追加一段；空字符串则不追加 |

档位只在**路由声明了**的档位里写，否则跳过——`llm.resolveModelInfo()` 查不到就什么都不做，不会发出非法请求。

## 兼容性

| dsh 版本 | 状态 | 说明 |
|---|---|---|
| `0.2.2-rc.1` 及以后 | 已验证 | 用 `agent.model.select()` 写入档位 |
| `0.2.1-rc.2` ~ `0.2.1` | 部分可用 | 没有 `agent.model.select()`，降档会跳过并打一条 warn；扫描拦截和步数提示正常 |

`agent/model` 是 0.2.2 才有的接口，旧版本上插件会自动跳过降档而不是让 profile 起不来。`engines.dsh` 写的是 `>=0.2.2-rc.1 <0.3.0-0`，因为低于它的版本没有这条写入路径。

## 局限

- 降档依赖"第一步需要深思考"这个假设。做纯查询类任务时，第一步也不贵，收益会缩到没影。
- 扫描拦截只看命令文本，多层封装（`bash -c "bash -c '…'"`）和变量拼接后 `eval` 抓不到。
- 步数提示用的是阈值，不是"证据足够"的判断。它拦不住方向错的回合，只能让长回合早点收口。
- 所有数字都是单机、单路由、`deepseek-v4.1-flash-eco`、Windows 上测的，样本 2–4 次。换成其他模型或 Linux，绝对值会变；我给出的是"哪个杠杆值得动"，不是基准分数。

## 许可

MIT
