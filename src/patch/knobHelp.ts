/**
 * What each knob does, read out of the manual.
 *
 * MANUAL.md already has a table for every module -- knob, range, default,
 * what it does -- and the last column is exactly the sentence a hover wants.
 * Reading it from there rather than writing it again beside each knob keeps
 * one copy of it: the manual is checked against the modules (see
 * check-manual), and so the help is too.
 *
 * Keyed by the module's name as the manual heads its section ("Ladder
 * Filter") and the knob's label as its panel prints it ("CV Amt").
 */
export type KnobHelp = ReadonlyMap<string, ReadonlyMap<string, string>>

export function parseKnobHelp(manual: string): KnobHelp {
  const out = new Map<string, Map<string, string>>()
  let module: string | null = null
  let inTable = false
  for (const raw of manual.split('\n')) {
    const line = raw.trim()
    const heading = /^###\s+(.+)$/.exec(line)
    if (heading) {
      module = heading[1].trim()
      inTable = false
      continue
    }
    // A new chapter ends the modules; its tables are about something else.
    if (/^##\s/.test(line)) {
      module = null
      continue
    }
    if (!module || !line.startsWith('|')) {
      inTable = false
      continue
    }
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim())
    if (!inTable) {
      // Only the knob tables: a header of Knob (or Control) ... What it does.
      inTable = (cells[0] === 'Knob' || cells[0] === 'Control') && /what it does/i.test(cells[cells.length - 1] ?? '')
      continue
    }
    if (/^-+$/.test(cells[0].replace(/\s/g, ''))) continue
    const text = plain(cells[cells.length - 1] ?? '')
    if (!text) continue
    if (!out.has(module)) out.set(module, new Map())
    // One row can stand for several knobs: "Gain 1 / Gain 2" names each, and
    // "Rate 1 – 4" is every numbered one, filed under the name without it.
    for (const part of plain(cells[0]).split(' / ')) {
      const label = part.replace(/\s+\d+\s*[–-]\s*\d+$/, '').trim()
      if (label) out.get(module)!.set(label, text)
    }
  }
  return out
}

/** Markdown's emphasis and code marks taken off, leaving the words. */
function plain(text: string) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1').trim()
}

/**
 * The help for one knob. A numbered knob on a module with several of the
 * same -- the sequencer's "CV 3", a mixer's "Lvl 5" -- is described once in
 * the manual under its unnumbered name, and found by that.
 */
export function helpFor(help: KnobHelp, module: string, label: string): string | null {
  const knobs = help.get(module)
  if (!knobs) return null
  return knobs.get(label) ?? knobs.get(label.replace(/\s*\d+$/, '')) ?? null
}
