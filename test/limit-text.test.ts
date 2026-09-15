import { describe, expect, it } from 'vitest'
import { classifyLimitText } from '../src/limits/text'

describe('classifyLimitText: Claude', () => {
  it('names the window the CLI synthetic message names', () => {
    expect(classifyLimitText('claude', "You've hit your session limit · resets 6:20am (America/Chicago)")).toEqual({ window: '5h' })
    expect(classifyLimitText('claude', "You've hit your session limit · resets 6:20am · progress saved")).toEqual({ window: '5h' })
    expect(classifyLimitText('claude', "You've hit your weekly limit · resets Sep 18, 3pm")).toEqual({ window: 'weekly' })
    expect(classifyLimitText('claude', "You've reached your Fable limit. Switch to another model or /upgrade to continue.")).toEqual({
      window: { model: 'Fable' }
    })
    expect(classifyLimitText('claude', "You've reached your opus limit.")).toEqual({ window: { model: 'Opus' } })
  })
  it('credits: usage credits, spend limit, team budget, extra usage', () => {
    for (const text of [
      "You're out of usage credits. Buy more to keep going.",
      "You've hit your monthly spend limit. Raise it in settings.",
      "You've hit your team's shared budget.",
      'Extra usage is not enabled for this organization.'
    ]) {
      expect(classifyLimitText('claude', text)).toEqual({ window: 'credits' })
    }
  })
  it('an API rate_limit_error body without a window is transient; with a window it is that window', () => {
    expect(
      classifyLimitText('claude', '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your per-minute rate limit"}}')
    ).toEqual({ window: 'transient' })
    expect(
      classifyLimitText('claude', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"You have hit your weekly limit"}}')
    ).toEqual({ window: 'weekly' })
    expect(classifyLimitText('claude', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toEqual({
      window: 'transient'
    })
  })
  it('anything else is not a limit', () => {
    expect(classifyLimitText('claude', 'Prompt is too long')).toBeNull()
    expect(classifyLimitText('claude', 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}')).toBeNull()
    expect(classifyLimitText('claude', 'Credit card declined for order 42')).toBeNull()
    expect(classifyLimitText('claude', '')).toBeNull()
  })
})

describe('classifyLimitText: Codex', () => {
  it('usage limit texts charge the 5h window unless the text names the week', () => {
    for (const text of [
      "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at 4:10 PM.",
      "You've hit your usage limit. To get more access now, send a request to your admin or try again at 9pm.",
      "Usage limit reached. You've reached your usage limit. Try again later."
    ]) {
      expect(classifyLimitText('codex', text)).toEqual({ window: '5h' })
    }
    expect(classifyLimitText('codex', "You've hit your usage limit for the week. Try again on Sep 22.")).toEqual({ window: 'weekly' })
    expect(classifyLimitText('codex', "You've hit your usage limit for 5 hours.")).toEqual({ window: '5h' })
  })
  it('credits and quota', () => {
    expect(classifyLimitText('codex', "You're out of credits. Add credits to continue using Codex.")).toEqual({ window: 'credits' })
    expect(classifyLimitText('codex', 'Quota exceeded. Check your plan and billing details.')).toEqual({ window: 'credits' })
  })
  it('raw error bodies classify by code, and rate_limit_exceeded is transient', () => {
    expect(
      classifyLimitText('codex', '{"error":{"type":"usage_limit_reached","message":"You have hit your usage limit.","resets_at":1800000000}}')
    ).toEqual({ window: '5h' })
    expect(classifyLimitText('codex', '{"error":{"code":"usage_not_included","message":"Your plan does not include this."}}')).toEqual({
      window: 'credits'
    })
    expect(classifyLimitText('codex', 'Rate limit reached (rate_limit_exceeded): please try again in 12s.')).toEqual({ window: 'transient' })
  })
  it('anything else is not a limit', () => {
    expect(classifyLimitText('codex', 'stream disconnected before completion')).toBeNull()
    expect(classifyLimitText('codex', 'The model produced a limited response.')).toBeNull()
  })
})
