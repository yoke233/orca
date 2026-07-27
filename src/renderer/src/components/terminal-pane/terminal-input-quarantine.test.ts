import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine,
  isTerminalInputQuarantined,
  shouldDropQuarantinedTerminalInput
} from './terminal-input-quarantine'

const TAB = 'tab-1'
const REATTACH_MS = 1_100

beforeEach(() => {
  _resetTerminalInputQuarantineForTests()
})

describe('terminal input quarantine', () => {
  it('passes input through when nothing is armed', () => {
    expect(shouldDropQuarantinedTerminalInput(TAB, 'e', 0)).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('drops the surviving tail of an interrupted line and its Enter', () => {
    armTerminalInputQuarantine(TAB, 0)
    let at = REATTACH_MS
    for (const char of 'cho hi; rm -rf x') {
      expect(shouldDropQuarantinedTerminalInput(TAB, char, at)).toBe(true)
      at += 30
    }
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', at)).toBe(true)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('lets the next command through once the terminator disarmed it', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'x', REATTACH_MS)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS + 30)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'l', REATTACH_MS + 60)).toBe(false)
  })

  it.each([
    ['carriage return', '\r'],
    ['newline', '\n'],
    ['ctrl-c', '\x03']
  ])('treats %s as the line terminator', (_label, terminator) => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, terminator, REATTACH_MS)).toBe(true)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('drops a pasted tail that carries its terminator mid-chunk', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'cho hi; rm -rf x\r', REATTACH_MS)).toBe(true)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('releases on an idle gap once a quarantined byte has been seen', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'c', REATTACH_MS)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'h', REATTACH_MS + 40)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'l', REATTACH_MS + 740)).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('eats a fresh command typed inside the cap, terminator included', () => {
    armTerminalInputQuarantine(TAB, 0)
    let at = 1_500
    for (const char of 'ls -la\r') {
      expect(shouldDropQuarantinedTerminalInput(TAB, char, at)).toBe(true)
      at += 150
    }
  })

  it('does not let the idle gate fire on the re-attach delay itself', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'c', REATTACH_MS)).toBe(true)
  })

  it('releases at the absolute cap so input can never wedge', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'a', 4_999)).toBe(true)
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'a', 5_000)).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('keeps quarantine per tab', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput('tab-2', 'a', REATTACH_MS)).toBe(false)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'a', REATTACH_MS)).toBe(true)
  })

  it('prunes expired entries for tabs that closed mid-quarantine', () => {
    armTerminalInputQuarantine('closed-tab', 0)
    armTerminalInputQuarantine(TAB, 5_000)
    expect(isTerminalInputQuarantined('closed-tab')).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(true)
  })
})
