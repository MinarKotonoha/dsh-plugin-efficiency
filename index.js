/**
 * Agent efficiency guards.
 *
 * Three behaviors that keep a turn short, delivered entirely through public
 * harness hooks so a profile can mount them without patching DeepSeek Harness:
 *
 * - `systemPrompt.section()` with `complete: true` replaces the whole system
 *   prompt with the configured `leanPrompt`, which drops the tool guidance
 *   sections a short-prompt experiment wants to price.
 * - `agent/inbox/claimed` and `agent/pre-step` order a per-step reasoning
 *   effort through `agent.model.select()`, so the opening plan thinks at full
 *   depth and later execution steps cost less.
 * - `tools/execute` refuses a recursive shell scan with no depth bound, which
 *   otherwise descends into dependency trees and blocks a turn for minutes.
 * - `agent/pre-step` states a turn's step count at configured thresholds, so a
 *   re-checking turn delivers the answer its evidence already supports.
 */

import fs from 'node:fs'

/** Services this plugin reads: prompt sections, tool availability, and routes. */
export const inject = ['systemPrompt', 'tools']

/** Identifies every notice this plugin contributes to a turn. */
const NOTICE_KIND = 'efficiency'

/**
 * Collapse whitespace and cap a command preview.
 * @param command - the shell command.
 * @returns the quoted preview.
 */
function quoted(command) {
  const collapsed = command.replace(/\s+/g, ' ').trim()
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 119)}\u2026`
}

/**
 * Sort and validate the configured ladder.
 * @param ladder - configured rungs.
 * @returns ascending rungs.
 */
function resolveLadder(ladder) {
  if (!Array.isArray(ladder) || ladder.length === 0) throw new Error('efficiency: ladder must name at least one rung')
  const rungs = ladder.map(rung => {
    const fromStep = Number(rung === undefined || rung === null ? undefined : rung.fromStep)
    const effort = String(rung === undefined || rung === null ? '' : rung.effort ?? '').trim()
    if (!Number.isInteger(fromStep) || fromStep < 1) throw new Error(`efficiency: ladder rung fromStep must be an integer greater than or equal to 1, got ${fromStep}`)
    if (effort === '') throw new Error(`efficiency: ladder rung ${fromStep} names an empty effort`)
    return { fromStep, effort }
  })
  return rungs.sort((left, right) => left.fromStep - right.fromStep)
}

/**
 * Read the effort for one step.
 * @param ladder - ascending rungs.
 * @param step - the one-based step.
 * @returns the rung effort, or undefined below the first rung.
 */
function effortForStep(ladder, step) {
  let effort
  for (const rung of ladder) if (step >= rung.fromStep) effort = rung.effort
  return effort
}

/**
 * Sort and validate the configured thresholds.
 * @param thresholds - configured step numbers.
 * @returns ascending thresholds.
 */
function resolveThresholds(thresholds) {
  if (!Array.isArray(thresholds) || thresholds.length === 0) throw new Error('efficiency: thresholds must name at least one step')
  const steps = thresholds.map(value => Number(value))
  for (const step of steps) {
    if (!Number.isInteger(step) || step <= 1) throw new Error(`efficiency: threshold must be an integer greater than 1, got ${step}`)
  }
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index] <= steps[index - 1]) throw new Error(`efficiency: thresholds must ascend, got ${steps[index]} after ${steps[index - 1]}`)
  }
  return steps
}

/** A recursion marker paired with the depth bound that makes a scan safe. */
const RULES = [
  { recursion: /\b(?:get-childitem|gci|dir|ls)\b[^|;]*\s(?:-recurse|-r)\b/i, depthBound: /\s-depth\b/i },
  { recursion: /(?:^|[;&|]\s*)\bfind\s/i, depthBound: /\s-(?:maxdepth|depth)\b/i },
]

/**
 * Read a `command` string from tool arguments.
 * @param args - the dispatched arguments.
 * @returns the command text, or undefined.
 */
function commandOf(args) {
  if (typeof args !== 'object' || args === null) return undefined
  const command = args.command
  return typeof command === 'string' ? command : undefined
}

/**
 * Name the discovery tools this agent actually has.
 * @param ctx - the plugin context.
 * @param agent - the agent that dispatched the call.
 * @returns the alternatives sentence.
 */
function discoveryAlternatives(ctx, agent) {
  const tools = ctx.tools
  if (tools === undefined) return 'Name one directory and bound the scan with a depth limit.'
  const glob = tools.get('glob', agent) !== undefined
  const grep = tools.get('grep', agent) !== undefined
  if (glob && grep) return 'Use glob for paths or grep for file contents instead.'
  if (glob) return 'Use glob for paths instead.'
  if (grep) return 'Use grep for file contents instead.'
  return 'Name one directory and bound the scan with a depth limit.'
}

/**
 * Build the refusal result for one screened call.
 * @param ctx - the plugin context.
 * @param agent - the dispatching agent.
 * @param command - the shell command.
 * @returns the model-facing refusal.
 */
function refusal(ctx, agent, command) {
  const message = `refused a recursive scan: \`${quoted(command)}\` walks every subdirectory, including dependency trees such as \`node_modules\`, which can block for minutes. ${discoveryAlternatives(ctx, agent)} A shell scan stays allowed when it names one directory and bounds its depth (\`-Depth N\` in pwsh, \`-maxdepth N\` in find).`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'EfficiencyScanRefusedError', code: 'SHELL_SCAN_REFUSED' } },
  }
}

/**
 * Collapse a command's output to a head and tail excerpt.
 * @param text - raw command output.
 * @returns the excerpt.
 */
function clipOutput (text) {
  const LIMIT = 2000
  if (text.length <= LIMIT) return text
  const head = text.slice(0, 1200)
  const tail = text.slice(-600)
  return `${head}\n… ${text.length - 1800} characters omitted …\n${tail}`
}

/**
 * Read an execution result's model-facing text.
 * @param result - a settled execution result.
 * @returns the concatenated text blocks.
 */
function resultTextOf (result) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/**
 * Read a structured command's exit code.
 * @param value - the canonical tool value.
 * @returns the exit code when the value carries one.
 */
function exitCodeOf (value) {
  if (typeof value !== 'object' || value === null) return undefined
  const code = Reflect.get(value, 'exitCode')
  return typeof code === 'number' ? code : undefined
}

/**
 * Build the `apply_edits` definition: several literal edits plus one check in
 * a single call, so a fix costs one step instead of one step per file.
 * @param ctx - the plugin context.
 * @returns the tool definition.
 */
function applyEditsTool (ctx) {
  return {
    name: 'apply_edits',
    description: 'Apply several literal edits to files, then optionally run the verification command, in one call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['edits'],
      properties: {
        edits: {
          type: 'array',
          description: 'Replacements applied in order; each quotes text the file contains now.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['file_path', 'old_string', 'new_string'],
            properties: {
              file_path: { type: 'string', description: 'Path to edit.' },
              old_string: { type: 'string', description: 'Literal text to replace.' },
              new_string: { type: 'string', description: 'Literal replacement; an empty string deletes the match.' },
              replace_all: { type: 'boolean', description: 'Replace every match instead of requiring exactly one.' },
            },
          },
        },
        verify: { type: 'string', description: 'Command run after the edits land, such as `npm test`; omit it when the change needs no check.' },
        workdir: { type: 'string', description: 'Working directory for `verify`; defaults to the session directory.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['edits'],
        properties: {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file_path', 'applied', 'message'],
              properties: {
                file_path: { type: 'string' },
                applied: { type: 'boolean' },
                message: { type: 'string' },
              },
            },
          },
          verify: {
            type: 'object',
            additionalProperties: false,
            required: ['command', 'output'],
            properties: {
              command: { type: 'string' },
              exit_code: { type: 'number' },
              output: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        const applied = value.edits.filter(edit => edit.applied).length
        const lines = [`Applied ${applied} of ${value.edits.length} edits.`]
        for (const edit of value.edits) if (!edit.applied) lines.push(`${edit.file_path}: ${edit.message}`)
        if (value.verify !== undefined) {
          const code = value.verify.exit_code === undefined ? '' : ` [exit code: ${value.verify.exit_code}]`
          lines.push(`Verification ${value.verify.command} finished${code}.`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => ({
        path: value.edits.map(edit => edit.file_path).join(', '),
        applied: value.edits.filter(edit => edit.applied).length,
      }),
    },
    async execute (args, exec) {
      if (args.edits.length === 0) throw new Error('apply_edits needs at least one edit')
      const settledEdits = []
      for (const [index, edit] of args.edits.entries()) {
        const batch = await ctx.tools.execute({
          calls: [{
            type: 'tool-call',
            id: `apply-edits-${index}`,
            name: 'edit',
            arguments: JSON.stringify({ file_path: edit.file_path, old_string: edit.old_string, new_string: edit.new_string, ...edit.replace_all === undefined ? {} : { replace_all: edit.replace_all } }),
          }],
          signal: exec.signal,
          ...exec.agent === undefined ? {} : { agent: exec.agent },
        })
        const settled = batch.results[0]
        settledEdits.push({
          file_path: edit.file_path,
          applied: settled !== undefined && !settled.result.isError,
          message: settled === undefined ? 'the edit produced no result' : resultTextOf(settled.result),
        })
      }
      if (settledEdits.every(edit => !edit.applied)) throw new Error(`apply_edits applied none of ${settledEdits.length} edits: ${settledEdits[0].message}`)
      const value = { edits: settledEdits }
      if (typeof args.verify === 'string' && args.verify.trim().length > 0) {
        const shell = ctx.tools.executable('bash', exec.agent) !== undefined ? 'bash' : 'pwsh'
        const batch = await ctx.tools.execute({
          calls: [{
            type: 'tool-call',
            id: 'apply-edits-verify',
            name: shell,
            arguments: JSON.stringify({ command: args.verify, description: 'verify the edits', ...args.workdir === undefined ? {} : { workdir: args.workdir } }),
          }],
          signal: exec.signal,
          ...exec.agent === undefined ? {} : { agent: exec.agent },
        })
        const settled = batch.results[0]
        const canonical = settled !== undefined && settled.result.isError === false ? settled.result.value : undefined
        const exitCode = exitCodeOf(canonical)
        const output = clipOutput(settled === undefined ? 'the verification produced no result' : resultTextOf(settled.result))
        const applied = settledEdits.filter(edit => edit.applied).length
        if (settled === undefined || settled.result.isError === true || (exitCode !== undefined && exitCode !== 0)) {
          throw new Error(`apply_edits applied ${applied} of ${settledEdits.length} edits, and the verification command \`${args.verify}\` failed${exitCode === undefined ? '' : ` with exit code ${exitCode}`}: ${output}`)
        }
        value.verify = { command: args.verify, ...exitCode === undefined ? {} : { exit_code: exitCode }, output }
      }
      return value
    },
  }
}

/**
 * Mount the three guards.
 * @param ctx - the plugin context.
 * @param config - the row configuration.
 */
export function apply(ctx, config = {}) {
  const ladder = resolveLadder(config.ladder)
  const thresholds = resolveThresholds(config.thresholds ?? [])
  const scanTools = new Set(Array.isArray(config.scanTools) ? config.scanTools : ['bash', 'pwsh'])
  const skipSubagents = config.skipSubagents !== false
  const states = new WeakMap()
  /** Warn once when this harness has no per-step selection seam. */
  let warnedUnsupported = false
  const warnUnsupported = () => {
    if (warnedUnsupported) return
    warnedUnsupported = true
    if (typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn('efficiency: this dsh version exposes no agent.model.select(); the reasoning ladder stays off')
    }
  }
  const advertised = new Map()
  const lean = typeof config.leanPrompt === 'string' ? config.leanPrompt.trim() : ''
  if (lean.length > 0) {
    ctx.systemPrompt.section({ name: 'efficiency-lean', order: 0, text: lean, complete: true })
  }

  // A short paragraph after the deployment persona: decide before acting and
  // batch independent edits, which is what starts a turn at six to eight steps
  // instead of twelve. `personaAppend: ''` keeps the prompt untouched.
  const persona = typeof config.personaAppend === 'string' ? config.personaAppend.trim() : 'Decide and act: state the next action and why in one short note, then take it. Inspect only what the next action needs. Independent work belongs in one step: apply every change a task needs in the same step, then verify once.'
  if (persona.length > 0 && ctx.systemPrompt !== undefined) {
    ctx.systemPrompt.section({ name: 'efficiency-persona', order: 1, text: persona })
  }

  if (config.applyEdits !== false && ctx.tools !== undefined) {
    ctx.tools.register(applyEditsTool(ctx))
  }

  /**
   * Read the per-agent ladder state.
   * @param agent - the requesting agent.
   * @returns the state, where `owned` is the effort this row ordered last.
   */
  const stateOf = agent => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { seeded: false, owned: undefined }
      states.set(agent, state)
    }
    return state
  }

  /**
   * Read the effort ids a route advertises and cache them, so a later step can
   * order its rung synchronously before the loop reads the selection.
   * @param provider - the provider id.
   * @param model - the model id.
   */
  const warmEfforts = async (provider, model) => {
    const route = `${provider}/${model}`
    if (advertised.has(route)) return
    advertised.set(route, 'pending')
    const llm = ctx.get('llm')
    if (llm === undefined) {
      advertised.set(route, undefined)
      return
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const reasoning = info === undefined ? undefined : info.reasoning
      advertised.set(route, reasoning === undefined ? undefined : new Set(reasoning.efforts.map(effort => String(effort.id))))
    } catch (error) {
      ctx.logger.warn(`efficiency: route "${route}" could not be resolved: ${String(error)}`)
      advertised.set(route, undefined)
    }
  }

  /**
   * Order the rung for one step through the selection the harness consumes at
   * the start of that step. An effort this row did not order last belongs to
   * someone else (a picker, a preset), so it is adopted instead of overwritten.
   * @param agent - the agent whose next step follows the ladder.
   * @param step - the step about to be prepared.
   */
  const orderRung = (agent, step) => {
    // `agent.model` arrived in 0.2.2; older harnesses expose no selection seam,
    // and a profile that mounts this plugin there must still boot.
    if (typeof agent.model?.select !== 'function') {
      warnUnsupported()
      return
    }
    if (skipSubagents && agent.session.header.delegationDepth > 0) return
    const target = effortForStep(ladder, step)
    if (target === undefined) return
    const current = agent.model.current()
    if (current === undefined) return
    const now = current.reasoningEffort === undefined ? undefined : String(current.reasoningEffort)
    const state = stateOf(agent)
    if (!state.seeded) {
      state.seeded = true
      state.owned = now
    }
    if (now !== state.owned) {
      state.owned = now
      return
    }
    if (now === target) return
    const ids = advertised.get(`${current.provider}/${current.model}`)
    if (ids === 'pending') return
    if (ids === undefined) {
      void warmEfforts(current.provider, current.model)
      return
    }
    if (!ids.has(target)) return
    agent.model.select({ provider: current.provider, model: current.model, reasoningEffort: target })
    state.owned = target
  }

  /**
   * Cache the route's advertised efforts before the first step is admitted.
   * @param agent - the agent whose route to warm.
   */
  const warmRoute = agent => {
    if (typeof agent.model?.current !== 'function') return
    const current = agent.model.current()
    if (current === undefined) return
    void warmEfforts(current.provider, current.model)
  }

  ctx.on('agent/created', ({ agent }) => { warmRoute(agent) })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') warmRoute(agent)
  })

  ctx.on('agent/inbox/claimed', ({ agent }) => { orderRung(agent, 1) })

  ctx.on('tools/execute', async (execution, next) => {
    const command = commandOf(execution.arguments)
    if (command === undefined || !scanTools.has(execution.name)) return next()
    const hit = RULES.some(rule => rule.recursion.test(command) && !rule.depthBound.test(command))
    if (!hit) return next()
    return refusal(ctx, execution.agent, command)
  })

  ctx.on('agent/pre-step', async (preparation, next) => {
    const downstream = await next()
    orderRung(preparation.agent, preparation.step + 1)
    if (downstream.kind === 'reject') return downstream
    const step = preparation.step
    if (!thresholds.includes(step)) return downstream
    if (skipSubagents && preparation.agent.session.header.delegationDepth > 0) return downstream
    const text = step === thresholds[0]
      ? `This turn has run ${step} steps. Answer from the evidence you already gathered, or name what is still missing and why it blocks the answer; another pass over the same source will not change the result.`
      : `This turn has run ${step} steps without delivering an answer. Deliver the answer the evidence supports now, and name the remaining unknown in the same reply.`
    const notice = {
      id: `efficiency-${step}-${Date.now().toString(36)}`,
      role: 'user',
      time: Date.now(),
      content: [{ type: 'text', text }],
      source: { kind: NOTICE_KIND, form: 'notice', summary: `turn step ${step}` },
    }
    return { ...downstream, messages: [notice, ...downstream.messages] }
  })
}
